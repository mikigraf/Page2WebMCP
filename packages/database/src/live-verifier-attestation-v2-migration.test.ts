import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../../../supabase/migrations/", import.meta.url);
const migrationName = "20260901120000_live_verifier_attestation_v2.sql";

test("live verifier-v2 attestation migration is additive, typed, unique, and maintenance-only", async () => {
  const migrations = await readdir(migrationDirectory);
  assert.equal(migrations.filter((name) => name === migrationName).length, 1);
  const sql = await readFile(new URL(migrationName, migrationDirectory), "utf8");

  for (const column of [
    "verifier_attestation_id", "verifier_attestation_request_id", "verifier_attestation_nonce_digest",
    "verifier_attestation_operation", "verifier_attestation_scope_digest", "verifier_attestation_payload_digest",
    "verifier_attestation_issued_at", "verifier_attestation_expires_at", "verifier_attestation_attested_at",
  ]) assert.match(sql, new RegExp(`add column ${column}`, "i"));

  assert.match(sql, /verification_runs_live_verifier_attestation_check/i);
  assert.match(sql, /release_installations_live_verifier_attestation_check/i);
  assert.match(sql, /verification_mode\s*=\s*'live'[\s\S]*verifier_protocol_version\s*=\s*2/i);
  assert.match(sql, /verifier_attestation_operation\s*=\s*'candidate'/i);
  assert.match(sql, /verifier_attestation_operation\s*=\s*'installation'/i);
  assert.match(sql, /verifier_attestation_expires_at\s*>\s*verifier_attestation_attested_at/i);
  assert.match(sql, /verifier_attestation_expires_at\s*<=\s*verifier_attestation_issued_at\s*\+\s*interval '120 seconds'/i);
  assert.match(sql, /create unique index verification_runs_candidate_attestation_id_uidx/i);
  assert.match(sql, /create unique index verification_runs_candidate_request_id_uidx/i);
  assert.match(sql, /create unique index release_installations_installation_attestation_id_uidx/i);
  assert.match(sql, /create unique index release_installations_installation_request_id_uidx/i);
  assert.match(sql, /update public\.verification_runs[\s\S]*verification_mode\s*=\s*'live'[\s\S]*verifier_protocol_version\s+is distinct from\s+2/i);
  assert.match(sql, /verification_runs_eligibility_check[\s\S]*verifier_protocol_version\s*=\s*2[\s\S]*verifier_attestation_operation\s*=\s*'candidate'/i);

  assert.match(sql, /selected_native_installation_proof\(selected_hash text\)/i);
  assert.match(sql, /candidate_attestation_id uuid/i);
  assert.match(sql, /installation_attestation_id uuid/i);
  assert.match(sql, /source_identity_hash text/i);
  assert.match(sql, /installation_operation_id text/i);
  assert.match(sql, /installation_attestation_expires_at timestamptz/i);
  assert.match(sql, /candidate\.verifier_attestation_scope_digest/i);
  assert.match(sql, /installation\.verifier_attestation_scope_digest/i);
  assert.match(sql, /candidate\.verifier_attestation_id\s*<>\s*installation\.verifier_attestation_id/i);
  assert.match(sql, /grant execute[^;]*selected_native_installation_proof[^;]*page2webmcp_maintenance/i);
  assert.doesNotMatch(sql, /grant execute[^;]*selected_native_installation_proof[^;]*(?:anon|authenticated|page2webmcp_app|page2webmcp_worker)/i);
  assert.match(sql, /\('20260901110000'\)[\s\S]*\('20260901120000'\)/i);
});

test("live verifier-v2 upgrade drops the validated v1 eligibility equality before invalidating eligible rows", async () => {
  const sql = await readFile(new URL(migrationName, migrationDirectory), "utf8");
  const oldConstraintDrop = sql.search(
    /alter table public\.verification_runs\s+drop constraint verification_runs_eligibility_check/i,
  );
  const legacyReverifyUpdate = sql.search(
    /update public\.verification_runs\s+set eligible\s*=\s*false[\s\S]*?MIGRATION_VERIFIER_V2_REVERIFY_REQUIRED/i,
  );
  const restoredConstraint = sql.search(
    /alter table public\.verification_runs\s+add constraint verification_runs_eligibility_check\s+check/i,
  );

  assert.ok(oldConstraintDrop >= 0, "the validated v1 equality constraint is dropped");
  assert.ok(legacyReverifyUpdate >= 0, "eligible v1 rows are invalidated for v2 reverification");
  assert.ok(restoredConstraint >= 0, "the v2 equality constraint is restored");
  assert.ok(oldConstraintDrop < legacyReverifyUpdate, "the v1 equality cannot reject the eligible=false backfill");
  assert.ok(legacyReverifyUpdate < restoredConstraint, "the v2 equality is restored after the backfill");
});

test("live verifier-v2 validates every new check and topology rejects an unvalidated verifier guard", async () => {
  const sql = await readFile(new URL(migrationName, migrationDirectory), "utf8");

  for (const constraint of [
    "verification_runs_live_verifier_attestation_check",
    "release_installations_live_verifier_attestation_check",
    "verification_runs_eligibility_check",
  ]) {
    assert.match(
      sql,
      new RegExp(`alter table public\\.(?:verification_runs|release_installations)\\s+validate constraint ${constraint}`, "i"),
      `${constraint} must be validated before the migration commits`,
    );
  }

  const topologyDefinition = /create function private\.selected_release_readiness_topology\(selected_hash text\)([\s\S]*?)\$\$;/i
    .exec(sql)?.[1] ?? "";
  for (const constraint of [
    "verification_runs_live_verifier_attestation_check",
    "release_installations_live_verifier_attestation_check",
    "verification_runs_eligibility_check",
  ]) {
    assert.match(
      topologyDefinition,
      new RegExp(`conname = '${constraint}'[\\s\\S]*?constraint_row\\.convalidated`, "i"),
      `topology must require ${constraint} to be validated`,
    );
  }
});

test("live verifier-v2 derives native behavior and attestation scope from one deterministic installation", async () => {
  const sql = await readFile(new URL(migrationName, migrationDirectory), "utf8");
  const proofDefinition = /create function private\.selected_native_installation_proof\(selected_hash text\)([\s\S]*?)\$\$;/i
    .exec(sql)?.[1] ?? "";

  assert.doesNotMatch(
    proofDefinition,
    /selected_native_installation_proof_legacy|\bcross join\s+exact_scope\b|\blegacy\.\*/i,
    "a separately selected legacy row can be cross-bound to another installation's v2 attestation",
  );
  assert.equal(
    [...proofDefinition.matchAll(/join public\.release_installations installation/gi)].length,
    1,
    "the proof must select one installation row",
  );
  assert.match(proofDefinition, /installation\.normal_page_load/i);
  assert.match(proofDefinition, /not installation\.route_interception/i);
  assert.match(proofDefinition, /candidate\.verifier_attestation_id\s*<>\s*installation\.verifier_attestation_id/i);
  assert.match(proofDefinition, /order by installation\.verified_at desc, installation\.id desc\s+limit 1/i);
});
