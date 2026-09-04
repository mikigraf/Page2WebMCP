import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../../../supabase/migrations/", import.meta.url);

// These eight migrations were applied live via apply_migration on 2026-09-03 to
// unblock readiness (see project-live-journey-state-2026-09-03 memory); the
// Supabase migration tool assigns each one's version from its own apply time,
// so the filenames below are the exact versions it actually recorded, not
// timestamps chosen ahead of time. Committing them lets a fresh database
// replay reproduce the live schema exactly.
const HOTFIX_MIGRATIONS = [
  "20260903225550_readiness_topology_coalesce_repair.sql",
  "20260903225903_readiness_topology_coalesce_repair.sql",
  "20260903225919_readiness_topology_legacy_coalesce_repair.sql",
  "20260903230239_readiness_topology_coalesce_repair_final.sql",
  "20260903230419_readiness_topology_coalesce_repair_v2.sql",
  "20260903230528_readiness_topology_coalesce_repair_v3.sql",
  "20260903230905_readiness_topology_repair_pattern_broaden.sql",
  "20260903230947_provider_probe_context_project_id_repair.sql",
];

test("every readiness-topology hotfix migration file exists and never schema-qualifies COALESCE", async () => {
  for (const name of HOTFIX_MIGRATIONS) {
    const sql = await readFile(new URL(name, migrationDirectory), "utf8");
    // COALESCE is a special SQL construct the parser handles directly, not a
    // real pg_catalog function; schema-qualifying it as pg_catalog.coalesce(...)
    // fails with "function pg_catalog.coalesce(text[], text[]) does not exist"
    // the moment the function actually runs. Every other special form shares
    // this - NULLIF, GREATEST, LEAST - so none of them may be schema-qualified.
    const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(code, /pg_catalog\.\s*(?:coalesce|nullif|greatest|least)\s*\(/i, name);
  }
});

test("the final readiness-topology repair tracks its own hotfix family by name, not by a fixed version list", async () => {
  // Supabase assigns each migration's version at apply time, so a hardcoded
  // list of future hotfix versions goes stale the moment a new one is
  // applied. The last two repairs in the family fixed that by matching on
  // the migration's own naming convention instead.
  const v3 = await readFile(
    new URL("20260903230528_readiness_topology_coalesce_repair_v3.sql", migrationDirectory), "utf8",
  );
  assert.match(v3, /migration\.name like 'readiness_topology_%coalesce_repair%'/);

  const broadened = await readFile(
    new URL("20260903230905_readiness_topology_repair_pattern_broaden.sql", migrationDirectory), "utf8",
  );
  assert.match(broadened, /migration\.name like '%\\_repair%' escape '\\'/);
  assert.match(broadened, /migration\.version::text > '20260901140000'/);
});

test("the provider-probe-context repair drops the invalid analysis_jobs.project_id join condition", async () => {
  // private.analysis_jobs has no project_id column - it is scoped by
  // analysis_run_id and organization_id - so joining on job.project_id failed
  // with "column job.project_id does not exist" every time this ran.
  const sql = await readFile(
    new URL("20260903230947_provider_probe_context_project_id_repair.sql", migrationDirectory), "utf8",
  );
  const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /job\.project_id/);
  assert.match(code, /join private\.analysis_jobs job\s+on job\.analysis_run_id = analysis\.id\s+and job\.organization_id = analysis\.organization_id/);
});
