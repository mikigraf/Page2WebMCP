import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260901000000_selected_provider_probe_context.sql",
  import.meta.url,
);

test("selected provider context is maintenance-only and joins the exact release snapshot and evidence", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create function private\.selected_provider_probe_context\(selected_hash text\)/i);
  assert.match(sql, /release\.content_hash = selected_hash/i);
  assert.match(sql, /workflow\.source_snapshot_id/i);
  assert.match(sql, /source_snapshot\.project_source_id/i);
  assert.match(sql, /join private\.analysis_jobs job/i);
  assert.match(sql, /job\.source_url = source\.source_url/i);
  assert.match(sql, /job\.source_configuration = source\.source_configuration/i);
  assert.doesNotMatch(sql, /source_configuration::text[\s\S]*digest/i,
    "jsonb text formatting must not be mistaken for the JS canonical source identity hash");
  assert.match(sql, /evidence\.analysis_run_id = selected\.analysis_run_id/i);
  for (const field of ["source_url", "source_configuration", "source_identity_hash", "github_installation_id",
    "github_repository_id", "github_ref", "github_commit_sha", "github_target_origin"]) {
    assert.match(sql, new RegExp(`\\b${field}\\b`, "i"), field);
  }
  assert.match(sql, /revoke all on function private\.selected_provider_probe_context\(text\)[\s\S]*page2webmcp_worker/i);
  assert.match(sql, /grant execute on function private\.selected_provider_probe_context\(text\) to page2webmcp_maintenance/i);
});

test("current topology compares the exact complete 18-migration ledger", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const committed = (await readdir(new URL("../../../supabase/migrations/", import.meta.url)))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .map((name) => name.slice(0, 14))
    .sort();
  const requiredBlock = /required_migrations\s*\(version\)\s+as\s*\(\s*values([\s\S]*?)\),\s*applied_migrations/i
    .exec(sql)?.[1];
  assert.ok(requiredBlock);
  const expected = [...requiredBlock.matchAll(/\('(\d{14})'\)/g)].map((match) => match[1]).sort();
  assert.equal(expected.length, 18);
  assert.deepEqual(expected, committed);
  assert.match(sql, /count\(\*\)\s*=\s*count\(distinct version\)/i);
});
