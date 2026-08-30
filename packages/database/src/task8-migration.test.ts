import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260830094622_trusted_release_installations.sql", import.meta.url);

test("Task 8 migration persists exact typed checks and isolates owner installation attestations", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter table public\.verification_runs[\s\S]*add column checks jsonb/i);
  assert.match(sql, /private\.valid_release_verification_checks\(checks\)/i);
  assert.match(sql, /create table public\.release_installations/i);
  assert.match(sql, /foreign key \(release_id, project_id, organization_id\)[\s\S]*references public\.releases/i);
  assert.match(sql, /alter table public\.release_installations force row level security/i);
  assert.match(sql, /private\.context_member\(organization_id, array\['owner'\]\)/i);
  assert.match(sql, /revoke all on public\.release_installations from anon, authenticated, page2webmcp_worker/i);
  assert.match(sql, /grant select, insert on public\.release_installations to page2webmcp_app/i);
  assert.match(sql, /create unique index release_installations_exact_release_idx/i);
});
