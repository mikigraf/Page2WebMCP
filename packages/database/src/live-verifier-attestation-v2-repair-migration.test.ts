import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../../../supabase/migrations/", import.meta.url);
const migrationName = "20260901140000_live_verifier_attestation_v2_repair.sql";

test("forward verifier-v2 repair validates deployed checks and replaces the cross-binding proof", async () => {
  const sql = await readFile(new URL(migrationName, migrationDirectory), "utf8");

  for (const constraint of [
    "verification_runs_live_verifier_attestation_check",
    "release_installations_live_verifier_attestation_check",
    "verification_runs_eligibility_check",
  ]) {
    assert.match(sql, new RegExp(`validate constraint ${constraint}`, "i"));
  }

  const proofDefinition = /create or replace function private\.selected_native_installation_proof\(selected_hash text\)([\s\S]*?)\$\$;/i
    .exec(sql)?.[1] ?? "";
  assert.doesNotMatch(proofDefinition, /selected_native_installation_proof_legacy|\bcross join\s+exact_scope\b/i);
  assert.equal([...proofDefinition.matchAll(/join public\.release_installations installation/gi)].length, 1);
  assert.match(proofDefinition, /candidate\.verifier_attestation_id\s*<>\s*installation\.verifier_attestation_id/i);
  assert.match(proofDefinition, /installation\.normal_page_load[\s\S]*not installation\.route_interception/i);
  assert.match(proofDefinition, /order by installation\.verified_at desc, installation\.id desc\s+limit 1/i);
  assert.match(sql, /grant execute[^;]*selected_native_installation_proof[^;]*page2webmcp_maintenance/i);
  assert.doesNotMatch(sql, /grant execute[^;]*selected_native_installation_proof[^;]*(?:service_role|page2webmcp_app|page2webmcp_worker)/i);
});

test("forward verifier-v2 repair advances exact topology through its own migration and requires validated guards", async () => {
  const sql = await readFile(new URL(migrationName, migrationDirectory), "utf8");
  const committed = (await readdir(migrationDirectory))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => name.slice(0, 14) <= "20260901140000")
    .map((name) => name.slice(0, 14))
    .sort();
  const requiredBlock = /required_migrations\s*\(version\)\s+as\s*\(\s*values([\s\S]*?)\),\s*applied_migrations/i
    .exec(sql)?.[1];
  assert.ok(requiredBlock);
  const expected = [...requiredBlock.matchAll(/\('(\d{14})'\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(expected, committed);
  assert.match(sql, /selected_release_readiness_topology_legacy_20260901130000/i);
  for (const constraint of [
    "verification_runs_live_verifier_attestation_check",
    "release_installations_live_verifier_attestation_check",
    "verification_runs_eligibility_check",
  ]) {
    assert.match(
      sql,
      new RegExp(`conname = '${constraint}'[\\s\\S]*?constraint_row\\.convalidated`, "i"),
    );
  }
});
