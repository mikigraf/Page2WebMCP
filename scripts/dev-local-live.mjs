import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const localEnvironment = await readLocalEnvironment();
const controlPlane = start(["--filter", "@page2webmcp/control-plane", "dev", "--", "--port", "3100"], {
  DATABASE_URL: localEnvironment.PAGE2WEBMCP_APP_DATABASE_URL,
  PAGE2WEBMCP_STORAGE_MODE: "postgres",
  PAGE2WEBMCP_PUBLIC_ORIGIN: "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases"
});
const worker = start(["worker"], {
  DATABASE_URL: localEnvironment.PAGE2WEBMCP_WORKER_DATABASE_URL,
  PAGE2WEBMCP_STORAGE_MODE: "postgres",
  PAGE2WEBMCP_PUBLIC_ORIGIN: "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases"
});
const children = [controlPlane, worker];
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(0));
for (const child of children) child.once("exit", (code, signal) => {
  if (!stopping) stop(signal ? 1 : code ?? 1);
});

function start(args, environment) {
  return spawn("pnpm", args, {
    env: { ...process.env, ...environment },
    stdio: "inherit"
  });
}

async function readLocalEnvironment() {
  const text = await readFile(resolve(process.cwd(), ".page2webmcp/local.env"), "utf8");
  const environment = Object.fromEntries(text.split("\n").flatMap((line) => {
    const match = /^(PAGE2WEBMCP_(?:APP|WORKER|MAINTENANCE)_DATABASE_URL)=(postgresql:\/\/[^\s]+)$/.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
  if (!environment.PAGE2WEBMCP_APP_DATABASE_URL || !environment.PAGE2WEBMCP_WORKER_DATABASE_URL) {
    throw new Error("LOCAL_RUNTIME_ENVIRONMENT_REQUIRED");
  }
  return environment;
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 5_000).unref();
}
