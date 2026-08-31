import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260901020000_durable_result_surfaces.sql",
  import.meta.url,
);

test("GitHub draft PR results are immutable, source-bound, tenant-scoped, and lease-written", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table public\.github_draft_pull_requests/i);
  assert.match(sql, /foreign key \(task_id, workflow_run_id, project_id, organization_id\)[\s\S]*private\.workflow_tasks/i);
  assert.match(sql, /foreign key \(source_snapshot_id, project_id, organization_id\)[\s\S]*public\.source_snapshots/i);
  assert.match(sql, /foreign key \(project_source_id, project_id, organization_id\)[\s\S]*public\.project_sources/i);
  assert.match(sql, /phase text not null check \(phase in \('publish', 'install_verify'\)\)/i);
  assert.match(sql, /draft boolean not null default true check \(draft\)/i);
  assert.match(sql, /merged boolean not null default false check \(not merged\)/i);
  assert.match(sql, /enable row level security[\s\S]*force row level security/i);
  assert.match(sql, /app reads tenant GitHub draft PRs[\s\S]*private\.context_member\(organization_id\)/i);
  assert.match(sql, /worker reads leased GitHub draft PRs[\s\S]*task_id::text = current_setting\('page2webmcp\.workflow_task_id', true\)[\s\S]*private\.worker_has_active_workflow_lease\(workflow_run_id\)/i);
  assert.match(sql, /worker persists leased GitHub draft PRs[\s\S]*private\.worker_has_active_workflow_lease\(workflow_run_id\)/i);
  assert.match(sql, /task_id::text = current_setting\('page2webmcp\.workflow_task_id', true\)/i);
  assert.match(sql, /github_draft_pull_requests_tenant_project_idx[\s\S]*organization_id, project_id, created_at desc,[\s\S]*phase = 'install_verify'/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]*page2webmcp_app/i);
  assert.doesNotMatch(sql, /grant (?:update|delete)[^;]*github_draft_pull_requests[^;]*page2webmcp_worker/i);
  assert.match(sql, /members read release installations[\s\S]*private\.context_member\(organization_id\)/i);
});

test("durable result migration advances readiness to the exact 20-migration ledger", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const block = /required_migrations\s*\(version\)\s+as\s*\(\s*values([\s\S]*?)\),\s*applied_migrations/i
    .exec(sql)?.[1];
  assert.ok(block);
  const expected = [...block.matchAll(/\('(\d{14})'\)/g)].map((match) => match[1]).sort();
  assert.equal(expected.length, 20);
  assert.equal(expected.at(-1), "20260901020000");
  assert.equal(new Set(expected).size, expected.length);
  assert.match(sql, /github_draft_pull_requests[\s\S]*relrowsecurity[\s\S]*relforcerowsecurity/i);
  assert.match(sql, /count\(\*\)\s*=\s*count\(distinct version\)/i);
});
