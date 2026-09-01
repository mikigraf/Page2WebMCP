import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);
const migrationSuffix = "_alternate_canonical_local_supabase_topology.sql";
const oldPrefix = "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/";
const newPrefix = "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/";

async function migration(): Promise<{ name: string; sql: string; versions: string[] }> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const matches = names.filter((name) => name.endsWith(migrationSuffix));
  assert.equal(matches.length, 1, "one forward-only topology migration must exist");
  const name = matches[0]!;
  return {
    name,
    sql: await readFile(new URL(name, migrationsDirectory), "utf8"),
    versions: names.map((entry) => entry.slice(0, 14)),
  };
}

test("alternate local topology migration advances the exact ledger and active readiness path", async () => {
  const { name, sql, versions } = await migration();
  const version = name.slice(0, 14);
  assert.match(name, /^\d{14}_alternate_canonical_local_supabase_topology\.sql$/);
  assert.ok(version > "20260901040000");
  assert.match(sql, /^begin;/i);
  assert.match(sql, /commit;\s*$/i);
  assert.match(sql, /selected_release_readiness_topology_legacy_20260901040000/i);
  assert.match(sql, /selected_provider_probe_context_legacy_20260901000000/i);
  assert.match(sql, /create function private\.selected_provider_probe_context\(selected_hash text\)/i);
  assert.match(sql, new RegExp(newPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  const ledger = sql.match(/required_migrations\(version\)\s+as\s*\(\s*values([\s\S]*?)\),\s*applied_migrations/i)?.[1];
  assert.ok(ledger, "active readiness must declare the exact migration ledger");
  assert.deepEqual([...ledger.matchAll(/'([0-9]{14})'/g)].map((match) => match[1]), versions);
  assert.match(sql, /grant execute on function private\.selected_release_readiness_topology\(text\)[\s\S]*to page2webmcp_maintenance/i);
  assert.match(sql, /revoke all on function private\.selected_release_readiness_topology\(text\)[\s\S]*from anon, authenticated, page2webmcp_app, page2webmcp_worker/i);
});

test("historical local-only identities move to the new prefix but lose installation verification", async () => {
  const { sql } = await migration();
  assert.match(sql, /alter table public\.releases\s+drop constraint releases_artifact_identity_check/i);
  assert.match(sql, /alter table public\.release_installations\s+drop constraint release_installations_artifact_url_check/i);
  assert.match(sql, /update public\.releases[\s\S]*set artifact_url[\s\S]*download_url[\s\S]*where local_only is true/i);
  assert.match(sql, /update public\.release_installations[\s\S]*set status = 'failed'[\s\S]*verified_at = null/i);
  assert.match(sql, /authenticated_read_tool_name = null[\s\S]*confirmed_mutation_tool_name = null[\s\S]*final_state_verified = null/i);
  assert.match(sql, /update public\.release_installations[\s\S]*artifact_url\s*=\s*replace\(\s*artifact_url,[\s\S]*observed_artifact_url = case[\s\S]*executed_artifact_url = case/i);
  assert.match(sql, new RegExp(oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.match(sql, new RegExp(newPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(sql, /set\s+local_only\s*=\s*false/i);
  assert.doesNotMatch(sql, /set\s+observed_local_only\s*=\s*false/i);
  assert.doesNotMatch(sql, /create(?:\s+or\s+replace)?\s+function private\.selected_native_installation_proof/i);
});

test("new writes accept only the alternate canonical local artifact prefix", async () => {
  const { sql } = await migration();
  const releaseConstraint = sql.match(/add constraint releases_artifact_identity_check check \(([\s\S]*?)\n\s*\);/i)?.[1];
  assert.ok(releaseConstraint);
  assert.match(releaseConstraint, new RegExp(newPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(releaseConstraint, new RegExp(oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  const installationConstraint = sql.match(/add constraint release_installations_artifact_url_check check \(([\s\S]*?)\n\s*\) not valid;/i)?.[1];
  assert.ok(installationConstraint);
  assert.match(installationConstraint, new RegExp(newPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(installationConstraint, new RegExp(oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});
