import { spawn } from "node:child_process";

const children = [
  start("acme-support", 3200, process.env),
  start("control-plane", 3100, {
    ...process.env,
    PAGE2WEBMCP_SESSION_SECRET: process.env.PAGE2WEBMCP_SESSION_SECRET
      ?? "page2webmcp-local-dev-session-secret-2026",
    PAGE2WEBMCP_STORAGE_MODE: process.env.PAGE2WEBMCP_STORAGE_MODE ?? "memory"
  })
];

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => stop(0));
}
for (const child of children) {
  child.once("exit", (code, signal) => {
    if (!stopping) stop(signal ? 1 : code ?? 1);
  });
}

function start(workspace, port, env) {
  return spawn(
    "pnpm",
    ["--filter", `@page2webmcp/${workspace}`, "dev", "--", "--port", String(port)],
    { env, stdio: "inherit" }
  );
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 5_000).unref();
}
