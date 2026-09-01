import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../../../supabase/migrations/20260901130000_production_live_receipt_evidence.sql",
  import.meta.url,
);

test("production receipt context is exact-hash, v2-bound, secret-free, and maintenance-only", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /create function private\.selected_production_live_receipt_evidence\(selected_hash text\)/i);
  assert.match(sql, /private\.selected_native_installation_proof\(selected_hash\)/i);
  assert.match(sql, /proof\.candidate_protocol_version\s*=\s*2/i);
  assert.match(sql, /proof\.installation_protocol_version\s*=\s*2/i);
  assert.match(sql, /proof\.candidate_attestation_id\s*<>\s*proof\.installation_attestation_id/i);
  assert.match(sql, /release\.content_hash\s*=\s*selected_hash/i);
  assert.match(sql, /release\.artifact_url\s*=\s*'https:\/\/bimqgiedckdurqiywctl\.supabase\.co\/storage\/v1\/object\/public\/page2webmcp-releases\/'/i);
  assert.match(sql, /supabase_migrations\.schema_migrations/i);
  assert.match(sql, /grant execute[^;]*selected_production_live_receipt_evidence[^;]*page2webmcp_maintenance/i);
  assert.match(sql, /revoke all[^;]*selected_production_live_receipt_evidence[^;]*service_role/i);
  const signature = /selected_production_live_receipt_evidence\(selected_hash text\)\s*returns table\s*\(([\s\S]*?)\)\s*language/i.exec(sql)?.[1];
  assert.ok(signature);
  assert.doesNotMatch(signature, /\b(?:organization_id|project_id|actor_id|source_url|page_url|release_code|token|secret|cookie)\s+/i);
});

test("receipt migration advances the exact readiness ledger and preserves fail-closed RLS evidence", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /selected_release_readiness_topology_legacy_20260901120000/i);
  assert.match(sql, /'20260901130000'/);
  assert.match(sql, /migrations_current[\s\S]*rls_verified/i);
  assert.match(sql, /has_function_privilege\(\s*'page2webmcp_maintenance'/i);
  assert.match(sql, /not pg_catalog\.has_function_privilege\(\s*'service_role'/i);
});
