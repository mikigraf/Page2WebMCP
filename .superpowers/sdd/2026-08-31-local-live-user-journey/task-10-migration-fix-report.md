# Task 10: Trusted Installation Migration Replay Fix

## Scope

Changed only `supabase/migrations/20260830094622_trusted_release_installations.sql`
and its focused migration-contract test. `docs/superpowers/.DS_Store` was
pre-existing and deliberately left untouched.

## Root cause and minimal fix

1. The legacy re-verification backfill sets `verification_runs.eligible = false`
   while the pre-existing `verification_runs_eligibility_check` still enforces
   the old equality predicate. PostgreSQL validates that existing constraint on
   the UPDATE, so clean replay fails. The migration now drops that constraint
   immediately after adding the new columns and recreates the strengthened
   predicate after the backfill.
2. PostgreSQL derives `release_installations_status_check` for the unnamed
   inline `status` check. That collided with the later, explicit table-level
   `release_installations_status_check`. The inline condition is preserved and
   now has the distinct stable name `release_installations_status_value_check`.

## TDD evidence

Added `packages/database/src/trusted-release-installations-migration.test.ts`.
The tests name the production mutations they catch: moving the old constraint
drop below the legacy UPDATE, and restoring PostgreSQL's colliding auto-name.

RED command (the direct Node 22 + TypeScript compile path was necessary because
the machine's configured Homebrew Node 24 binary hangs even for `node --version`):

```sh
scratch_dir=$(mktemp -d /tmp/page2webmcp-trusted-migration-test.XXXXXX)
mkdir -p "$scratch_dir/packages/database/src"
ln -s "$PWD/supabase" "$scratch_dir/supabase"
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node node_modules/typescript/bin/tsc \
  --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck \
  --rootDir packages/database/src --outDir "$scratch_dir/packages/database/src" \
  packages/database/src/trusted-release-installations-migration.test.ts
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test "$scratch_dir/packages/database/src/trusted-release-installations-migration.test.js"
```

Result: 2 tests failed as intended: the legacy drop was after the UPDATE, and
the inline check had no distinct explicit name. Re-running after the SQL fix
passed, `2/2` tests.

Affected migration-contract suite command:

```sh
rg --files packages/database/src -g '*migration.test.ts' | sort | xargs \
  env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node node_modules/typescript/bin/tsc \
    --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck \
    --rootDir packages/database/src --outDir "$scratch_dir/packages/database/src"
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test \
  "$scratch_dir"/packages/database/src/*migration.test.js
```

Result: `18/18` tests passed.

## Disposable PostgreSQL 17 replay

No existing containers were stopped or reused; the isolated container had no
host port binding.

```sh
docker run --rm -d --name page2webmcp-migration-replay-3031 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
docker exec page2webmcp-migration-replay-3031 pg_isready -U postgres -d postgres
docker exec page2webmcp-migration-replay-3031 psql -U postgres -d postgres -Atqc 'show server_version;'
```

Result: PostgreSQL `17.11 (Debian 17.11-1.pgdg13+2)`.

The isolated instance was bootstrapped only with minimal Supabase-owned
prerequisites (`auth.users`, `auth.sessions`, `auth.uid`, `storage.buckets`,
`anon`, `authenticated`, and `pgcrypto` in `extensions`), then every migration
was replayed in lexical order using:

```sh
for migration in $(rg --files supabase/migrations | sort); do
  docker exec -i page2webmcp-migration-replay-3031 \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
done
```

Result: replay passed through the repaired legacy UPDATE and the named inline
constraint, then stopped at a separate later failure in the same migration:

```text
ERROR: there is no unique constraint matching given keys for referenced table "releases"
REPLAY_FAILED supabase/migrations/20260830094622_trusted_release_installations.sql
```

This occurs when creating `release_installations_release_tenant_fk`, which
references `public.releases(id, project_id, organization_id)` before that exact
tuple has a unique constraint. Per task scope, this later failure was reported
and not changed. Cleanup used `docker stop page2webmcp-migration-replay-3031`;
the `--rm` container no longer exists.

## Final verification

```sh
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node scripts/check-source.mjs
git diff --check
```

Result: all three commands exited successfully. A direct `pnpm typecheck`
attempt was terminated after its `tsc` shim stalled under the unusable Node 24
runtime; the direct TypeScript compiler command above is the successful
typecheck evidence.

## Commit

```sh
git add supabase/migrations/20260830094622_trusted_release_installations.sql \
  packages/database/src/trusted-release-installations-migration.test.ts \
  .superpowers/sdd/2026-08-31-local-live-user-journey/task-10-migration-fix-report.md
git commit -m "fix: make trusted installation migration replayable"
git rev-parse HEAD
```

Result: recorded in the task handoff after the commit command completes.

## Fix round 2: release tenant-key ordering

### Root cause and minimal fix

`release_installations_release_tenant_fk` is a composite foreign key to
`public.releases(id, project_id, organization_id)`. The named supporting
unique constraint, `releases_id_project_org_key`, was defined only in the
later lexical migration `20260830120000_phased_workflow_substrate.sql`.
PostgreSQL requires a matching unique key when a foreign key is created, so
the earlier trusted-installation migration cannot replay cleanly.

The composite foreign key remains unchanged. The minimal change moves the
named unique constraint into `20260830094622_trusted_release_installations.sql`
immediately before `release_installations` is created and removes the later
duplicate definition.

### TDD evidence

Added a third test to `trusted-release-installations-migration.test.ts`:
`trusted installation migration creates the release tenant key before its
composite foreign key (catches leaving the key in the later workflow
migration)`.

RED command:

```sh
scratch_dir=$(mktemp -d /tmp/page2webmcp-trusted-migration-test.XXXXXX)
mkdir -p "$scratch_dir/packages/database/src"
ln -s "$PWD/supabase" "$scratch_dir/supabase"
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node node_modules/typescript/bin/tsc \
  --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck \
  --rootDir packages/database/src --outDir "$scratch_dir/packages/database/src" \
  packages/database/src/trusted-release-installations-migration.test.ts
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test "$scratch_dir/packages/database/src/trusted-release-installations-migration.test.js"
```

Result: `2/3` passed and the new test failed as intended with `the referenced
release tenant key is created in this migration`.

GREEN: the same command passed, `3/3` tests.

### PostgreSQL 17 lexical replay

The replay used a new, no-host-port container and the same minimal Supabase
prerequisites as round 1:

```sh
docker run --rm -d --name page2webmcp-migration-replay-round2-27504 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
for migration in $(rg --files supabase/migrations | sort); do
  docker exec -i page2webmcp-migration-replay-round2-27504 \
    psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
done
```

Result: PostgreSQL `17.11` replay passed the repaired trusted-installation
migration and the following workflow migration, then stopped at:

```text
ERROR: function digest(text, unknown) does not exist
REPLAY_FAILED supabase/migrations/20260830120000_phased_workflow_substrate.sql
```

The fresh fixture installs `pgcrypto` in the Supabase-style `extensions`
schema, while the later migration invokes unqualified `digest()` and the bare
PostgreSQL database default search path does not include `extensions`. This is
a newly reached environment/prerequisite blocker in the next migration, not a
reason to weaken or alter the trusted-installation tenant foreign key. The
round-2 disposable container was automatically removed by its `--rm` cleanup
trap. No further migration changes were made in this round.

### Round-2 verification

Focused migration-contract suite:

```sh
scratch_dir=$(mktemp -d /tmp/page2webmcp-migration-contract-tests.XXXXXX)
mkdir -p "$scratch_dir/packages/database/src"
ln -s "$PWD/supabase" "$scratch_dir/supabase"
rg --files packages/database/src -g '*migration.test.ts' | sort | xargs \
  env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node node_modules/typescript/bin/tsc \
    --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck \
    --rootDir packages/database/src --outDir "$scratch_dir/packages/database/src"
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test \
  "$scratch_dir"/packages/database/src/*migration.test.js
```

Result: `19/19` passed.

```sh
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node \
  node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node scripts/check-source.mjs
git diff --check
```

Result: typecheck, source security policy, and diff check all exited 0.

Round-2 commit command:

```sh
git add supabase/migrations/20260830094622_trusted_release_installations.sql \
  supabase/migrations/20260830120000_phased_workflow_substrate.sql \
  packages/database/src/trusted-release-installations-migration.test.ts
git add -f .superpowers/sdd/2026-08-31-local-live-user-journey/task-10-migration-fix-report.md
git commit -m "fix: order release tenant key before installation FK"
git rev-parse HEAD
```
