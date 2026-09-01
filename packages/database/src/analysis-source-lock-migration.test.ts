import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260901030000_analysis_source_lock.sql",
  import.meta.url,
);
const readinessMigrationUrl = new URL(
  "../../../supabase/migrations/20260901040000_analysis_source_lock_readiness.sql",
  import.meta.url,
);
const readinessCliUrl = new URL("../../../scripts/check-release-readiness.ts", import.meta.url);

test("analysis source lock migration keeps row locking behind an app-only definer", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create function private\.lock_active_analysis_source\(/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/i);
  assert.match(sql, /private\.context_member\(target_organization_id, array\['owner', 'editor'\]\)/i);
  assert.match(sql, /for update of source, snapshot/i);
  assert.match(sql, /revoke all on function private\.lock_active_analysis_source[\s\S]*from public/i);
  assert.match(sql, /revoke all on function private\.lock_active_analysis_source[\s\S]*authenticated[\s\S]*page2webmcp_worker[\s\S]*page2webmcp_maintenance/i);
  assert.match(sql, /grant execute on function private\.lock_active_analysis_source[\s\S]*to page2webmcp_app/i);
  assert.doesNotMatch(sql, /grant\s+(update|all)[\s\S]*project_sources/i);
});

test("analysis source lock advances the exact readiness ledger", async () => {
  const sql = await readFile(readinessMigrationUrl, "utf8");
  const requiredBlock = /required_migrations\s*\(version\)\s+as\s*\(\s*values([\s\S]*?)\),\s*applied_migrations/i
    .exec(sql)?.[1];
  assert.ok(requiredBlock);
  const expected = [...requiredBlock.matchAll(/\('(\d{14})'\)/g)].map((match) => match[1]).sort();
  assert.equal(expected.length, 22);
  assert.equal(expected.at(-2), "20260901030000");
  assert.equal(expected.at(-1), "20260901040000");
  assert.equal(new Set(expected).size, expected.length);
  assert.match(sql, /from private\.selected_release_readiness_topology_legacy_20260901020000\(selected_hash\)/i);
  assert.match(sql, /grant execute on function private\.selected_release_readiness_topology\(text\)[\s\S]*to page2webmcp_maintenance/i);

  const readinessCli = await readFile(readinessCliUrl, "utf8");
  assert.match(readinessCli, /20260901030000_analysis_source_lock\.sql/);
  assert.match(readinessCli, /20260901040000_analysis_source_lock_readiness\.sql/);
});
