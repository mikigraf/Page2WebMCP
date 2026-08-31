import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../../supabase/migrations/20260830094622_trusted_release_installations.sql",
  import.meta.url,
);

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
