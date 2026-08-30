import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260830180000_github_workflow_binding.sql", import.meta.url);

test("GitHub workflow migration binds exact reviewed analysis and grants only lease-scoped worker material reads", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /add column reviewed_analysis_run_id uuid/);
  assert.match(sql, /reviewed_analysis_run_id, project_id, organization_id/);
  assert.match(sql, /references public\.analysis_runs\(id, project_id, organization_id\)/);
  assert.match(sql, /worker reads reviewed workflow analysis evidence/);
  assert.match(sql, /worker reads reviewed workflow capabilities/);
  assert.match(sql, /grant select on public\.project_sources, public\.source_snapshots/);
  assert.doesNotMatch(sql, /grant (?:all|insert|update|delete).*project_sources/i);
  assert.doesNotMatch(sql, /\b(token|credential|private_key|secret_value)\b\s+(?:text|jsonb|bytea)/i);
});
