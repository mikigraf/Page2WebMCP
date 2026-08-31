import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260831090000_source_configuration.sql", import.meta.url);

test("source configuration migration keeps canonical bounded source context private to application and worker roles", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /add column source_configuration jsonb/);
  assert.match(sql, /alter column source_configuration set not null/);
  assert.match(sql, /legacy_unconfigured/);
  assert.match(sql, /create function private\.valid_source_configuration\(value jsonb\)/);
  assert.match(sql, /value->>'kind' = 'openapi'/);
  assert.match(sql, /targetOrigin/);
  assert.match(sql, /testPageUrl/);
  assert.match(sql, /environment/);
  assert.match(sql, /grant select, insert on public\.project_sources to page2webmcp_app/);
  assert.match(sql, /grant select, update \(status, attempts, lease_owner, lease_expires_at, available_at, updated_at\)\s+on private\.analysis_jobs to page2webmcp_worker/);
  assert.doesNotMatch(sql, /grant .*source_configuration.* to (?:anon|authenticated)/i);
});
