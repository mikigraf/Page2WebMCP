import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hardeningMigration = new URL(
  "../../../supabase/migrations/20260829090000_harden_control_plane.sql",
  import.meta.url,
);
const retentionMigration = new URL(
  "../../../supabase/migrations/20260829092023_bounded_retention_cleanup.sql",
  import.meta.url,
);
const safeCreation = "nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls";
const tenantPermittedHardening = "nologin noinherit nocreatedb nocreaterole";

async function migrations(): Promise<{ hardening: string; retention: string }> {
  const [hardening, retention] = await Promise.all([
    readFile(hardeningMigration, "utf8"),
    readFile(retentionMigration, "utf8"),
  ]);
  return { hardening, retention };
}

test("tenant role creation retains the complete explicit safe posture", async () => {
  const { hardening, retention } = await migrations();
  assert.match(hardening, new RegExp(`create role page2webmcp_app\\s+${safeCreation}`, "i"));
  assert.match(retention, new RegExp(`create role page2webmcp_maintenance\\s+${safeCreation}`, "i"));
});

test("idempotent replay alters use only tenant-permitted role clauses", async () => {
  const { hardening, retention } = await migrations();
  const statements = [...`${hardening}\n${retention}`.matchAll(
    /alter role (page2webmcp_(?:app|worker|maintenance))\s+([^;]+);/gi,
  )].map((match) => ({
    role: match[1]!.toLowerCase(),
    clauses: match[2]!.trim().replace(/\s+/g, " ").toLowerCase(),
  }));
  assert.deepEqual(statements, [
    { role: "page2webmcp_app", clauses: tenantPermittedHardening },
    { role: "page2webmcp_worker", clauses: tenantPermittedHardening },
    { role: "page2webmcp_maintenance", clauses: tenantPermittedHardening },
  ]);
});

test("post-create assertion rejects every missing or unsafe application role", async () => {
  const { hardening, retention } = await migrations();
  const combined = `${hardening}\n${retention}`;
  assert.match(retention, /values\s*\(\s*'page2webmcp_app'\s*\),\s*\(\s*'page2webmcp_worker'\s*\),\s*\(\s*'page2webmcp_maintenance'\s*\)/i);
  assert.match(retention, /left join pg_catalog\.pg_roles[\s\S]*rolname/i);
  assert.match(retention, /role_state\.oid is null/i);
  for (const unsafeAttribute of [
    "rolcanlogin",
    "rolinherit",
    "rolsuper",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
    "rolbypassrls",
  ]) {
    assert.match(retention, new RegExp(`role_state\\.${unsafeAttribute}`, "i"));
  }
  assert.match(retention, /raise exception 'page2webmcp application role posture is unsafe'/i);
  assert.doesNotMatch(combined, /alter\s+role\s+postgres[\s\S]*superuser/i);
  assert.doesNotMatch(combined, /grant\s+[^;]*\bsuperuser\b/i);
});
