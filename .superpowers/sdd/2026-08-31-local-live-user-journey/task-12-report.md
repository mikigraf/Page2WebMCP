# Task 12 report: durable website authentication wait state

## Status

Implemented and committed in `531f391ddc01de3efd79658947350a3e8b8cbade` (`feat(database): persist website authentication waits`). The worker repository can now atomically release a running website analysis into a durable authentication wait, and an owner/editor can atomically resume the exact run only with a bounded gateway-attested evidence reference.

Fix round 1 subsequently replaced the unapplied manually timestamped migration with the exact pinned-CLI-created `20260901071658_website_authentication_wait.sql`. The reviewed SQL is byte-for-byte identical after substituting only the required migration version references.

The controller subsequently created the isolated Page2WebMCP stack on the
canonical `5832x` ports with pinned CLI `2.116.0`, replayed all 24 migrations,
and ran the PostgreSQL tests through distinct least-privilege app and worker
login URLs plus the local owner cleanup URL. All three database/RLS tests pass.

## Schema and API decisions

- Added forward migration `20260901071658_website_authentication_wait.sql`; no migration predating Task 12 was edited.
- Added `waiting` to the public analysis-run and private analysis-job state constraints and updated the private job-state projection so the public run becomes `waiting` while the project remains `analyzing`.
- Added private, forced-RLS `website_authentication_checkpoints`, bound by composite foreign keys to organization, project, analysis run, workflow analysis task, and source snapshot. The record additionally binds the source identity hash, target-origin digest, a maximum ten-minute expiry, and exact lowercase SHA-256 URNs.
- The table stores no Browser Use URL, CDP URL, provider session ID, cookie, credential, token, OTP, target-page content, or KMS secret. App reads are tenant scoped; owner/editor may perform the evidence-backed resume transition; the worker owns wait and terminal transitions. `PUBLIC`, `anon`, `authenticated`, `service_role`, and maintenance retain no table privilege.
- Exported `WaitAnalysisForAuthenticationInput`, `ResumeAnalysisAfterAuthenticationInput`, `WebsiteAuthenticationCheckpointRecord`, and the safe optional `WebsiteAuthenticationClaimCheckpoint` carried by `ClaimedAnalysisRunRecord`.
- Worker wait is one transaction ordered from workflow run to analysis job, workflow task, then checkpoint. It validates the current website lease/source/origin, persists the checkpoint, moves the four run/task records to waiting, clears leases, and appends `task.waiting`.
- Owner/editor resume is one transaction with the same lock order. It requires exact evidence/source/origin/checkpoint bindings, consumes the checkpoint idempotently, queues the four run/task records at `now()`, and appends `task.resumed`. Viewer and cross-tenant access fail closed.
- Claim revalidates the consumed checkpoint against the persisted task, source snapshot, source identity, target origin, evidence, and expiry, and returns only the safe typed subset.
- Completion, permanent failure, cancellation, retry exhaustion, and expiry reconciliation close active checkpoint state exactly once. Expiry reconciliation fails the wait without requeueing.
- The in-memory repository implements the same state transitions, authorization, replay, claim, and terminal behavior.
- Advanced the exact readiness/local lifecycle migration ledger and corresponding regression fixtures to the new migration.

## Files changed

- Repository contract and in-memory implementation: `packages/database/src/control-plane.ts`
- PostgreSQL implementation: `packages/database/src/postgres.ts`
- Migration: `supabase/migrations/20260901071658_website_authentication_wait.sql`
- Tests: `packages/database/src/website-authentication-wait.test.ts`, `packages/database/src/website-authentication-wait-migration.test.ts`, `packages/database/src/website-authentication-wait.integration.test.ts`
- Ledger/lifecycle: `scripts/check-release-readiness.ts`, `scripts/local-supabase.mjs`, `test-support/readiness-cli.test.ts`, `test-support/local-supabase.test.ts`

The unrelated untracked `docs/superpowers/.DS_Store` was not modified or committed.

## RED evidence

Tests were added before implementation, then run with:

```text
/usr/local/bin/node --experimental-transform-types --test \
  packages/database/src/website-authentication-wait.test.ts \
  packages/database/src/website-authentication-wait-migration.test.ts \
  packages/database/src/website-authentication-wait.integration.test.ts
```

Observed result before implementation:

```text
7 failed, 0 passed, 3 PostgreSQL tests skipped
```

The failures were the missing forward migration and missing repository methods, including `repository.waitAnalysisForAuthentication is not a function`. The PostgreSQL cases were already present but skipped because the two explicit test database URLs were absent.

## GREEN evidence

Focused durable-authentication suite after implementation:

```text
/usr/local/bin/node --experimental-transform-types --test \
  packages/database/src/website-authentication-wait.test.ts \
  packages/database/src/website-authentication-wait-migration.test.ts \
  packages/database/src/website-authentication-wait.integration.test.ts

7 passed, 0 failed, 3 PostgreSQL tests skipped; exit 0
```

The active tests cover in-memory atomic wait/lease release, idempotency, authorization, exact evidence claim, rollback, completion, permanent failure, cancellation, expiry, migration constraints, exact FKs/indexes, forced RLS/grants, secret-column denial, and exact-ledger advancement. The three PostgreSQL tests cover four-record atomicity and rollback, exact resumed claim, viewer/tenant/source/replay behavior, terminal transitions, exact-once expiry reconciliation, and live privilege/no-secret-column inspection when supplied a disposable migrated database.

Static verification:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js \
  packages/database/src/control-plane.ts packages/database/src/postgres.ts \
  packages/database/src/website-authentication-wait.test.ts \
  packages/database/src/website-authentication-wait-migration.test.ts \
  packages/database/src/website-authentication-wait.integration.test.ts \
  scripts/check-release-readiness.ts scripts/local-supabase.mjs --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check

all exit 0
```

The combined readiness/local-lifecycle regression was bounded rather than claimed green. It emitted 13 passing subtests, then the host stalled inside the pre-existing temporary fake-`pnpm` subprocess used by `local-supabase.test.ts`; the runner was terminated without a final TAP summary.

## Pinned Supabase CLI evidence

The repository remains pinned to `supabase@2.116.0` and uses `pnpm exec`. The required real migration creation command was invoked exactly once with a 20-second bound:

```text
/opt/homebrew/bin/gtimeout --signal=TERM --kill-after=2s 20s \
  pnpm exec supabase migration new website_authentication_wait

exit 124; no output; no migration file created
```

The host CLI stalled as anticipated. The migration was then created with `apply_patch` using the captured UTC attempt timestamp `20260901064232`. This is not reported as successful CLI generation.

Fix round 1 addressed that historical limitation through the prepared Linux Node 24 boundary. Pinned `supabase@2.116.0` reported:

```text
Created new migration at supabase/migrations/20260901071658_website_authentication_wait.sql
```

The unapplied manual file was removed, and all active ledger/sentinel/test references now use the CLI-created version.

## Concerns

- The broader readiness/local lifecycle runner did not complete because its existing fake executable stalled on this host. Its partial passes are recorded only as partial evidence.
- Host `node`/`pnpm` shebang resolution stalls; successful focused tests and static checks used `/usr/local/bin/node` 22.14.0 directly. The controller still needs the requested Node 24 Docker verification.
- No external gateway or Browser Use session is created by this substrate task. The checkpoint accepts only an opaque digest-bound reference and exact gateway evidence reference; gateway production integration remains a follow-up consumer.

## Docker PostgreSQL acceptance — 2026-09-01

- Pinned `supabase@2.116.0` replayed all 24 migrations through
  `20260901071658_website_authentication_wait.sql` on API `58321` and database
  `58322`.
- The role bootstrap now uses typed `format` parameters, a serialized catalog
  existence check instead of a duplicate-role exception, tenant-safe replay
  clauses, and exhaustive postcondition checks. It succeeded twice
  consecutively. Credentials that appeared in the local database's expected
  duplicate-error log were immediately rotated and are no longer valid; no
  credential value is recorded here.
- Worker snapshot reads bind the exact workflow lease context before RLS
  evaluation. Resumed claims activate the task, bind its new lease generation,
  and only then revalidate the checkpoint's immutable snapshot.
- App resume no longer writes the ungranted workflow-task `error_code` column;
  that field was already cleared by the wait transition.
- The integration harness requires and queries separate app, worker, and owner
  sessions when split-role URLs are supplied. It asserts both `current_user`
  and `session_user`, so an owner-capable connection cannot silently satisfy a
  least-privilege test run. The generic database-URL fallback was removed: the
  operational handoff cases skip unless both explicit runtime URLs are present.
- Independent review found and closed three runtime-bootstrap gaps: base
  application-role checks now reject `CREATEDB`, `CREATEROLE`, and
  `REPLICATION`; the session advisory lock remains held through the atomic
  credential-file rename; and the live integration proves the three database
  identities rather than comparing connection-string text alone.

```text
PostgreSQL website authentication integration: 4 passed, 0 skipped, 0 failed
Focused runtime-role bootstrap tests: 5 passed, 0 skipped, 0 failed
Typecheck, targeted ESLint, source lint, security policy, diff check: passed
```
