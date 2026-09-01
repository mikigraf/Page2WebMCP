import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260901030000_analysis_source_lock.sql",
  import.meta.url,
);

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
