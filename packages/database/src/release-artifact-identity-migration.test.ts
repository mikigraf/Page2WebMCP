import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260831110000_release_artifact_identity.sql", import.meta.url);

test("release artifact identity migration is additive, content addressed, and legacy compatible", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter table public\.releases[\s\S]*add column artifact_url text[\s\S]*add column download_url text[\s\S]*add column local_only boolean/i);
  assert.match(sql, /artifact_url is null[\s\S]*download_url is null[\s\S]*local_only is null/i);
  assert.match(sql, /artifact_url is not null[\s\S]*download_url is not null[\s\S]*local_only is not null/i);
  assert.match(sql, /content_hash \|\| '\.js'/i);
  assert.match(sql, /download_url = artifact_url \|\| '\?download=page2webmcp-' \|\| content_hash \|\| '\.js'/i);
  assert.match(sql, /https:\/\//i);
  assert.match(sql, /http:\/\/127\.0\.0\.1:54321\/storage\/v1\/object\/public\/page2webmcp-releases\//i);
  assert.doesNotMatch(sql, /update public\.releases/i);
  assert.doesNotMatch(sql, /storage\.objects/i);
  assert.doesNotMatch(sql, /create\s+index/i);
});

test("installation policy binds observations to the release artifact and permits no public write", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /drop policy "owners create release installations" on public\.release_installations/i);
  assert.match(sql, /create policy "owners create release installations"[\s\S]*for insert to page2webmcp_app/i);
  assert.match(sql, /release\.artifact_url is not null/i);
  assert.match(sql, /release\.artifact_url = release_installations\.artifact_url/i);
  assert.match(sql, /drop constraint release_installations_artifact_url_check/i);
  assert.match(sql, /http:\/\/127\.0\.0\.1:54321\/storage\/v1\/object\/public\/page2webmcp-releases\//i);
  assert.match(sql, /release_installations_delivery_csp_check[\s\S]*status <> 'pending_self_host'[\s\S]*delivery = 'hosted'[\s\S]*csp_status = 'blocked'/i);
  assert.match(sql, /status <> 'verified'[\s\S]*delivery = 'hosted'[\s\S]*csp_status = 'allowed'[\s\S]*delivery = 'self_hosted'/i);
  assert.match(sql, /drop index public\.release_installations_exact_release_idx/i);
  assert.doesNotMatch(sql, /grant\s+(?:insert|update|delete|all)[\s\S]*\b(?:anon|authenticated|public)\b/i);
});

test("new app release inserts require complete artifact identity while legacy rows remain readable", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /drop policy "owners create releases" on public\.releases/i);
  assert.match(sql, /create policy "owners create releases"[\s\S]*for insert to page2webmcp_app/i);
  assert.match(sql, /artifact_url is not null[\s\S]*download_url is not null[\s\S]*local_only is not null/i);
  assert.match(sql, /vr\.candidate_content_hash = releases\.content_hash[\s\S]*vr\.eligible/i);
});
