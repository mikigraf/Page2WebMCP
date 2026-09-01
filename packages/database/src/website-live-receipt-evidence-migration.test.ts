import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../../../supabase/migrations/", import.meta.url);

test("website live receipt evidence migration is additive, private, bounded, and worker-owned", async () => {
  const migrations = await readdir(migrationDirectory);
  assert.equal(
    migrations.filter((name) => name === "20260901110000_website_live_receipt_evidence.sql").length,
    1,
  );
  const sql = await readFile(new URL("20260901110000_website_live_receipt_evidence.sql", migrationDirectory), "utf8");
  assert.match(sql, /create table private\.website_live_receipt_evidence/i);
  assert.match(sql, /ownership_decision_digest text not null[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /enable row level security[\s\S]*force row level security/i);
  assert.match(sql, /octet_length\(cleanup_resources::text\)[\s\S]*(?:<=|<)\s*16384/i);
  assert.match(sql, /revoke all[\s\S]*public[\s\S]*anon[\s\S]*authenticated[\s\S]*service_role/i);
  assert.match(sql, /grant (?:select|insert|update)[\s\S]*page2webmcp_worker/i);
  assert.doesNotMatch(sql, /website_live_receipt_evidence for all to page2webmcp_worker\s+using \(true\)/i);
  assert.match(sql, /workflow_task_id::text\s*=\s*current_setting\('page2webmcp\.workflow_task_id'/i);
  assert.match(sql, /task\.phase\s*=\s*'analysis'[\s\S]*worker_has_active_workflow_lease/i);
  assert.match(sql, /cleanup_lease_owner\s*=\s*current_setting\('page2webmcp\.worker_id'/i);
  assert.match(sql, /cleanup_lease_generation\s*=\s*nullif\(current_setting\('page2webmcp\.lease_generation'/i);
  assert.match(sql, /create policy "worker reads exact leased workflow evidence"[\s\S]*task_id::text\s*=\s*current_setting\('page2webmcp\.workflow_task_id'[\s\S]*worker_has_active_workflow_lease\(workflow_run_id\)/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]*page2webmcp_(?:app|maintenance)/i);
  assert.match(sql, /enforce_website_live_receipt_evidence_monotonic/i);
  assert.match(sql, /old\.ownership_decision_digest\s*<>\s*new\.ownership_decision_digest/i);
});

test("selected Website evidence projection is maintenance-only and omits tenant and raw reference columns", async () => {
  const sql = await readFile(new URL("20260901110000_website_live_receipt_evidence.sql", migrationDirectory), "utf8");
  assert.match(sql, /selected_website_live_receipt_evidence\(selected_hash text\)/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, pg_temp/i);
  assert.match(sql, /grant execute[^;]*selected_website_live_receipt_evidence[^;]*page2webmcp_maintenance/i);
  assert.match(sql, /revoke all[^;]*selected_website_live_receipt_evidence[^;]*(?:public|anon|authenticated)/i);
  const returns = sql.match(/selected_website_live_receipt_evidence\(selected_hash text\)[\s\S]*?returns table \(([\s\S]*?)\)\s*language/i)?.[1] ?? "";
  assert.doesNotMatch(returns, /(?:^|\s)(?:organization_id|project_id|checkpoint_reference|authentication_evidence_reference|secret_reference)\s/i);
  assert.match(sql, /workflow\.id\s*=\s*analysis\.id[\s\S]*task\.phase\s*=\s*'analysis'/i);
  assert.match(sql, /checkpoint\.checkpoint_reference\s*=\s*evidence\.checkpoint_reference/i);
  assert.match(sql, /checkpoint\.source_snapshot_id\s*=\s*evidence\.source_snapshot_id/i);
  assert.match(sql, /target_origin_digest\s*=\s*[\s\S]*digest\(release\.allowed_origin,\s*'sha256'/i);
  assert.match(sql, /result_checkpoint_output_reference\s*=\s*'urn:sha256:'\s*\|\|\s*release\.content_hash/i);
  assert.match(sql, /result_checkpoint_hash\s*=\s*task\.output_hash/i);
  assert.match(returns, /ownership_decision_digest text/i);
  assert.match(sql, /evidence\.restart_verified[\s\S]*cleanup->>'disposition'\s+in\s*\('pending',\s*'failed'\)/i);
});
