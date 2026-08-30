import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Supabase identity migration keeps provisioning private and RLS membership authoritative", async () => {
  const migration = await readFile(new URL("../../../supabase/migrations/20260830160000_supabase_auth_identity.sql", import.meta.url), "utf8");
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path\s*=\s*pg_catalog/i);
  assert.match(migration, /revoke all on function private\.provision_personal_organization[^;]+ from public/i);
  assert.match(migration, /grant execute on function private\.provision_personal_organization[^;]+ to page2webmcp_app/i);
  assert.match(migration, /with eligible as \([\s\S]*?join auth\.users[\s\S]*?having count\(\*\) = 1/i);
  assert.match(migration, /for update[\s\S]+using[\s\S]+with check/i);
  assert.doesNotMatch(migration, /auth\.jwt\(\)[\s\S]{0,200}user_metadata/i);
});
