import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapLocalRuntimeRoles, validateOwnerDatabaseUrl } from "./local-runtime-roles.mjs";

const REQUIRED_MIGRATION = "20260901064232";
const PINNED_SUPABASE_VERSION = "2.116.0";
const MAX_COMMAND_OUTPUT_BYTES = 65_536;
const commands = {
  up: ["start"],
  reset: ["db", "reset", "--local"],
  status: ["status", "-o", "env"],
  down: ["stop"]
};

async function main() {
  const command = process.argv[2];
  if (!Object.hasOwn(commands, command) || process.argv.length !== 3) throw new Error("LOCAL_SUPABASE_COMMAND_REQUIRED");
  const ledger = await migrationLedger();
  if (command !== "down") printLedger(ledger);
  await verifySupabaseVersion();
  const output = await runSupabase(commands[command]);
  if (command === "up" || command === "reset") {
    const status = parseLocalStatus((await runSupabase(["status", "-o", "env"])).stdout);
    await bootstrapLocalRuntimeRoles(status.ownerDatabaseUrl, undefined, undefined, {
      localStatus: {
        apiUrl: status.apiUrl,
        publishableKey: status.publishableKey,
        serviceKey: status.serviceKey
      },
      expectedMigrationVersions: ledger.map((file) => file.slice(0, 14))
    });
    console.log("Local Supabase is ready; runtime roles refreshed.");
    return;
  }
  if (command === "status") printSafeStatus(parseLocalStatus(output.stdout));
  if (command === "down") console.log("Local Supabase stopped.");
}

async function migrationLedger() {
  const files = (await readdir(resolve(process.cwd(), "supabase/migrations")))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (!files.some((file) => file.startsWith(`${REQUIRED_MIGRATION}_`))) throw new Error("LOCAL_MIGRATION_LEDGER_INCOMPLETE");
  if (new Set(files.map((file) => file.slice(0, 14))).size !== files.length) throw new Error("LOCAL_MIGRATION_LEDGER_AMBIGUOUS");
  return files;
}

function printLedger(ledger) {
  console.log(`Migration ledger (${ledger.length}):`);
  for (const migration of ledger) console.log(migration);
}

function runSupabase(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", ["exec", "supabase", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const append = (stream, chunk) => {
      if (exceeded) return stream;
      const next = stream + chunk;
      if (Buffer.byteLength(next, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        exceeded = true;
        child.kill("SIGTERM");
        return stream;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (exceeded) return reject(new Error("LOCAL_SUPABASE_COMMAND_FAILED"));
      if (code === 0) return resolvePromise({ stdout, stderr });
      reject(new Error("LOCAL_SUPABASE_COMMAND_FAILED"));
    });
  });
}

async function verifySupabaseVersion() {
  const result = await runSupabase(["--version"]);
  if (result.stdout.trim() !== PINNED_SUPABASE_VERSION) throw new Error("LOCAL_SUPABASE_VERSION_MISMATCH");
}

function parseLocalStatus(output) {
  const values = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([A-Z][A-Z0-9_]*)=("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!match) throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
    if (values.has(match[1])) throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
    let value;
    try {
      value = JSON.parse(match[2]);
    } catch {
      throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
    }
    if (typeof value !== "string" || value.length > 4_096 || /[\r\n]/.test(value)) {
      throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
    }
    values.set(match[1], value);
  }
  const apiUrl = values.get("API_URL");
  const ownerDatabaseUrl = values.get("DB_URL");
  const publishableKey = values.get("PUBLISHABLE_KEY") ?? values.get("ANON_KEY");
  const serviceKey = values.get("SECRET_KEY") ?? values.get("SERVICE_ROLE_KEY");
  if (apiUrl !== "http://127.0.0.1:58321"
    || typeof ownerDatabaseUrl !== "string"
    || typeof publishableKey !== "string"
    || typeof serviceKey !== "string") {
    throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  }
  validateOwnerDatabaseUrl(ownerDatabaseUrl);
  return {
    apiUrl,
    ownerDatabaseUrl,
    publishableKey,
    serviceKey,
    studioUrl: safeLoopbackServiceUrl(values.get("STUDIO_URL"), "58323"),
    inbucketUrl: safeLoopbackServiceUrl(values.get("INBUCKET_URL"), "58324")
  };
}

function safeLoopbackServiceUrl(value, port) {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== port
      || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
    }
    return url.origin;
  } catch (error) {
    if (error instanceof Error && error.message === "LOCAL_SUPABASE_STATUS_INVALID") throw error;
    throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  }
}

function printSafeStatus(status) {
  console.log(`API_URL: ${status.apiUrl}`);
  if (status.studioUrl) console.log(`STUDIO_URL: ${status.studioUrl}`);
  if (status.inbucketUrl) console.log(`INBUCKET_URL: ${status.inbucketUrl}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "LOCAL_SUPABASE_FAILED"}\n`);
  process.exitCode = 2;
});
