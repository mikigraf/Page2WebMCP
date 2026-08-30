import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260830120000_phased_workflow_substrate.sql", import.meta.url);

test("workflow migration is additive, complete, bounded, and keeps legacy synchronization analysis-only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "project_sources",
    "source_snapshots",
    "workflow_runs",
    "workflow_tasks",
    "workflow_events",
    "workflow_evidence",
    "capability_plans",
    "verification_checks",
    "installations",
  ]) {
    assert.match(sql, new RegExp(`create table (?:public|private)\\.${table} \\(`));
  }
  assert.match(sql, /lease_generation bigint not null default 0/);
  assert.match(sql, /attempts integer not null default 0 check \(attempts between 0 and 3\)/);
  assert.match(sql, /unique \(workflow_run_id, sequence\)/);
  assert.match(sql, /unique \(workflow_run_id, version\)/);
  assert.match(sql, /workflow_runs_one_active_per_project_idx/);
  assert.match(sql, /workflow_tasks_claim_idx/);
  assert.match(sql, /only private\.analysis_jobs projects legacy analysis state/);
  assert.doesNotMatch(sql, /trigger\s+sync_analysis_job_state\s+on\s+private\.workflow_tasks/i);
  assert.doesNotMatch(sql, /\b(prompt|screenshot|credential|secret_value|raw_dom)\b\s+(?:text|jsonb|bytea)/i);
});
