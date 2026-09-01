import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const LOCAL_API_ORIGIN = "http://127.0.0.1:58321";
const LOCAL_CONTROL_ORIGIN = "http://127.0.0.1:3100";
const LOCAL_ARTIFACT_ORIGIN = `${LOCAL_API_ORIGIN}/storage/v1/object/public/page2webmcp-releases`;
const LOCAL_ENVIRONMENT_PATH = ".page2webmcp/local.env";
const REQUIRED_KEYS = [
  "PAGE2WEBMCP_APP_DATABASE_URL",
  "PAGE2WEBMCP_WORKER_DATABASE_URL",
  "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "PAGE2WEBMCP_SUPABASE_URL",
  "PAGE2WEBMCP_SUPABASE_SECRET_KEY",
  "PAGE2WEBMCP_SESSION_SECRET"
];
const SENSITIVE_PARENT_KEYS = new Set([
  "DATABASE_URL",
  "DB_URL",
  "SUPABASE_DB_URL",
  "PAGE2WEBMCP_OWNER_DATABASE_URL",
  ...REQUIRED_KEYS,
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "PAGE2WEBMCP_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY"
]);

async function main() {
  const providerMode = process.env.PAGE2WEBMCP_PROVIDER_MODE;
  if (!providerMode || !["openapi", "website", "github"].includes(providerMode)) {
    throw new Error("LOCAL_LIVE_PROVIDER_MODE_REQUIRED");
  }
  const localEnvironment = await readLocalEnvironment();
  const inherited = sanitizedParentEnvironment(process.env);
  const common = {
    ...inherited,
    PAGE2WEBMCP_LOCAL_STACK: "true",
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_PROVIDER_MODE: providerMode,
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: LOCAL_CONTROL_ORIGIN,
    PAGE2WEBMCP_PUBLIC_ORIGIN: LOCAL_ARTIFACT_ORIGIN
  };
  const children = [
    start(["--filter", "@page2webmcp/control-plane", "dev", "--", "--port", "3100"], {
      ...common,
      DATABASE_URL: localEnvironment.PAGE2WEBMCP_APP_DATABASE_URL,
      NEXT_PUBLIC_SUPABASE_URL: localEnvironment.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: localEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      PAGE2WEBMCP_SUPABASE_URL: localEnvironment.PAGE2WEBMCP_SUPABASE_URL,
      PAGE2WEBMCP_SUPABASE_SECRET_KEY: localEnvironment.PAGE2WEBMCP_SUPABASE_SECRET_KEY,
      PAGE2WEBMCP_SESSION_SECRET: localEnvironment.PAGE2WEBMCP_SESSION_SECRET
    }),
    start(["exec", "tsx", "apps/worker/src/main.ts"], {
      ...common,
      DATABASE_URL: localEnvironment.PAGE2WEBMCP_WORKER_DATABASE_URL
    })
  ];
  await supervise(children);
}

function sanitizedParentEnvironment(environment) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (SENSITIVE_PARENT_KEYS.has(name)
      || name.startsWith("NEXT_PUBLIC_PAGE2WEBMCP_SUPABASE_")
      || /^NEXT_PUBLIC_SUPABASE_(?:SECRET|SERVICE)/.test(name)) delete sanitized[name];
  }
  return sanitized;
}

function start(args, environment) {
  return spawn("pnpm", args, {
    env: environment,
    stdio: "inherit",
    detached: process.platform !== "win32"
  });
}

async function supervise(children) {
  let stopping = false;
  let requestedCode = 0;
  let finish;
  const finished = new Promise((resolvePromise) => { finish = resolvePromise; });
  const signals = new Map([
    ["SIGINT", () => requestStop(130)],
    ["SIGTERM", () => requestStop(143)]
  ]);
  for (const [signal, listener] of signals) process.once(signal, listener);
  for (const child of children) {
    child.once("error", () => requestStop(1));
    child.once("exit", (code, signal) => {
      if (!stopping) requestStop(signal ? 1 : code === 0 ? 1 : code ?? 1);
    });
  }
  await finished;
  for (const [signal, listener] of signals) process.removeListener(signal, listener);
  if (requestedCode !== 0) process.exitCode = requestedCode;

  function requestStop(code) {
    if (stopping) return;
    stopping = true;
    requestedCode = code;
    for (const child of children) terminateOwnedChild(child, "SIGTERM");
    const pending = children.filter((child) => child.exitCode === null && child.signalCode === null);
    if (pending.length === 0) return finish();
    const timer = setTimeout(() => {
      for (const child of pending) terminateOwnedChild(child, "SIGKILL");
      finish();
    }, 5_000);
    timer.unref();
    Promise.allSettled(pending.map((child) => new Promise((resolvePromise) => {
      child.once("exit", resolvePromise);
    }))).then(() => {
      clearTimeout(timer);
      finish();
    });
  }
}

function terminateOwnedChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function readLocalEnvironment(path = resolve(process.cwd(), LOCAL_ENVIRONMENT_PATH)) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error("LOCAL_RUNTIME_ENVIRONMENT_REQUIRED");
  }
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size < 1 || metadata.size > 16_384) {
    throw new Error("LOCAL_RUNTIME_ENVIRONMENT_PERMISSIONS_REQUIRED");
  }
  const text = await readFile(path, "utf8");
  const environment = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("=");
    const name = separator > 0 ? line.slice(0, separator) : "";
    const value = separator > 0 ? line.slice(separator + 1) : "";
    if (!REQUIRED_KEYS.includes(name) || Object.hasOwn(environment, name)
      || !value || value.length > 4_096 || /[\r\n\s]/.test(value)) {
      throw new Error("LOCAL_RUNTIME_ENVIRONMENT_REQUIRED");
    }
    environment[name] = value;
  }
  if (REQUIRED_KEYS.some((name) => !Object.hasOwn(environment, name))) {
    throw new Error("LOCAL_RUNTIME_ENVIRONMENT_REQUIRED");
  }
  validateRuntimeDatabaseUrl(environment.PAGE2WEBMCP_APP_DATABASE_URL, "page2webmcp_app_local", "page2webmcp_app");
  validateRuntimeDatabaseUrl(environment.PAGE2WEBMCP_WORKER_DATABASE_URL, "page2webmcp_worker_local", "page2webmcp_worker");
  validateRuntimeDatabaseUrl(
    environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL,
    "page2webmcp_maintenance_local",
    "page2webmcp_maintenance"
  );
  if (environment.NEXT_PUBLIC_SUPABASE_URL !== LOCAL_API_ORIGIN
    || environment.PAGE2WEBMCP_SUPABASE_URL !== LOCAL_API_ORIGIN
    || !safeBrowserKey(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    || !boundedSecret(environment.PAGE2WEBMCP_SUPABASE_SECRET_KEY)
    || !boundedSecret(environment.PAGE2WEBMCP_SESSION_SECRET)) {
    throw new Error("LOCAL_RUNTIME_ENVIRONMENT_REQUIRED");
  }
  return environment;
}

function validateRuntimeDatabaseUrl(value, expectedLogin, expectedRole) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LOCAL_RUNTIME_ENVIRONMENT_REQUIRED");
  }
  if (url.protocol !== "postgresql:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.port !== "58322" || url.pathname !== "/postgres" || url.username !== expectedLogin
    || !url.password || url.hash || url.searchParams.size !== 1
    || url.searchParams.get("options") !== `-c role=${expectedRole}`) {
    throw new Error("LOCAL_RUNTIME_ENVIRONMENT_REQUIRED");
  }
}

function safeBrowserKey(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 4_096
    || /service[_-]?role|sb_secret_/i.test(value)) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return true;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) && claims.role === "anon";
  } catch {
    return false;
  }
}

function boundedSecret(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && value.trim() === value && !/[\r\n]/.test(value);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
    ? error.message
    : "LOCAL_LIVE_LAUNCH_FAILED"}\n`);
  process.exitCode = 2;
});
