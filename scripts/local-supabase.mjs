import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapLocalRuntimeRoles, validateOwnerDatabaseUrl } from "./local-runtime-roles.mjs";

const REQUIRED_MIGRATION = "20260830190000";
const commands = {
  up: ["start"],
  reset: ["db", "reset"],
  status: ["status", "-o", "json"],
  down: ["stop"]
};

async function main() {
  const command = process.argv[2];
  if (!Object.hasOwn(commands, command) || process.argv.length !== 3) throw new Error("LOCAL_SUPABASE_COMMAND_REQUIRED");
  const ledger = await migrationLedger();
  if (command !== "down") printLedger(ledger);
  const output = await runSupabase(commands[command]);
  if (command === "up" || command === "reset") {
    const status = await runSupabase(["status", "-o", "json"]);
    const ownerDatabaseUrl = ownerDatabaseUrlFromStatus(status.stdout);
    await bootstrapLocalRuntimeRoles(ownerDatabaseUrl);
    console.log("Local Supabase is ready; runtime roles refreshed.");
    return;
  }
  if (command === "status") printSafeStatus(output.stdout);
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
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) return resolvePromise({ stdout, stderr });
      reject(new Error("LOCAL_SUPABASE_COMMAND_FAILED"));
    });
  });
}

function ownerDatabaseUrlFromStatus(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  const candidate = parsed.DB_URL ?? parsed["DB URL"];
  if (typeof candidate !== "string") throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  return validateOwnerDatabaseUrl(candidate).toString();
}

function printSafeStatus(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  for (const key of ["API URL", "API_URL", "Studio URL", "STUDIO_URL"]) {
    if (typeof parsed[key] === "string") console.log(`${key}: ${parsed[key]}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "LOCAL_SUPABASE_FAILED"}\n`);
  process.exitCode = 2;
});
