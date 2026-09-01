import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);

async function migration() {
  const matches = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{14}_website_authentication_cleanup_attempt_budget\.sql$/.test(name));
  assert.equal(matches.length, 1, "one CLI-generated cleanup attempt budget migration must exist");
  return {
    name: matches[0]!,
    sql: await readFile(new URL(matches[0]!, migrationsDirectory), "utf8"),
  };
}

test("authentication cleanup budget migration persists an exhausted diagnostic state", async () => {
  const { sql } = await migration();
  assert.match(sql, /drop constraint website_authentication_checkpoints_cleanup_status_check/i);
  assert.match(sql, /cleanup_status[\s\S]*'failed'/i);
  assert.match(sql, /cleanup_attempts[\s\S]*(?:<=|<)\s*3/i);
  assert.doesNotMatch(sql, /\b(cookie|credential|bearer|password|otp|cdp_url|live_url|provider_session_id)\b/i);
});

test("authentication cleanup budget migration remains in the forward readiness ledger", async () => {
  const { name, sql } = await migration();
  const version = name.slice(0, 14);
  assert.match(sql, /selected_release_readiness_topology_legacy_20260901090842/i);
  assert.match(sql, new RegExp(`\\('${version}'\\)`));
  const readiness = await readFile(new URL("../../../scripts/check-release-readiness.ts", import.meta.url), "utf8");
  const lifecycle = await readFile(new URL("../../../scripts/local-supabase.mjs", import.meta.url), "utf8");
  assert.match(readiness, new RegExp(name.replaceAll(".", "\\.")));
  const latest = lifecycle.match(/REQUIRED_MIGRATION = "(\d{14})"/)?.[1];
  assert.ok(latest);
  assert.ok(latest >= version);
});
