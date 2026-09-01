import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260901010000_single_installation_proof.sql",
  import.meta.url,
);
const readinessScriptUrl = new URL("../../../scripts/check-release-readiness.ts", import.meta.url);

const proofColumns = [
  "selected_release_hash text",
  "release_content_hash text",
  "release_integrity text",
  "candidate_observed_integrity text",
  "installation_observed_integrity text",
  "served_content_hash text",
  "executed_content_hash text",
  "trusted_loader_content_hash text",
  "release_verification_run_id uuid",
  "candidate_verification_run_id uuid",
  "candidate_mode text",
  "installation_mode text",
  "candidate_protocol_version integer",
  "installation_protocol_version integer",
  "candidate_verifier_origin_digest text",
  "installation_verifier_origin_digest text",
  "candidate_webmcp_implementation text",
  "installation_webmcp_implementation text",
  "provider_mode text",
  "provider_adapter text",
  "provider_adapter_version integer",
  "source_type text",
  "provider_fixture boolean",
  "source_fixture boolean",
  "local_only boolean",
  "target_identity_matches boolean",
  "artifact_identity_matches boolean",
  "capability_digest_matches boolean",
  "expected_tools_digest text",
  "registered_tools_digest text",
  "expected_tool_count integer",
  "registered_tool_count integer",
  "normal_page_load boolean",
  "route_interception boolean",
  "injected_registration boolean",
  "synthetic_harness boolean",
  "duplicate_load_harmless boolean",
  "authenticated_read_executed boolean",
  "confirmed_reversible_mutation_executed boolean",
  "confirmed_mutation_effect_count integer",
  "authoritative_final_state_verified boolean",
  "execution_tools_match_capabilities boolean",
  "zero_control_plane_calls boolean",
  "zero_model_calls boolean",
  "trusted_loader_enforced boolean",
  "candidate_checks_passed boolean",
];

test("upgrade migration replaces the deployed proof with one direct installation query", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql,
    /alter function private\.selected_native_installation_proof\(text\)\s+rename to selected_native_installation_proof_legacy_20260901000000/i);
  const definition = /create function private\.selected_native_installation_proof\(selected_hash text\)([\s\S]*?)\$\$;/i
    .exec(sql)?.[1] ?? "";
  const returns = /returns table \(([\s\S]*?)\)\s*language/i.exec(definition)?.[1] ?? "";
  assert.deepEqual(
    returns.split(",").map((column) => column.replace(/\s+/g, " ").trim()).filter(Boolean),
    proofColumns,
  );
  assert.doesNotMatch(definition, /selected_native_installation_proof_legacy|\blegacy\./i);
  assert.match(definition, /from public\.releases release/i);
  assert.match(definition, /join public\.verification_runs candidate[\s\S]*candidate\.id = release\.verification_run_id/i);
  assert.match(definition, /join public\.analysis_runs analysis[\s\S]*analysis\.id = release\.analysis_run_id/i);
  assert.match(definition, /join public\.workflow_runs workflow[\s\S]*workflow\.analysis_run_id = analysis\.id/i);
  assert.match(definition, /join public\.source_snapshots source_snapshot[\s\S]*source_snapshot\.id = workflow\.source_snapshot_id/i);
  assert.match(definition, /join public\.project_sources source[\s\S]*source\.id = source_snapshot\.project_source_id/i);
  assert.equal([...definition.matchAll(/join public\.release_installations installation/gi)].length, 1);
  assert.match(definition,
    /installation\.normal_page_load[\s\S]*installation\.authenticated_read_authenticated[\s\S]*final_state_mutation_tool_name = installation\.confirmed_mutation_tool_name[\s\S]*order by installation\.verified_at desc, installation\.id desc\s+limit 1/i);
  assert.match(sql,
    /revoke all on function private\.selected_native_installation_proof_legacy_20260901000000\(text\)[\s\S]*page2webmcp_maintenance/i);
  assert.match(sql,
    /grant execute on function private\.selected_native_installation_proof\(text\) to page2webmcp_maintenance/i);
});

test("upgrade migration advances readiness to the exact complete 19-migration ledger", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const committed = (await readdir(new URL("../../../supabase/migrations/", import.meta.url)))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .map((name) => name.slice(0, 14))
    .filter((version) => version <= "20260901010000")
    .sort();
  const requiredBlock = /required_migrations\s*\(version\)\s+as\s*\(\s*values([\s\S]*?)\),\s*applied_migrations/i
    .exec(sql)?.[1];
  assert.ok(requiredBlock);
  const expected = [...requiredBlock.matchAll(/\('(\d{14})'\)/g)].map((match) => match[1]).sort();
  assert.equal(expected.length, 19);
  assert.deepEqual(expected, committed);
  assert.match(sql,
    /from private\.selected_release_readiness_topology_legacy_20260901000000\(selected_hash\)/i);
  assert.match(sql, /count\(\*\)\s*=\s*count\(distinct version\)/i);
});

test("source readiness audits the upgrade migration as the active installation proof", async () => {
  const source = await readFile(readinessScriptUrl, "utf8");
  assert.match(source, /20260901010000_single_installation_proof\.sql/);
  assert.match(source,
    /selected_native_installation_proof[\s\S]*confirmed_mutation_effect_count\s*\\s\*=[\s\S]*page2webmcp_maintenance/i);
});
