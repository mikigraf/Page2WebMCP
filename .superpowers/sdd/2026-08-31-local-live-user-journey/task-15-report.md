# Task 15 report: Supabase tenant-role replay compatibility

## Status

Implemented in `2a2ba13ab1dc219988ac616acc7967f265333e33` (`fix(database): make role hardening tenant replay-safe`). The historical app, worker, and maintenance role hardening is now compatible with Supabase's non-superuser tenant `postgres` role while preserving the exact intended safe role posture. Nothing was pushed, and no Docker or Supabase database start, reset, or migration apply was run.

## Root cause and repair

Supabase's tenant `postgres` role may create the three application roles with explicit safe defaults, but it may not restate `NOSUPERUSER`, `NOREPLICATION`, or `NOBYPASSRLS` on an existing role. The historical idempotent `ALTER ROLE` statements did so and therefore failed a clean pinned-CLI replay with SQLSTATE `42501`.

The two migrations now:

- retain the full explicit creation posture: `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
- restrict each post-create `ALTER ROLE` to the tenant-permitted `NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE` clauses; and
- assert through `pg_catalog.pg_roles` that all three expected roles exist and that none can login, inherit, act as superuser, create databases, create roles, replicate, or bypass RLS. A missing or unsafe role raises SQLSTATE `42501` and aborts the migration.

No role grants, schemas, policies, readiness audits, migration versions, or migration ordering changed. No local privilege elevation or tenant-superuser workaround was added.

## Exact files changed

- `supabase/migrations/20260829090000_harden_control_plane.sql`
- `supabase/migrations/20260829092023_bounded_retention_cleanup.sql`
- `packages/database/src/tenant-role-replay-compatibility-migration.test.ts`

The unrelated untracked `docs/superpowers/.DS_Store` was not modified or committed.

## RED evidence

The migration contract test was added before implementation and run with:

```text
/usr/local/bin/node --experimental-transform-types --test \
  packages/database/src/tenant-role-replay-compatibility-migration.test.ts
```

Observed before the SQL repair:

```text
3 tests: 1 passed, 2 failed; exit 1
```

The failures proved that all three replay `ALTER ROLE` statements still contained the forbidden superuser-only clauses and that the required three-role catalog assertion did not exist.

## GREEN evidence

Focused migration contract after implementation:

```text
/usr/local/bin/node --experimental-transform-types --test \
  packages/database/src/tenant-role-replay-compatibility-migration.test.ts

3 passed, 0 failed; exit 0
```

Static verification:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc \
  --project tsconfig.base.json --noEmit
/usr/local/bin/node node_modules/eslint/bin/eslint.js \
  packages/database/src/tenant-role-replay-compatibility-migration.test.ts \
  --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check

all exit 0
```

The broad static migration-contract sweep also ran:

```text
/usr/local/bin/node --experimental-transform-types --test \
  packages/database/src/*-migration.test.ts

45 passed, 1 failed; exit 1
```

The sole failure is outside this task: `local-artifact-topology-migration.test.ts` expects `20260901071658_website_authentication_wait.sql` in the active source-readiness migration ledger, while the current readiness source reports only the preceding 23 versions. The new Task 15 contract passed within that sweep.

## Concerns

- The controller still owns the required clean pinned `supabase@2.116.0` replay on the canonical topology. This task intentionally did not start/reset/apply Docker, so the repaired migrations are not claimed as database-executed evidence yet.
- The unrelated active-ledger contract failure described above remains on the branch and was not changed because Task 15 permits edits only to the two historical role migrations plus its regression test/report.
