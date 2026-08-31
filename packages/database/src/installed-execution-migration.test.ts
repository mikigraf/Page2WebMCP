import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260831211329_installed_execution_evidence.sql",
  import.meta.url,
);

test("installed execution migration invalidates legacy registration-only proof without inventing evidence", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const column of [
    "authenticated_read_tool_name text",
    "authenticated_read_authenticated boolean",
    "authenticated_read_succeeded boolean",
    "confirmed_mutation_tool_name text",
    "confirmed_mutation_confirmation text",
    "confirmed_mutation_reversible boolean",
    "confirmed_mutation_succeeded boolean",
    "confirmed_mutation_effect_count integer",
    "final_state_mutation_tool_name text",
    "final_state_source text",
    "final_state_verified boolean",
  ]) assert.match(sql, new RegExp(`add column ${column}`, "i"), column);
  assert.match(sql, /update public\.release_installations\s+set status = 'failed', verified_at = null\s+where status = 'verified'/i);
  assert.doesNotMatch(sql, /update public\.release_installations[\s\S]*set authenticated_read_tool_name/i);
  assert.doesNotMatch(sql, /add column (?:authenticated|confirmed|final)_\w+ [^,;]+ default/i);
});

test("verified installation constraint requires one confirmed reversible effect and authoritative final state", async () => {
  const sql = (await readFile(migrationUrl, "utf8")).replace(/\s+/g, " ");
  assert.match(sql, /status = 'verified'[\s\S]*authenticated_read_authenticated[\s\S]*authenticated_read_succeeded/);
  assert.match(sql, /confirmed_mutation_confirmation = 'explicit'/);
  assert.match(sql, /confirmed_mutation_reversible[\s\S]*confirmed_mutation_succeeded/);
  assert.match(sql, /confirmed_mutation_effect_count = 1/);
  assert.match(sql, /final_state_mutation_tool_name = confirmed_mutation_tool_name/);
  assert.match(sql, /final_state_source = 'target'[\s\S]*final_state_verified/);
  assert.match(sql, /\) is true\) \);/i, "NULL must not satisfy the verified CHECK branch");
});

test("selected native proof exposes only bounded execution facts and validates reviewed plan semantics", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const field of [
    "authenticated_read_executed boolean",
    "confirmed_reversible_mutation_executed boolean",
    "confirmed_mutation_effect_count integer",
    "authoritative_final_state_verified boolean",
    "execution_tools_match_capabilities boolean",
  ]) assert.match(sql, new RegExp(field, "i"), field);
  assert.match(sql, /confirmed_mutation_effect_count = 1/i);
  assert.match(sql, /authentication'->>'mode' in \('same_origin_cookie', 'browser_oauth'\)/i);
  assert.match(sql, /effects'->>'kind' = 'mutation'[\s\S]*effects'->>'reversible'[\s\S]*effects'->>'confirmation' = 'always'/i);
  assert.match(sql, /order by installation\.verified_at desc, installation\.id desc[\s\S]*limit 1/i);
  assert.match(sql, /revoke all on function private\.selected_native_installation_proof_legacy_20260831120000\(text\)[\s\S]*page2webmcp_maintenance/i);
  assert.match(sql, /grant execute on function private\.selected_native_installation_proof\(text\) to page2webmcp_maintenance/i);

  const returns = /selected_native_installation_proof\(selected_hash text\)\s*returns table \(([\s\S]*?)\)\s*language/i
    .exec(sql)?.[1] ?? "";
  assert.doesNotMatch(returns, /\b(?:tool_name|manifest|code|target_origin|artifact_url|download_url|page_url)\b/i);
});

test("current topology compares the exact complete committed migration ledger", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const committed = (await readdir(new URL("../../../supabase/migrations/", import.meta.url)))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .map((name) => name.slice(0, 14))
    .sort();
  const requiredBlock = /required_migrations\s*\(version\)\s+as\s*\(\s*values([\s\S]*?)\),\s*applied_migrations/i
    .exec(sql)?.[1];
  assert.ok(requiredBlock, "topology must declare its complete expected migration ledger");
  const expected = [...requiredBlock.matchAll(/\('(\d{14})'\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(expected, committed);
  assert.match(sql, /count\(\*\)\s*=\s*count\(distinct version\)/i);
  assert.match(sql, /array_agg\(version order by version\)[\s\S]*array_agg\(version order by version\)/i);
});
