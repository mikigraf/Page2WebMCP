import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260831090000_source_configuration.sql", import.meta.url);

test("source configuration migration keeps canonical bounded source context private to application and worker roles", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /add column source_configuration jsonb/);
  assert.match(sql, /alter column source_configuration set not null/);
  assert.match(sql, /legacy_unconfigured/);
  assert.match(sql, /create function private\.valid_source_configuration\(source_type text, value jsonb\)/);
  assert.match(sql, /value->>'kind' = 'openapi'/);
  assert.match(sql, /targetOrigin/);
  assert.match(sql, /testPageUrl/);
  assert.match(sql, /environment/);
  assert.match(sql, /grant select, insert on public\.project_sources to page2webmcp_app/);
  assert.match(sql, /grant select, update \(status, attempts, lease_owner, lease_expires_at, available_at, updated_at\)\s+on private\.analysis_jobs to page2webmcp_worker/);
  assert.doesNotMatch(sql, /grant .*source_configuration.* to (?:anon|authenticated)/i);
});

test("source-configuration migration binds each JSON kind to its source type and rejects malformed HTTPS authorities", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /valid_source_configuration\(source_type, source_configuration\)/);
  assert.match(sql, /when 'website' then/);
  assert.match(sql, /when 'github' then/);
  assert.match(sql, /when 'openapi' then/);
  assert.match(sql, /canonical_https_origin/);
  assert.match(sql, /port < 1 or port > 65535/);
  assert.match(sql, /translate\(port_text, '0123456789', ''\)/);
  assert.match(sql, /left\(page_url, char_length\(origin\) \+ 1\) <> origin \|\| '\/'/);
});

test("source-configuration migration rejects test-page spellings that the URL parser canonicalizes", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const origin = "https://example.com";
  for (const pageUrl of [
    `${origin}/a/../page`,
    `${origin}/./page`,
    `${origin}/a/%2e%2e/page`,
    `${origin}/a/.%2e/page`,
    `${origin}/a\\..\\page`,
  ]) {
    assert.notEqual(new URL(pageUrl).toString(), pageUrl);
  }
  const canonicalWithPathAndQuery = `${origin}/docs/page?environment=test`;
  assert.equal(new URL(canonicalWithPathAndQuery).toString(), canonicalWithPathAndQuery);
  assert.match(sql, /create function private\.canonical_https_test_page_segment\(segment text\)/);
  assert.match(sql, /lower\(segment\) not in \('\.', '\.\.', '%2e', '\.%2e', '%2e\.', '%2e%2e'\)/);
  assert.match(sql, /position\(E'\\\\' in path\) > 0/);
  assert.match(sql, /path := split_part\(substring\(page_url from char_length\(origin\) \+ 1\), '\?', 1\)/);
  assert.match(sql, /position\('#' in page_url\) > 0/);
});
