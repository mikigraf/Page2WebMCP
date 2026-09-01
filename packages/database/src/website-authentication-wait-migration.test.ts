import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);

async function migration() {
  const matches = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{14}_website_authentication_wait\.sql$/.test(name));
  assert.equal(matches.length, 1, "one CLI-generated website authentication wait migration must exist");
  return {
    name: matches[0]!,
    sql: await readFile(new URL(matches[0]!, migrationsDirectory), "utf8"),
  };
}

test("website authentication migration adds bounded waiting state and exact tenant bindings", async () => {
  const { sql } = await migration();
  assert.match(sql, /analysis_runs_status_check[\s\S]*'waiting'/i);
  assert.match(sql, /analysis_jobs_status_check[\s\S]*'waiting'/i);
  assert.match(sql, /create table private\.website_authentication_checkpoints/i);
  for (const column of [
    "analysis_run_id", "organization_id", "project_id", "workflow_task_id", "source_snapshot_id",
    "source_identity_hash", "target_origin_digest", "checkpoint_reference",
    "authentication_evidence_reference", "state", "expires_at",
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`, "i"));
  assert.match(sql, /foreign key \(analysis_run_id, project_id, organization_id\)[\s\S]*public\.analysis_runs/i);
  assert.match(sql, /foreign key \(workflow_task_id, analysis_run_id, project_id, organization_id\)[\s\S]*private\.workflow_tasks/i);
  assert.match(sql, /foreign key \(source_snapshot_id, project_id, organization_id\)[\s\S]*public\.source_snapshots/i);
  assert.match(sql, /website_authentication_checkpoints_workflow_task_idx/i);
  assert.match(sql, /website_authentication_checkpoints_source_snapshot_idx/i);
  assert.match(sql, /website_authentication_checkpoints_active_expiry_idx[\s\S]*where state in \('waiting', 'consumed'\)/i);
  assert.match(sql, /checkpoint_reference[\s\S]*\^urn:sha256:\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /target_origin_digest[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.doesNotMatch(sql, /\b(live_url|cdp_url|provider_session_id|cookie|credential|token|otp|raw_target_page|kms_secret)\b/i);
});

test("website authentication migration preserves forced RLS and least-privilege role boundaries", async () => {
  const { sql } = await migration();
  assert.match(sql, /alter table private\.website_authentication_checkpoints enable row level security/i);
  assert.match(sql, /alter table private\.website_authentication_checkpoints force row level security/i);
  assert.match(sql, /worker manages website authentication checkpoints[\s\S]*page2webmcp_worker/i);
  assert.match(sql, /app reads website authentication checkpoints[\s\S]*private\.context_organization_id/i);
  assert.match(sql, /app resumes website authentication checkpoints[\s\S]*private\.context_member\(organization_id, array\['owner', 'editor'\]\)/i);
  assert.match(sql, /revoke all on private\.website_authentication_checkpoints[\s\S]*public[\s\S]*anon[\s\S]*authenticated[\s\S]*service_role[\s\S]*page2webmcp_maintenance/i);
  const checkpointGrants = [...sql.matchAll(
    /grant[\s\S]*?on private\.website_authentication_checkpoints[\s\S]*?;/gi,
  )].map((match) => match[0]);
  assert.ok(checkpointGrants.length > 0, "checkpoint grants must be explicit");
  for (const grant of checkpointGrants) {
    assert.doesNotMatch(
      grant,
      /\b(?:anon|authenticated|service_role|page2webmcp_maintenance)\b/i,
    );
  }
});

test("website authentication migration advances the exact readiness ledger", async () => {
  const { name, sql } = await migration();
  const version = name.slice(0, 14);
  assert.match(sql, new RegExp(`\\('${version}'\\)`));
  assert.match(sql, /selected_release_readiness_topology_legacy_20260901060852/i);
  const readiness = await readFile(new URL("../../../scripts/check-release-readiness.ts", import.meta.url), "utf8");
  const lifecycle = await readFile(new URL("../../../scripts/local-supabase.mjs", import.meta.url), "utf8");
  assert.match(readiness, new RegExp(name.replaceAll(".", "\\.")));
  assert.match(lifecycle, new RegExp(`REQUIRED_MIGRATION = "${version}"`));
});
