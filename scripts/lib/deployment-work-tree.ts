import { spawn } from "node:child_process";

const COMMIT = /^([0-9a-f]{40})\n?$/;
const MAX_GIT_TEXT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export type DeploymentWorkTreeInspection = Readonly<{ commit: string; dirty: boolean }>;
export type GitCommand = (args: readonly string[]) => Promise<Buffer>;

// Mirrors scripts/generate-deployment-identity.mjs: the deployed commit must be
// the exact HEAD of a clean tree, untracked files included.
export async function inspectDeploymentWorkTree(
  git: GitCommand = runGit,
): Promise<DeploymentWorkTreeInspection> {
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  const match = COMMIT.exec(head.toString("utf8"));
  if (!match) throw new Error("DEPLOYMENT_BUILD_GIT_FAILED");
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.byteLength > MAX_GIT_TEXT_BYTES) throw new Error("DEPLOYMENT_BUILD_GIT_OUTPUT_TOO_LARGE");
  return Object.freeze({ commit: match[1]!, dirty: status.byteLength !== 0 });
}

function runGit(args: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value!);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("DEPLOYMENT_BUILD_GIT_TIMEOUT"));
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_GIT_TEXT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("DEPLOYMENT_BUILD_GIT_OUTPUT_TOO_LARGE"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", () => { /* diagnostics stay out of operator output */ });
    child.once("error", () => finish(new Error("DEPLOYMENT_BUILD_GIT_FAILED")));
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error("DEPLOYMENT_BUILD_GIT_FAILED"));
      finish(undefined, Buffer.concat(stdout));
    });
  });
}
