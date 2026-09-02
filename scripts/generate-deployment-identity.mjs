import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_GIT_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_GIT_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4_096;
const MAX_DOCKERFILE_BYTES = 64 * 1024;

export async function generateDeploymentIdentityManifest(environment = process.env, dependencies = {}) {
  const gitCommitSha = environment.PAGE2WEBMCP_GIT_COMMIT_SHA ?? "";
  const applicationReleaseId = environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID ?? "";
  const controlPlaneOrigin = environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN ?? "";
  if (!COMMIT.test(gitCommitSha) || !RELEASE_ID.test(applicationReleaseId)
    || !exactHttpsOrigin(controlPlaneOrigin)) {
    throw new Error("DEPLOYMENT_BUILD_CONFIGURATION_REQUIRED");
  }

  const git = dependencies.git ?? runGit;
  const actualCommitBytes = await git(["rev-parse", "--verify", "HEAD"]);
  const actualCommit = exactGitCommit(actualCommitBytes);
  if (actualCommit !== gitCommitSha) throw new Error("DEPLOYMENT_BUILD_COMMIT_MISMATCH");

  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.byteLength > MAX_GIT_TEXT_BYTES || status.byteLength !== 0) {
    throw new Error("DEPLOYMENT_BUILD_TREE_DIRTY");
  }

  const archive = await git(["archive", "--format=tar", "HEAD"]);
  if (archive.byteLength < 1 || archive.byteLength > MAX_GIT_ARCHIVE_BYTES) {
    throw new Error("DEPLOYMENT_BUILD_ARCHIVE_INVALID");
  }
  const sourceTreeSha256 = sha256(archive);
  if (!DIGEST.test(sourceTreeSha256)) throw new Error("DEPLOYMENT_BUILD_ARCHIVE_INVALID");

  const unsigned = {
    schema: "DeploymentIdentityV1",
    gitCommitSha,
    applicationReleaseId,
    controlPlaneOrigin,
    sourceTreeSha256,
  };
  const identity = Object.freeze({ ...unsigned, identityDigest: sha256(Buffer.from(JSON.stringify(unsigned), "utf8")) });
  const bytes = Buffer.from(`${JSON.stringify(identity)}\n`, "utf8");
  const outputPath = resolve(dependencies.outputPath ?? ".dist/deployment-identity.json");
  const sourceArchivePath = resolve(dependencies.sourceArchivePath ?? resolve(dirname(outputPath), "deployment-source.tar"));
  await mkdir(dirname(outputPath), { recursive: true });
  if (dirname(sourceArchivePath) !== dirname(outputPath)) await mkdir(dirname(sourceArchivePath), { recursive: true });
  await writeExactImmutableFile(sourceArchivePath, archive, "DEPLOYMENT_BUILD_SOURCE_ARCHIVE_CONFLICT");
  await writeExactImmutableFile(outputPath, bytes, "DEPLOYMENT_BUILD_MANIFEST_CONFLICT");
  return identity;
}

export async function verifyDeploymentBuildContext(environment = process.env, dependencies = {}) {
  validateProductionBaseImage(environment.NODE_BASE_IMAGE);
  const manifestPath = resolve(dependencies.manifestPath ?? ".dist/deployment-identity.json");
  const sourceArchivePath = resolve(dependencies.sourceArchivePath ?? "/tmp/page2webmcp-deployment-source.tar");
  const contextDockerfilePath = resolve(
    dependencies.contextDockerfilePath ?? "/tmp/page2webmcp-context.Dockerfile",
  );
  const committedDockerfile = dependencies.committedDockerfilePath
    ?? environment.PAGE2WEBMCP_DEPLOYMENT_DOCKERFILE;
  if (committedDockerfile !== "deploy/Dockerfile.control-plane"
    && committedDockerfile !== "deploy/Dockerfile.worker"
    && committedDockerfile !== "deploy/Dockerfile.release-verifier"
    && dependencies.committedDockerfilePath === undefined) {
    throw new Error("DEPLOYMENT_BUILD_DOCKERFILE_REQUIRED");
  }
  const committedDockerfilePath = resolve(committedDockerfile ?? "");
  const [manifestBytes, archive, contextDockerfile, exactDockerfile] = await Promise.all([
    boundedRead(manifestPath, MAX_MANIFEST_BYTES, "DEPLOYMENT_BUILD_MANIFEST_INVALID"),
    boundedRead(sourceArchivePath, MAX_GIT_ARCHIVE_BYTES, "DEPLOYMENT_BUILD_ARCHIVE_INVALID"),
    boundedRead(contextDockerfilePath, MAX_DOCKERFILE_BYTES, "DEPLOYMENT_BUILD_DOCKERFILE_INVALID"),
    boundedRead(committedDockerfilePath, MAX_DOCKERFILE_BYTES, "DEPLOYMENT_BUILD_DOCKERFILE_INVALID"),
  ]);
  const identity = parseDeploymentIdentity(manifestBytes);
  if (identity.gitCommitSha !== environment.PAGE2WEBMCP_GIT_COMMIT_SHA
    || identity.applicationReleaseId !== environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID
    || identity.controlPlaneOrigin !== environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN) {
    throw new Error("DEPLOYMENT_IDENTITY_MISMATCH");
  }
  if (sha256(archive) !== identity.sourceTreeSha256) {
    throw new Error("DEPLOYMENT_BUILD_ARCHIVE_MISMATCH");
  }
  if (!contextDockerfile.equals(exactDockerfile)) {
    throw new Error("DEPLOYMENT_BUILD_DOCKERFILE_MISMATCH");
  }
  return identity;
}

export function validateProductionBaseImage(value) {
  if (typeof value !== "string" || value.length < 73 || value.length > 512 || value.trim() !== value) {
    throw new Error("DEPLOYMENT_BASE_IMAGE_DIGEST_REQUIRED");
  }
  const match = /^([^@\s]+)@sha256:([0-9a-f]{64})$/.exec(value);
  const finalComponent = match?.[1].split("/").at(-1);
  if (!match || !/^[a-z0-9][A-Za-z0-9._:/-]*$/.test(match[1]) || match[1].includes("://")
    || finalComponent !== "node:24") {
    throw new Error("DEPLOYMENT_BASE_IMAGE_DIGEST_REQUIRED");
  }
  return value;
}

async function writeExactImmutableFile(path, bytes, conflictCode) {
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o444 });
    await chmod(path, 0o444);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await readFile(path);
    const existingMode = (await stat(path)).mode & 0o777;
    if (!existing.equals(bytes) || existingMode !== 0o444) throw new Error(conflictCode);
  }
}

async function boundedRead(path, maximumBytes, code) {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error(code);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error(code); }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) throw new Error(code);
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size) throw new Error(code);
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseDeploymentIdentity(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0")
      !== "applicationReleaseId\0controlPlaneOrigin\0gitCommitSha\0identityDigest\0schema\0sourceTreeSha256"
    || value.schema !== "DeploymentIdentityV1" || !COMMIT.test(value.gitCommitSha)
    || !RELEASE_ID.test(value.applicationReleaseId) || !exactHttpsOrigin(value.controlPlaneOrigin)
    || !DIGEST.test(value.sourceTreeSha256) || !DIGEST.test(value.identityDigest)) {
    throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID");
  }
  const unsigned = {
    schema: value.schema,
    gitCommitSha: value.gitCommitSha,
    applicationReleaseId: value.applicationReleaseId,
    controlPlaneOrigin: value.controlPlaneOrigin,
    sourceTreeSha256: value.sourceTreeSha256,
  };
  if (sha256(Buffer.from(JSON.stringify(unsigned), "utf8")) !== value.identityDigest) {
    throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID");
  }
  return Object.freeze(value);
}

async function runGit(args) {
  const maximumBytes = args[0] === "archive" ? MAX_GIT_ARCHIVE_BYTES : MAX_GIT_TEXT_BYTES;
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("DEPLOYMENT_BUILD_GIT_TIMEOUT"));
    }, 30_000);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumBytes) {
        child.kill("SIGKILL");
        finish(new Error("DEPLOYMENT_BUILD_GIT_OUTPUT_TOO_LARGE"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_GIT_TEXT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("DEPLOYMENT_BUILD_GIT_OUTPUT_TOO_LARGE"));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", () => finish(new Error("DEPLOYMENT_BUILD_GIT_FAILED")));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error("DEPLOYMENT_BUILD_GIT_FAILED"));
        return;
      }
      finish(undefined, Buffer.concat(stdout));
    });
  });
}

function exactGitCommit(value) {
  if (!Buffer.isBuffer(value) || value.byteLength > 64) throw new Error("DEPLOYMENT_BUILD_GIT_FAILED");
  const text = value.toString("utf8");
  const match = /^([0-9a-f]{40})\n?$/.exec(text);
  if (!match) throw new Error("DEPLOYMENT_BUILD_GIT_FAILED");
  return match[1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactHttpsOrigin(value) {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.pathname === "/"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isAlreadyExists(error) {
  return error && typeof error === "object" && error.code === "EEXIST";
}

async function main() {
  try {
    const identity = process.argv[2] === "--verify-build-context"
      ? await verifyDeploymentBuildContext(process.env)
      : process.argv.length === 2
        ? await generateDeploymentIdentityManifest(process.env)
        : (() => { throw new Error("DEPLOYMENT_BUILD_ARGUMENTS_INVALID"); })();
    process.stdout.write(`${JSON.stringify({
      schema: identity.schema,
      gitCommitSha: identity.gitCommitSha,
      applicationReleaseId: identity.applicationReleaseId,
      sourceTreeSha256: identity.sourceTreeSha256,
      identityDigest: identity.identityDigest,
    })}\n`);
  } catch (error) {
    const code = error instanceof Error && /^DEPLOYMENT_BUILD_[A-Z_]+$/.test(error.message)
      ? error.message
      : "DEPLOYMENT_BUILD_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
