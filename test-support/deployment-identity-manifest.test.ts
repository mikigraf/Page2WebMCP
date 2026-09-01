import assert from "node:assert/strict";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
// @ts-expect-error JavaScript build script has no declaration file.
import * as deploymentBuild from "../scripts/generate-deployment-identity.mjs";

const generateDeploymentIdentityManifest = deploymentBuild.generateDeploymentIdentityManifest;

const environment = {
  PAGE2WEBMCP_GIT_COMMIT_SHA: "c".repeat(40),
  PAGE2WEBMCP_APPLICATION_RELEASE_ID: "release_20260901_1",
  PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.page2webmcp.example",
};

test("production build manifest binds runtime controls to actual clean Git commit and archive bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-deployment-identity-"));
  const outputPath = join(directory, ".dist", "deployment-identity.json");
  const sourceArchivePath = join(directory, ".dist", "deployment-source.tar");
  const sourceArchive = Buffer.from("exact committed source tree archive");
  const calls: readonly string[][] = [] as string[][];
  const identity = await generateDeploymentIdentityManifest(environment, {
    outputPath,
    sourceArchivePath,
    git: async (args: readonly string[]) => {
      (calls as string[][]).push([...args]);
      if (args[0] === "rev-parse") return Buffer.from(`${"c".repeat(40)}\n`);
      if (args[0] === "status") return Buffer.alloc(0);
      if (args[0] === "archive") return sourceArchive;
      throw new Error("unexpected git call");
    },
  });
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=all"],
    ["archive", "--format=tar", "HEAD"],
  ]);
  assert.equal(identity.gitCommitSha, environment.PAGE2WEBMCP_GIT_COMMIT_SHA);
  assert.equal(identity.applicationReleaseId, environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID);
  assert.equal(identity.sourceTreeSha256, "128e2a2193a98812566dda411540b77739cbcb63989c223a2784267ba8de5f07");
  assert.match(identity.identityDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), identity);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o444);
  assert.deepEqual(await readFile(sourceArchivePath), sourceArchive);
  assert.equal((await stat(sourceArchivePath)).mode & 0o777, 0o444);
});

test("production build manifest rejects dirty trees, env/HEAD drift, malformed release IDs, and conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-deployment-identity-"));
  const outputPath = join(directory, ".dist", "deployment-identity.json");
  const sourceArchivePath = join(directory, ".dist", "deployment-source.tar");
  const dependencies = {
    outputPath,
    sourceArchivePath,
    git: async (args: readonly string[]) => args[0] === "archive"
      ? Buffer.from("tree")
      : Buffer.from(args[0] === "status" ? "" : `${"c".repeat(40)}\n`),
  };
  await generateDeploymentIdentityManifest(environment, dependencies);
  await assert.rejects(
    generateDeploymentIdentityManifest({ ...environment, PAGE2WEBMCP_APPLICATION_RELEASE_ID: "different" }, dependencies),
    /DEPLOYMENT_BUILD_MANIFEST_CONFLICT/,
  );
  await assert.rejects(
    generateDeploymentIdentityManifest({ ...environment, PAGE2WEBMCP_APPLICATION_RELEASE_ID: "bad.release" }, {
      ...dependencies, outputPath: join(directory, "bad-id.json"),
    }),
    /DEPLOYMENT_BUILD_CONFIGURATION_REQUIRED/,
  );
  await assert.rejects(
    generateDeploymentIdentityManifest({ ...environment, PAGE2WEBMCP_GIT_COMMIT_SHA: "d".repeat(40) }, {
      ...dependencies, outputPath: join(directory, "bad-commit.json"),
    }),
    /DEPLOYMENT_BUILD_COMMIT_MISMATCH/,
  );
  await assert.rejects(
    generateDeploymentIdentityManifest(environment, {
      ...dependencies,
      outputPath: join(directory, "dirty.json"),
      git: async (args: readonly string[]) => args[0] === "status"
        ? Buffer.from(" M apps/control-plane/src/config.ts\n")
        : args[0] === "archive" ? Buffer.from("tree") : Buffer.from(`${"c".repeat(40)}\n`),
    }),
    /DEPLOYMENT_BUILD_TREE_DIRTY/,
  );
  await chmod(sourceArchivePath, 0o644);
  await writeFile(sourceArchivePath, "different archive bytes");
  await assert.rejects(
    generateDeploymentIdentityManifest(environment, dependencies),
    /DEPLOYMENT_BUILD_SOURCE_ARCHIVE_CONFLICT/,
  );
});

test("production image inputs accept only an immutable sha256 base and the exact manifest-bound source archive", async () => {
  assert.equal(typeof deploymentBuild.verifyDeploymentBuildContext, "function");
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-deployment-context-"));
  const outputPath = join(directory, "deployment-identity.json");
  const sourceArchivePath = join(directory, "deployment-source.tar");
  const contextDockerfilePath = join(directory, "context.Dockerfile");
  const committedDockerfilePath = join(directory, "committed.Dockerfile");
  const sourceArchive = Buffer.from("committed archive bytes");
  const dockerfile = "FROM exact-base\n";
  const git = async (args: readonly string[]) => args[0] === "archive"
    ? sourceArchive
    : Buffer.from(args[0] === "status" ? "" : `${"c".repeat(40)}\n`);
  const identity = await generateDeploymentIdentityManifest(environment, {
    outputPath, sourceArchivePath, git,
  });
  await Promise.all([
    writeFile(contextDockerfilePath, dockerfile),
    writeFile(committedDockerfilePath, dockerfile),
  ]);
  const baseImage = `registry.example/node:24@sha256:${"1".repeat(64)}`;
  assert.deepEqual(await deploymentBuild.verifyDeploymentBuildContext({
    ...environment,
    NODE_BASE_IMAGE: baseImage,
  }, {
    manifestPath: outputPath,
    sourceArchivePath,
    contextDockerfilePath,
    committedDockerfilePath,
  }), identity);

  for (const invalid of [
    "node:24", `node:24@sha256:${"A".repeat(64)}`, `node:24@sha512:${"1".repeat(64)}`,
    `node:24@sha256:${"1".repeat(63)}`, `node:24@sha256:${"1".repeat(64)} extra`,
    `ubuntu:24.04@sha256:${"1".repeat(64)}`, `node:22@sha256:${"1".repeat(64)}`,
    `node:25@sha256:${"1".repeat(64)}`,
  ]) {
    await assert.rejects(deploymentBuild.verifyDeploymentBuildContext({
      ...environment,
      NODE_BASE_IMAGE: invalid,
    }, {
      manifestPath: outputPath,
      sourceArchivePath,
      contextDockerfilePath,
      committedDockerfilePath,
    }), /DEPLOYMENT_BASE_IMAGE_DIGEST_REQUIRED/);
  }

  await writeFile(contextDockerfilePath, "FROM stale-context\n");
  await assert.rejects(deploymentBuild.verifyDeploymentBuildContext({
    ...environment,
    NODE_BASE_IMAGE: baseImage,
  }, {
    manifestPath: outputPath,
    sourceArchivePath,
    contextDockerfilePath,
    committedDockerfilePath,
  }), /DEPLOYMENT_BUILD_DOCKERFILE_MISMATCH/);

  const archiveSymlink = join(directory, "deployment-source-link.tar");
  await symlink(sourceArchivePath, archiveSymlink);
  await assert.rejects(deploymentBuild.verifyDeploymentBuildContext({
    ...environment,
    NODE_BASE_IMAGE: baseImage,
  }, {
    manifestPath: outputPath,
    sourceArchivePath: archiveSymlink,
    contextDockerfilePath: committedDockerfilePath,
    committedDockerfilePath,
  }), /DEPLOYMENT_BUILD_ARCHIVE_INVALID/);
});
