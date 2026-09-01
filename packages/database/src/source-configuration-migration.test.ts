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
  const canonicalizationCandidates = [
    `${origin}/a/../page`, `${origin}/./page`, `${origin}/a/%2e%2e/page`,
    `${origin}/a/.%2e/page`, `${origin}/a\\..\\page`, `${origin}/line\nbreak`,
    `${origin}/tab\tvalue`, `${origin}/back\`tick`, `${origin}/braces{}`, `${origin}/quote"`,
    `${origin}/angle<>`,
  ];
  for (const pageUrl of canonicalizationCandidates) {
    assert.notEqual(new URL(pageUrl).toString(), pageUrl);
  }
  const canonicalWithQuery = `${origin}/webmcp-test?tenant=example&mode=read`;
  assert.equal(new URL(canonicalWithQuery).toString(), canonicalWithQuery);
  const acceptedCharacters = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~/");
  for (const pageUrl of [
    `${origin}/line\nbreak`, `${origin}/tab\tvalue`, `${origin}/back\`tick`, `${origin}/braces{}`,
    `${origin}/quote"`, `${origin}/single'`, `${origin}/angle<>`, `${origin}/percent%2f`,
  ]) {
    assert.ok([...pageUrl.slice(origin.length)].some((character) => !acceptedCharacters.has(character)));
  }
  assert.match(sql, /create function private\.canonical_https_test_page_segment\(segment text\)/);
  assert.match(sql, /lower\(segment\) not in \('\.', '\.\.', '%2e', '\.%2e', '%2e\.', '%2e%2e'\)/);
  assert.match(sql, /position\(E'\\\\' in path\) > 0/);
  assert.match(sql, /create function private\.canonical_https_test_page_characters\(value text\)/);
  assert.match(sql, /translate\(value, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\-\._~\/', ''\) = ''/);
  assert.match(sql, /position\('\?' in page_url\) > 0/);
  assert.match(sql, /path := substring\(page_url from char_length\(origin\) \+ 1\)/);
  assert.match(sql, /position\('#' in page_url\) > 0/);
});

test("applied source-configuration databases are hardened against OpenAPI test-page queries", async () => {
  const hardeningUrl = new URL("../../../supabase/migrations/20260831111000_openapi_test_page_no_query.sql", import.meta.url);
  const sql = await readFile(hardeningUrl, "utf8");
  assert.match(sql, /OPENAPI_TEST_PAGE_QUERY_REMEDIATION_REQUIRED/);
  assert.match(sql, /from public\.project_sources/);
  assert.match(sql, /from private\.analysis_jobs/);
  assert.match(sql, /raise exception using\s+errcode = 'P0001'/);
  assert.ok(sql.indexOf("OPENAPI_TEST_PAGE_QUERY_REMEDIATION_REQUIRED")
    < sql.indexOf("create or replace function private.canonical_https_test_page"));
  assert.match(sql, /create or replace function private\.canonical_https_test_page\(origin text, page_url text\)/);
  assert.match(sql, /position\('\?' in page_url\) > 0/);
  assert.doesNotMatch(sql, /delete from|update public\.project_sources/i);
});
