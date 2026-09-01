# Task 12 fix round 1 report: pinned-CLI migration provenance

## Status

The pinned-CLI review finding is addressed in implementation commit `2a249774e2aae9b8d993afe8cd73eb8ceb5a2e4e` (`fix(database): use CLI-created auth wait migration`). Nothing was pushed, no local stack was started or reset, and no database migration was applied.

The unapplied manually timestamped migration:

```text
20260901064232_website_authentication_wait.sql
```

was replaced by the exact filename created by pinned `supabase@2.116.0` in the prepared Linux Node 24 environment:

```text
20260901071658_website_authentication_wait.sql
```

There is exactly one `*_website_authentication_wait.sql` migration in the source ledger.

## Pinned CLI evidence

The required command was run exactly through the prepared task-owned Linux volumes:

```text
docker run --rm \
  -v "$PWD:$PWD" \
  -v page2webmcp-auth-node-modules:"$PWD/node_modules" \
  -v page2webmcp-auth-pnpm-store:/pnpm/store \
  -w "$PWD" node:24.20.0-bookworm-slim \
  sh -lc 'corepack enable && pnpm exec supabase migration new website_authentication_wait'
```

Exact successful output:

```text
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.14.0.tgz
Created new migration at supabase/migrations/20260901071658_website_authentication_wait.sql
```

The same boundary reported the pinned CLI version:

```text
! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-10.14.0.tgz
2.116.0
```

Current Supabase CLI documentation still defines `supabase migration new <name>` as creating `supabase/migrations/<timestamp>_<name>.sql`; the current changelog contains no relevant breaking change to that command.

## SQL and ledger preservation

The CLI-created file was populated with the already-reviewed Task 12 SQL. Only the migration's own version reference changed from `20260901064232` to `20260901071658`.

This comparison returned exit 0 and no diff:

```text
git show 167796a:supabase/migrations/20260901064232_website_authentication_wait.sql \
  | sed 's/20260901064232/20260901071658/g' \
  | diff -u - supabase/migrations/20260901071658_website_authentication_wait.sql
```

The exact source-readiness ledger, local lifecycle sentinel, migration contract, local lifecycle fixtures, readiness regression, and Task 12 report now use `20260901071658`. The old version remains only in negative/provenance documentation and the regression that prevents reintroduction of the manual filename.

## TDD evidence

Before replacement, the migration test was changed to reject the manually timestamped file and run in Linux Node 24:

```text
docker run --rm \
  -v "$PWD:$PWD" \
  -v page2webmcp-auth-node-modules:"$PWD/node_modules" \
  -w "$PWD" node:24.20.0-bookworm-slim \
  node --experimental-transform-types --test \
  packages/database/src/website-authentication-wait-migration.test.ts

0 passed, 3 failed
```

All three failed for the intended assertion:

```text
the manually timestamped migration must be replaced by the pinned CLI output
actual: 20260901064232_website_authentication_wait.sql
```

After the CLI-created replacement and exact-ledger updates, the same test produced:

```text
3 passed, 0 failed
```

## Verification

Task 12 repository/migration suite in Linux Node 24:

```text
7 passed, 0 failed, 3 PostgreSQL environment-gated skips
```

Exact ledger and local lifecycle focused regression in Linux Node 24:

```text
5 passed, 0 failed, 0 skipped
```

The five active checks cover the pinned lifecycle declaration, old-only ledger rejection, status parsing through the pinned CLI boundary, executable-version drift rejection, and exact complete source ledger through the new website-authentication migration.

Static verification in `node:24.20.0-bookworm-slim`:

```text
node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
node node_modules/eslint/bin/eslint.js \
  packages/database/src/website-authentication-wait-migration.test.ts \
  scripts/check-release-readiness.ts scripts/local-supabase.mjs \
  test-support/local-supabase.test.ts test-support/readiness-cli.test.ts \
  --max-warnings=0
node scripts/lint-source.mjs
node scripts/check-source.mjs

all exit 0
```

`git diff --check` also exited 0.

## Files changed

- Renamed migration: `supabase/migrations/20260901064232_website_authentication_wait.sql` → `supabase/migrations/20260901071658_website_authentication_wait.sql`
- Exact ledger/sentinel: `scripts/check-release-readiness.ts`, `scripts/local-supabase.mjs`
- Regression contracts: `packages/database/src/website-authentication-wait-migration.test.ts`, `test-support/local-supabase.test.ts`, `test-support/readiness-cli.test.ts`
- Reports: `task-12-report.md`, this `task-12-fix-1-report.md`

The unrelated untracked `docs/superpowers/.DS_Store` remains untouched.

## Concerns

- This fix intentionally did not start, reset, or apply a local stack. PostgreSQL/RLS runtime verification remains the controller's immediate clean-stack task.
- The three PostgreSQL repository tests remain environment-gated in this commit; no database result is fabricated.
- The historical review diff and fix brief retain the old version as immutable provenance, not as an active ledger reference.
