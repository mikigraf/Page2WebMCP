import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260830094622_trusted_release_installations.sql",
  import.meta.url,
);
const workflowMigrationUrl = new URL(
  "../../../supabase/migrations/20260830120000_phased_workflow_substrate.sql",
  import.meta.url,
);
const migrationsUrl = new URL("../../../supabase/migrations/", import.meta.url);

test("trusted installation migration drops the legacy eligibility constraint before its legacy reverify update (catches moving the drop below the update)", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const legacyConstraintDrop = sql.search(
    /alter table public\.verification_runs\s+drop constraint verification_runs_eligibility_check/i,
  );
  const legacyReverifyUpdate = sql.search(
    /update public\.verification_runs\s+set[\s\S]*?eligible\s*=\s*false/i,
  );

  assert.ok(legacyConstraintDrop >= 0, "the legacy eligibility constraint is dropped");
  assert.ok(legacyReverifyUpdate >= 0, "legacy rows are made ineligible for reverification");
  assert.ok(
    legacyConstraintDrop < legacyReverifyUpdate,
    "the old equality constraint must not validate the legacy eligible=false backfill",
  );
});

test("trusted installation migration gives the inline status enum check its own stable name (catches PostgreSQL auto-name collision)", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  assert.match(
    sql,
    /status text not null\s+constraint release_installations_status_value_check\s+check\s*\(status in \('pending_self_host', 'verified', 'failed'\)\)/i,
  );
  assert.match(sql, /constraint release_installations_status_check check\s*\(/i);
});

test("trusted installation migration creates the release tenant key before its composite foreign key (catches leaving the key in the later workflow migration)", async () => {
  const [sql, workflowSql] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(workflowMigrationUrl, "utf8"),
  ]);
  const releaseTenantKey = /alter table public\.releases\s+add constraint releases_id_project_org_key\s+unique \(id, project_id, organization_id\)/i;
  const keyPosition = sql.search(releaseTenantKey);
  const foreignKeyPosition = sql.search(
    /constraint release_installations_release_tenant_fk\s+foreign key \(release_id, project_id, organization_id\)/i,
  );

  assert.ok(keyPosition >= 0, "the referenced release tenant key is created in this migration");
  assert.ok(foreignKeyPosition >= 0, "release installations retain their composite tenant foreign key");
  assert.ok(
    keyPosition < foreignKeyPosition,
    "PostgreSQL must see the referenced release key before creating the tenant foreign key",
  );
  assert.doesNotMatch(
    workflowSql,
    releaseTenantKey,
    "the later workflow migration must not add the same release tenant key twice",
  );
});

test("pgcrypto calls in replayed migrations are schema-qualified (catches relying on the migration session search path)", async () => {
  const migrationFiles = (await readdir(migrationsUrl)).filter((file) => file.endsWith(".sql"));
  const bareDigestCalls = (await Promise.all(migrationFiles.map(async (file) => {
    const sql = await readFile(new URL(file, migrationsUrl), "utf8");
    return [...sql.matchAll(/(?<![\w.])digest\s*\(/gi)].map(() => file);
  }))).flat();

  assert.deepEqual(bareDigestCalls, []);
});
