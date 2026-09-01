import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260901100000_openapi_document_freeze.sql",
  import.meta.url,
);

test("OpenAPI document freeze is immutable, exact-snapshot bound, and maintenance-only", async () => {
  const sql = await readFile(migrationUrl, "utf8").catch(() => "");
  assert.match(sql, /add column source_artifact_metadata jsonb/i);
  assert.match(sql, /source_snapshot\.content_hash/i);
  assert.match(sql, /source_snapshot\.artifact_reference/i);
  assert.match(sql, /source_snapshot\.source_artifact_metadata/i);
  assert.match(sql, /octet_length\(source_artifact_metadata::text\).*8192/is);
  assert.match(sql, /octet_length\(source_artifact_metadata->>'finalUrl'\).*4096/is);
  assert.match(sql, /position\('\?' in source_artifact_metadata->>'finalUrl'\) = 0/i);
  assert.match(sql, /position\('#' in source_artifact_metadata->>'finalUrl'\) = 0/i);
  assert.match(sql, /validate constraint source_snapshots_openapi_artifact_identity_check/i);
  assert.match(sql, /workflow\.source_snapshot_id = source_snapshot\.id/i);
  assert.match(sql,
    /create policy "worker freezes active workflow source snapshot"[\s\S]*?using\s*\(exists\s*\([\s\S]*?workflow\.current_phase = 'analysis'[\s\S]*?with check\s*\(exists\s*\([\s\S]*?workflow\.current_phase = 'analysis'/i);
  assert.match(sql, /pg_get_expr\(policy_row\.polqual,[^)]*\) ~ 'current_phase'/i);
  assert.match(sql, /pg_get_expr\(policy_row\.polwithcheck,[^)]*\) ~ 'current_phase'/i);
  assert.match(sql, /release\.content_hash = selected_hash/i);
  assert.match(sql, /revoke update \(content_hash, artifact_reference, source_artifact_metadata\)/i);
  assert.match(sql, /grant execute on function private\.selected_provider_probe_context\(text\) to page2webmcp_maintenance/i);
  assert.doesNotMatch(sql, /grant execute on function private\.selected_provider_probe_context\(text\) to (?:anon|authenticated|page2webmcp_app|page2webmcp_worker)/i);
  assert.match(sql, /force row level security/i);
  assert.match(sql, /\('20260901100000'\)/);
});
