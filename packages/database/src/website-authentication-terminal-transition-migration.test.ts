import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);

async function migration() {
  const matches = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{14}_allow_waiting_authentication_failure\.sql$/.test(name));
  assert.equal(matches.length, 1, "one CLI-generated authentication transition migration must exist");
  return {
    name: matches[0]!,
    sql: await readFile(new URL(matches[0]!, migrationsDirectory), "utf8"),
  };
}

test("authentication transition migration adds only the required waiting-to-failed edge", async () => {
  const { sql } = await migration();
  assert.match(sql, /drop\s+constraint\s+website_authentication_checkpoints_check4/i);
  assert.match(sql, /add\s+constraint\s+website_authentication_terminal_evidence_check/i);
  assert.match(sql, /state\s*<>\s*'completed'[\s\S]*authentication_evidence_reference\s+is\s+not\s+null[\s\S]*consumed_at\s+is\s+not\s+null[\s\S]*terminal_at\s+is\s+not\s+null/i);
  assert.match(sql, /state\s*<>\s*'failed'[\s\S]*terminal_at\s+is\s+not\s+null[\s\S]*authentication_evidence_reference\s+is\s+null[\s\S]*consumed_at\s+is\s+null[\s\S]*authentication_evidence_reference\s+is\s+not\s+null[\s\S]*consumed_at\s+is\s+not\s+null/i);
  assert.match(sql, /create\s+or\s+replace\s+function\s+private\.enforce_website_authentication_checkpoint_transition\(\)/i);
  assert.match(sql, /old\.state\s*=\s*'waiting'\s+and\s+new\.state\s+in\s*\(\s*'consumed'\s*,\s*'failed'\s*,\s*'cancelled'\s*,\s*'expired'\s*\)/i);
  assert.match(sql, /old\.state\s*=\s*'consumed'\s+and\s+new\.state\s+in\s*\(\s*'completed'\s*,\s*'failed'\s*,\s*'cancelled'\s*,\s*'expired'\s*\)/i);
  assert.doesNotMatch(sql, /old\.state\s*=\s*'waiting'\s+and\s+new\.state\s+in\s*\([^)]*'completed'/i);
  assert.doesNotMatch(sql, /disable\s+trigger|drop\s+trigger/i);
});

test("authentication transition migration preserves binding, evidence, and execute restrictions", async () => {
  const { sql } = await migration();
  const transitionFunction = sql.match(
    /create\s+or\s+replace\s+function\s+private\.enforce_website_authentication_checkpoint_transition\(\)([\s\S]*?)\$\$;/i,
  )?.[0];
  assert.ok(transitionFunction);
  for (const immutableBinding of [
    "analysis_run_id",
    "organization_id",
    "project_id",
    "workflow_task_id",
    "source_snapshot_id",
    "source_identity_hash",
    "target_origin_digest",
    "checkpoint_reference",
    "expires_at",
    "wait_idempotency_key",
    "wait_input_hash",
    "created_at",
  ]) assert.match(transitionFunction, new RegExp(`old\\.${immutableBinding}\\s*<>\\s*new\\.${immutableBinding}`, "i"));
  for (const immutableEvidence of [
    "authentication_evidence_reference",
    "consumed_at",
    "terminal_at",
    "resume_idempotency_key",
    "resume_input_hash",
  ]) assert.match(transitionFunction, new RegExp(`old\\.${immutableEvidence}[\\s\\S]*is distinct from new\\.${immutableEvidence}`, "i"));
  assert.match(sql, /revoke\s+all\s+on\s+function[\s\S]*from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*,\s*page2webmcp_maintenance/i);
  assert.match(sql, /grant\s+execute\s+on\s+function[\s\S]*to\s+page2webmcp_app\s*,\s*page2webmcp_worker/i);
  assert.doesNotMatch(transitionFunction, /security\s+definer/i);
  assert.match(sql, /grant\s+update\s*\(\s*error_code\s*,\s*retry_classification\s*\)\s+on\s+private\.workflow_tasks\s+to\s+page2webmcp_app/i);
  assert.match(sql, /grant\s+update\s*\(\s*error_code\s*,\s*updated_at\s*\)\s+on\s+public\.analysis_runs\s+to\s+page2webmcp_app/i);
  assert.match(sql, /create\s+policy\s+"app records terminal website authentication diagnostics"[\s\S]*on\s+public\.analysis_runs\s+for\s+update\s+to\s+page2webmcp_app[\s\S]*private\.context_member\((?:analysis_runs\.)?organization_id\s*,\s*array\['owner'\s*,\s*'editor'\]\)[\s\S]*private\.website_authentication_checkpoints[\s\S]*state\s+in\s*\(\s*'failed'\s*,\s*'expired'\s*\)/i);
  assert.doesNotMatch(sql, /grant\s+update\s+on\s+(?:private\.workflow_tasks|public\.analysis_runs)/i);
});

test("authentication transition migration advances the exact local readiness boundary", async () => {
  const { name, sql } = await migration();
  const version = name.slice(0, 14);
  assert.match(sql, /selected_release_readiness_topology_legacy_20260901092107/i);
  assert.match(sql, new RegExp(`\\('${version}'\\)`));
  assert.match(sql, /pg_get_functiondef/i);
  const readiness = await readFile(new URL("../../../scripts/check-release-readiness.ts", import.meta.url), "utf8");
  const lifecycle = await readFile(new URL("../../../scripts/local-supabase.mjs", import.meta.url), "utf8");
  assert.match(readiness, new RegExp(name.replaceAll(".", "\\.")));
  assert.match(lifecycle, new RegExp(`REQUIRED_MIGRATION = "${version}"`));
});
