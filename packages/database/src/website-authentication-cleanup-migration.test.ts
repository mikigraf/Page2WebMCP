import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);

async function migration() {
  const matches = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{14}_website_authentication_cleanup_lease\.sql$/.test(name));
  assert.equal(matches.length, 1, "one CLI-generated authentication cleanup migration must exist");
  return {
    name: matches[0]!,
    sql: await readFile(new URL(matches[0]!, migrationsDirectory), "utf8"),
  };
}

test("authentication cleanup migration adds a private terminal lease without secret material", async () => {
  const { sql } = await migration();
  for (const column of [
    "cleanup_status", "cleanup_idempotency_key", "cleanup_attempts", "cleanup_available_at",
    "cleanup_lease_owner", "cleanup_lease_expires_at", "cleanup_lease_generation",
    "cleanup_completed_at", "cleanup_last_error_code",
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, "i"));
  assert.match(sql, /cleanup_status[\s\S]*'pending'[\s\S]*'running'[\s\S]*'succeeded'/i);
  assert.match(sql, /state[\s\S]*'failed'[\s\S]*'cancelled'[\s\S]*'expired'[\s\S]*cleanup_status/i);
  assert.match(sql, /website_authentication_cleanup_claim_idx/i);
  assert.match(sql, /queue_website_authentication_checkpoint_cleanup/i);
  assert.match(sql, /website-auth-cleanup:/i);
  assert.doesNotMatch(sql, /\b(cookie|credential|bearer|password|otp|cdp_url|live_url|provider_session_id)\b/i);
});

test("authentication cleanup lease remains worker-only and advances readiness", async () => {
  const { name, sql } = await migration();
  const version = name.slice(0, 14);
  assert.match(sql, /grant update[\s\S]*cleanup_status[\s\S]*page2webmcp_worker/i);
  const cleanupGrants = [...sql.matchAll(/grant[^;]*cleanup_(?:status|lease_owner|completed_at)[^;]*;/gi)]
    .map((match) => match[0]);
  assert.ok(cleanupGrants.length > 0);
  for (const grant of cleanupGrants) {
    assert.doesNotMatch(grant, /\b(?:anon|authenticated|service_role|page2webmcp_app|page2webmcp_maintenance)\b/i);
  }
  assert.match(sql, /selected_release_readiness_topology_legacy_20260901071658/i);
  assert.match(sql, new RegExp(`\\('${version}'\\)`));
  const readiness = await readFile(new URL("../../../scripts/check-release-readiness.ts", import.meta.url), "utf8");
  assert.match(readiness, new RegExp(name.replaceAll(".", "\\.")));
});
