# Task 11 fix round 1 report

## Status

All three blocking review findings are fixed in implementation commit `ebfef219b595aaaba12162573ff841168dd50bb3` (`fix: enforce alternate local readiness topology`). No prior migration or Tasks 1–9 plan text was modified. Nothing was pushed.

## Changes

- `scripts/check-release-readiness.ts`
  - Local-live application and maintenance database URLs now require an exact IP-literal loopback host with explicit PostgreSQL port `58322`.
  - Live non-loopback PostgreSQL URLs retain their existing behavior and may use a normal deployment-specific port.
  - Source readiness compares the discovered migration filenames with the complete exact 23-file ledger through `20260901060852_alternate_canonical_local_supabase_topology.sql`.
- `scripts/local-supabase.mjs`
  - Advanced the lifecycle migration sentinel from `20260830190000` to `20260901060852`.
- `test-support/readiness-cli.test.ts`
  - Added negative behavior coverage for old port `54322`, every other `5832x` port, `localhost`, and `127.0.0.2` for both database controls.
  - Preserved explicit `[::1]:58322` local behavior and non-loopback live database behavior.
  - Proved source readiness becomes false when the alternate-topology migration is absent or only the former partial sentinel set is present.
- `test-support/local-supabase.test.ts`
  - Proved an old-only ledger fails with `LOCAL_MIGRATION_LEDGER_INCOMPLETE` before CLI construction.
  - Updated successful lifecycle fixtures to contain the new required sentinel.

## RED evidence

Database port and source-ledger tests after the test-first additions and a behavior-preserving helper extraction:

```text
/usr/local/bin/node --experimental-transform-types --test \
  --test-name-pattern='local-live databases require|source readiness requires' \
  test-support/readiness-cli.test.ts

not ok 1 - local-live databases require exact IP-literal loopback port 58322
  actual: ARTIFACT_INTEGRITY_FAILED
  expected: LIVE_CONTROLS_REQUIRED with missingKeys [DATABASE_URL]
not ok 2 - source readiness requires the complete migration ledger through the alternate topology
  true !== false when 20260901060852 was removed
2 failed; exit 1
```

Lifecycle sentinel test before advancing `REQUIRED_MIGRATION`:

```text
/usr/local/bin/node --experimental-transform-types --test \
  --test-name-pattern='old-only migration ledger' \
  test-support/local-supabase.test.ts

not ok 1 - local lifecycle rejects an old-only migration ledger before constructing the CLI
  actual stdout: Migration ledger (1): 20260830190000_workflow_event_observability.sql
  expected stdout: empty
1 failed; exit 1
```

This demonstrated that the old-only ledger reached CLI construction rather than failing at the migration guard.

## GREEN evidence

Readiness behavior, including canonical local, retained live behavior, and positive local-live execution:

```text
/usr/local/bin/node --experimental-transform-types --test \
  --test-name-pattern='^(local-live databases require|source readiness requires|local-live runs its selected-provider topology diagnostics|live loads the exact selected-release context)' \
  test-support/readiness-cli.test.ts

4 passed, 0 failed; exit 0
```

Lifecycle sentinel and bootstrap topology behavior:

```text
/usr/local/bin/node --experimental-transform-types --test \
  --test-name-pattern='^(local Supabase lifecycle|local lifecycle rejects an old-only|runtime role bootstrap|owner bootstrap)' \
  test-support/local-supabase.test.ts

6 passed, 0 failed; exit 0
```

Forward migration contract:

```text
/usr/local/bin/node --experimental-transform-types --test \
  packages/database/src/local-artifact-topology-migration.test.ts

3 passed, 0 failed; exit 0
```

Static checks:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
/usr/local/bin/node node_modules/eslint/bin/eslint.js \
  scripts/check-release-readiness.ts scripts/local-supabase.mjs \
  test-support/readiness-cli.test.ts test-support/local-supabase.test.ts \
  --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check

all exit 0
```

## Concerns

- The host still stalls child processes that load the installed `tsx`/Darwin executable path. Focused tests used Node 22 native transform-types and excluded only the pre-existing CLI-spawn cases affected by that host condition; no result was fabricated.
- No Docker or live local stack was run in this narrowly scoped review fix.
- The unrelated untracked `docs/superpowers/.DS_Store` remains untouched.
