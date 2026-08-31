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

## Fix round 3: schema-qualified pgcrypto calls

### Root cause and minimal fix

The PostgreSQL 17 replay installs `pgcrypto` in the Supabase `extensions`
schema. The migration-session search path is not guaranteed to include that
schema, but the workflow and source-configuration migrations invoked bare
`digest()`. The configuration used for API `extra_search_path` is not a safe
migration dependency.

The migration-wide RED scan found five actual bare call sites: four in
`20260830120000_phased_workflow_substrate.sql` and one in
`20260831090000_source_configuration.sql`. Each now uses
`extensions.digest(...)`; hash inputs and algorithms are unchanged.

### TDD evidence

Added `pgcrypto calls in replayed migrations are schema-qualified (catches
relying on the migration session search path)`. It scans every SQL migration
and fails if a `digest(` call is not schema-qualified.

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

Result: `3/4` passed; the new test failed with the four workflow migration
filenames and one source-configuration migration filename as unqualified
`digest()` call sites.

GREEN: the same command passed, `4/4` tests, and the following direct scan
returned no results:

```sh
rg -nP "(?<![[:alnum:]_.])digest\\s*\\(" supabase/migrations
```

### PostgreSQL 17 lexical replay

This fresh no-host-port container had the same minimal Supabase prerequisites
as the previous replay rounds and was removed by the `--rm` cleanup trap:

```sh
docker run --rm -d --name page2webmcp-migration-replay-round3-48475 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
for migration in $(rg --files supabase/migrations | sort); do
  docker exec -i page2webmcp-migration-replay-round3-48475 \
    psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
done
```

Result: PostgreSQL `17.11 (Debian 17.11-1.pgdg13+2)` replayed all `16/16`
migrations successfully, including both repaired migration files.

### Round-3 verification

The full migration-contract compilation/test command from round 2 passed
`20/20` tests. The following commands all exited 0:

```sh
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node \
  node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node scripts/check-source.mjs
git diff --check
```

Round-3 commit command:

```sh
git add supabase/migrations/20260830120000_phased_workflow_substrate.sql \
  supabase/migrations/20260831090000_source_configuration.sql \
  packages/database/src/trusted-release-installations-migration.test.ts
git add -f .superpowers/sdd/2026-08-31-local-live-user-journey/task-10-migration-fix-report.md
git commit -m "fix: qualify migration pgcrypto calls"
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

## Fix round 4: upgrade compatibility and Supabase-style pgcrypto fixture

### Root cause and minimal fix

Moving `releases_id_project_org_key` into the already-versioned
`20260830094622_trusted_release_installations.sql` repaired fresh replay but
removed the only creation of that named key from the next migration. A database
that already recorded the older form of `20260830094622` therefore would not
execute the newly inserted statement and could reach the workflow installation
composite FK without the expected named tenant key.

Fresh replay still creates the key unconditionally in `20260830094622`. The
start of `20260830120000_phased_workflow_substrate.sql` now also checks
`pg_catalog.pg_constraint` for that key on `public.releases` and creates it only
when absent. Neither the trusted release-installation composite FK nor the later
workflow-installation composite FK was removed or weakened.

The migration contract now:

- proves the strengthened `verification_runs_eligibility_check` is restored
  after the legacy `eligible = false` backfill;
- requires every observed migration `digest(...)` invocation, including bare,
  quoted-schema, and unquoted-schema forms, to resolve through `extensions`;
- requires the later migration's catalog-guarded compatibility key to precede
  its composite release FK while retaining the fresh-replay assertion.

The standalone local RLS harness now creates the Supabase-style `extensions`
schema and installs `pgcrypto` into it with `WITH SCHEMA extensions`.

### TDD RED evidence

The compatibility contract was added before the migration fix and run with:

```sh
scratch_dir=$(mktemp -d /tmp/page2webmcp-migration-round4-red.XXXXXX)
mkdir -p "$scratch_dir/packages/database/src"
ln -s "$PWD/supabase" "$scratch_dir/supabase"
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node node_modules/typescript/bin/tsc \
  --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck \
  --rootDir packages/database/src --outDir "$scratch_dir/packages/database/src" \
  packages/database/src/trusted-release-installations-migration.test.ts
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test \
  "$scratch_dir/packages/database/src/trusted-release-installations-migration.test.js"
```

Result: `5/6` passed. The partial-upgrade test alone failed with `the later
workflow migration catalog-guards the compatibility key`.

The two strengthened existing-behavior contracts were mutation-checked after
the test changes but before the production fix. Temporarily renaming the
restored eligibility constraint, then running:

```sh
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test \
  --test-name-pattern="restores the eligibility constraint" \
  "$scratch_dir/packages/database/src/trusted-release-installations-migration.test.js"
```

failed `0/1` with `the eligibility constraint is restored`. Temporarily changing
one call from `extensions.digest` to `public.digest`, then running:

```sh
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test \
  --test-name-pattern="pgcrypto digest calls" \
  "$scratch_dir/packages/database/src/trusted-release-installations-migration.test.js"
```

failed `0/1` and reported exactly:

```text
{
  file: '20260830120000_phased_workflow_substrate.sql',
  schema: 'public'
}
```

Both temporary mutations were restored before implementation.

The behavioral local-harness RED command was:

```sh
PAGE2WEBMCP_NATIVE_TYPESCRIPT_TESTS=true \
PAGE2WEBMCP_NODE_BINARY=/usr/local/bin/node \
  bash scripts/test-rls-local.sh
```

Result: the disposable PostgreSQL instance failed at the first workflow digest
with `ERROR: schema "extensions" does not exist`, proving that the old harness
installed pgcrypto into the wrong schema for the replayed migrations.

### Focused and migration-contract GREEN evidence

After the guarded compatibility block and fixture correction, the focused
compile/test command above passed `6/6` tests. The full migration-contract suite
used:

```sh
scratch_dir=$(mktemp -d /tmp/page2webmcp-migration-contracts-round4.XXXXXX)
mkdir -p "$scratch_dir/packages/database/src"
ln -s "$PWD/supabase" "$scratch_dir/supabase"
rg --files packages/database/src -g '*migration.test.ts' | sort | xargs \
  env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node node_modules/typescript/bin/tsc \
    --module NodeNext --moduleResolution NodeNext --target ES2022 --esModuleInterop --skipLibCheck \
    --rootDir packages/database/src --outDir "$scratch_dir/packages/database/src"
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test \
  "$scratch_dir"/packages/database/src/*migration.test.js
```

Result: `24/24` tests passed.

Re-running the local RLS command after installing pgcrypto into `extensions`
successfully replayed the targeted workflow migration and all migrations through
`20260831090000_source_configuration.sql`. The overall script then stopped at a
separate pre-existing standalone-fixture gap:

```text
psql:supabase/migrations/20260831100000_release_artifact_storage.sql:11:
ERROR: relation "storage.buckets" does not exist
```

No Storage fixture expansion was made in this round because the requested
change was specifically the pgcrypto/Supabase extension layout. The ephemeral
local cluster was removed by the script's cleanup trap.

### Fresh PostgreSQL 17 lexical replay

A new `postgres:17` container with no host port binding was bootstrapped with
the same minimal Supabase-owned prerequisites used by the prior replay rounds:

```sh
set -euo pipefail
replay_container="page2webmcp-migration-r4-fresh-$$"
cleanup_replay() {
  docker stop "$replay_container" >/dev/null 2>&1 || true
}
trap cleanup_replay EXIT
docker run --rm -d --name "$replay_container" \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec "$replay_container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$replay_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  create schema extensions;
  create extension pgcrypto with schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key, email text not null, email_confirmed_at timestamptz);
  create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id), not_after timestamptz);
  create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create role anon nologin;
  create role authenticated nologin;
" >/dev/null
migration_count=0
for migration in supabase/migrations/*.sql; do
  docker exec -i "$replay_container" \
    psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
  migration_count=$((migration_count + 1))
done
```

The catalog verification returned:

```text
server_version=17.11 (Debian 17.11-1.pgdg13+2)
migration_count=16
pgcrypto_schema=extensions
release_key_count=1
eligibility_check_count=1
release_tenant_fk_count=2
```

Thus all `16/16` migrations replayed lexically, the eligibility check and named
tenant key were present, and both composite release tenant FKs remained.

### Simulated partial-upgrade PostgreSQL 17 replay

A second new no-host-port PostgreSQL 17 container was bootstrapped identically.
The first seven migrations were replayed through
`20260830094622_trusted_release_installations.sql`. To simulate an already
recorded migration whose named key is absent without weakening its existing
composite FK, its equivalent unique constraint was renamed to its legacy name:

```sh
before_upgrade_count=0
for migration in supabase/migrations/*.sql; do
  docker exec -i "$upgrade_container" \
    psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
  before_upgrade_count=$((before_upgrade_count + 1))
  if [[ "$(basename "$migration")" == "20260830094622_trusted_release_installations.sql" ]]; then
    break
  fi
done
docker exec "$upgrade_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  alter table public.releases
    rename constraint releases_id_project_org_key to legacy_releases_id_project_org_key;
" >/dev/null
```

Pre-upgrade catalog state:

```text
pre_upgrade_migration_count=7
pre_upgrade_named_key_count=0
pre_upgrade_release_installation_fk_count=1
```

The later migration and every remaining migration were then applied:

```sh
after_upgrade_count=0
apply_remaining=false
for migration in supabase/migrations/*.sql; do
  if [[ "$(basename "$migration")" == "20260830120000_phased_workflow_substrate.sql" ]]; then
    apply_remaining=true
  fi
  if [[ "$apply_remaining" == "true" ]]; then
    docker exec -i "$upgrade_container" \
      psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$migration"
    after_upgrade_count=$((after_upgrade_count + 1))
  fi
done
```

Post-upgrade catalog verification returned:

```text
server_version=17.11 (Debian 17.11-1.pgdg13+2)
post_upgrade_migration_count=9
post_upgrade_named_key_count=1
post_upgrade_eligibility_check_count=1
post_upgrade_release_tenant_fk_count=2
```

The catalog guard therefore exercised its creation branch and the full upgrade
path retained both composite FKs. The `--rm` cleanup traps removed both replay
containers; no existing container was stopped or reused.

### Round-4 verification

```sh
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node \
  node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node scripts/check-source.mjs
bash -n scripts/test-rls-local.sh
git diff --check
```

Result: typecheck, source security policy, shell syntax, and diff checks all
exited 0.

Round-4 commit command:

```sh
git add packages/database/src/trusted-release-installations-migration.test.ts \
  scripts/test-rls-local.sh \
  supabase/migrations/20260830120000_phased_workflow_substrate.sql
git add -f .superpowers/sdd/2026-08-31-local-live-user-journey/task-10-migration-fix-report.md
git diff --cached --check
git commit -m "fix: preserve migration upgrade compatibility"
git rev-parse HEAD
```
