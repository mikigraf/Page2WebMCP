import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260831120000_live_readiness_attestation.sql",
  import.meta.url,
);

test("Task 8 migration binds releases to exact candidate verification and keeps legacy proof ineligible", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter table public\.releases[\s\S]*add column verification_run_id uuid/i);
  assert.match(sql, /foreign key\s*\(verification_run_id, project_id, organization_id, analysis_run_id, capability_state_digest, content_hash\)[\s\S]*references public\.verification_runs/i);
  assert.match(sql, /verification_runs_exact_release_key/i);
  assert.match(sql, /verification_run_id is not null/i);
  assert.match(sql, /MIGRATION_NATIVE_REVERIFY_REQUIRED/i);
  assert.doesNotMatch(sql, /update public\.releases[\s\S]*set verification_run_id/i);
});

test("Task 8 migration stores bounded provider, verifier, candidate, and installation observations without invented backfill", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const fragment of [
    "provider_mode", "provider_adapter", "provider_adapter_version", "provider_fixture",
    "is_fixture", "verifier_protocol_version", "verifier_origin_digest", "verifier_webmcp_implementation",
    "observed_content_hash", "observed_integrity", "observed_release_id", "observed_target_origin",
    "registered_tools", "trusted_loader_enforced", "trusted_loader_content_hash",
    "control_plane_request_count", "model_request_count", "download_url", "local_only",
    "observed_artifact_url", "observed_download_url", "observed_local_only",
    "executed_artifact_url", "served_content_hash", "executed_content_hash", "normal_page_load",
    "route_interception", "injected_registration", "synthetic_harness", "duplicate_load_harmless",
  ]) assert.match(sql, new RegExp(`\\b${fragment}\\b`, "i"), fragment);
  assert.match(sql, /verification_mode in \('live', 'local_live', 'hermetic'\)/i);
  assert.match(sql, /verifier_webmcp_implementation = 'native'/i);
  assert.match(sql, /provider_mode is null[\s\S]*provider_adapter is null[\s\S]*provider_fixture is null/i);
  assert.doesNotMatch(sql, /update public\.source_snapshots[\s\S]*set is_fixture/i);
  assert.doesNotMatch(sql, /alter table public\.source_snapshots[\s\S]*is_fixture set not null/i);
  for (const tuple of [
    "provider_mode = 'local' and provider_adapter = 'local-fixture' and provider_adapter_version = 1 and provider_fixture",
    "provider_mode = 'openapi' and provider_adapter = 'bounded-openapi' and provider_adapter_version = 1 and not provider_fixture",
    "provider_mode = 'website' and provider_adapter = 'browser-use-v4' and provider_adapter_version = 4 and not provider_fixture",
    "provider_mode = 'github' and provider_adapter = 'github-app' and provider_adapter_version = 20260310 and not provider_fixture",
  ]) assert.match(sql.replace(/\s+/g, " "), new RegExp(tuple.replace(/[ -]/g, (value) => value === " " ? "\\s+" : "-"), "i"));
  assert.match(sql, /grant update \([^)]*provider_mode[^)]*provider_adapter[^)]*provider_adapter_version[^)]*provider_fixture[^)]*\)\s+on public\.analysis_runs to page2webmcp_worker/is);
  assert.ok(sql.indexOf("drop constraint verification_runs_eligibility_check")
    < sql.indexOf("update public.verification_runs\nset eligible = false"));
  assert.doesNotMatch(sql, /update public\.analysis_runs[\s\S]*set provider_mode/i);
  assert.doesNotMatch(sql, /https?:\/\/[^'\s]*acme/i);
});

test("selected-hash live proof is maintenance-only, deterministic, bounded, and contains no tenant URLs or code", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create (?:or replace )?function private\.selected_native_installation_proof\(selected_hash text\)/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /set search_path = pg_catalog, pg_temp/i);
  assert.match(sql, /selected_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /release\.verification_run_id = candidate\.id/i);
  assert.match(sql, /candidate\.verification_mode = 'live'/i);
  assert.match(sql, /installation\.verification_mode = 'live'/i);
  assert.match(sql, /(?:candidate\.verifier_origin_digest = installation\.verifier_origin_digest|installation\.verifier_origin_digest = candidate\.verifier_origin_digest)/i);
  assert.match(sql, /(?:candidate\.verifier_protocol_version = installation\.verifier_protocol_version|installation\.verifier_protocol_version = candidate\.verifier_protocol_version)/i);
  assert.match(sql, /release\.local_only = false/i);
  assert.match(sql, /source_snapshot\.is_fixture = false/i);
  assert.match(sql, /analysis\.provider_fixture = false/i);
  assert.match(sql, /analysis\.provider_mode = source\.source_type/i);
  assert.match(sql, /installation\.observed_artifact_url = release\.artifact_url/i);
  assert.match(sql, /installation\.observed_download_url = release\.download_url/i);
  assert.match(sql, /installation\.observed_local_only = release\.local_only/i);
  assert.match(sql, /extensions\.digest\(installation\.expected_tools::text, 'sha256'\)/i);
  assert.match(sql, /candidate\.observed_target_origin = release\.allowed_origin/i);
  assert.match(sql, /installation\.observed_target_origin = release\.allowed_origin/i);
  assert.match(sql, /installation\.artifact_content_hash = release\.content_hash/i);
  assert.match(sql, /candidate\.capability_state_digest = release\.capability_state_digest/i);
  assert.match(sql, /candidate\.registered_tools = installation\.expected_tools/i);
  assert.match(sql, /candidate\.observed_target_origin = installation\.observed_target_origin/i);
  assert.match(sql, /order by installation\.verified_at desc, installation\.id desc/i);
  assert.match(sql, /limit 1/i);
  assert.match(sql, /create index release_installations_selected_native_idx/i);
  assert.match(sql, /revoke all on function private\.selected_native_installation_proof\(text\) from public/i);
  assert.match(sql, /from anon, authenticated, page2webmcp_app, page2webmcp_worker/i);
  assert.match(sql, /grant execute on function private\.selected_native_installation_proof\(text\) to page2webmcp_maintenance/i);

  const returns = /selected_native_installation_proof\(selected_hash text\)\s*returns table \(([\s\S]*?)\)\s*language/i
    .exec(sql)?.[1] ?? "";
  assert.doesNotMatch(returns, /\b(?:code|manifest|source_content|target_origin|artifact_url|download_url|page_url)\b/i);
  assert.match(returns, /release_content_hash text/i);
  assert.match(returns, /release_verification_run_id uuid/i);
  assert.match(returns, /provider_mode text/i);
});

test("active topology is a maintenance-only selected-hash projection over ledger, RLS, and real providers", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create function private\.selected_release_readiness_topology\(selected_hash text\)/i);
  assert.match(sql, /supabase_migrations\.schema_migrations[\s\S]*version = '20260831120000'/i);
  assert.match(sql, /relation\.relrowsecurity[\s\S]*relation\.relforcerowsecurity/i);
  for (const table of ["analysis_runs", "project_sources", "source_snapshots", "verification_runs", "releases",
    "release_installations", "workflow_runs", "workflow_tasks"]) {
    assert.match(sql, new RegExp(`\\('${table === "workflow_tasks" ? "private" : "public"}', '${table}'\\)`, "i"));
  }
  assert.match(sql, /source_snapshot\.is_fixture = false/i);
  assert.match(sql, /analysis\.provider_fixture = false/i);
  assert.match(sql, /analysis\.provider_mode = source\.source_type/i);
  assert.match(sql, /local_openapi_release boolean[\s\S]*hosted_github_release boolean/i);
  assert.match(sql, /revoke all on function private\.selected_release_readiness_topology\(text\) from public/i);
  assert.match(sql, /grant execute on function private\.selected_release_readiness_topology\(text\) to page2webmcp_maintenance/i);
});
