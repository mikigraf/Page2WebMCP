# Task 5 report: durable phased workflow substrate and controller

Implementation commit: `a8fe99f feat: add durable phased workflow substrate`

## Outcome

Task 5 adds a PostgreSQL-authoritative phased workflow substrate without replacing the proven `analysis_runs` / `analysis_jobs` queue. The existing analysis lifecycle now dual-writes source, snapshot, workflow run, compatibility task, monotonic events, exact evidence references, and canonical plan digests. The in-memory repository implements the same public transition contract for hermetic tests.

The generic controller owns every workflow state transition. Phase handlers and external providers receive bounded ports only; they cannot claim, heartbeat, complete, fail, wait, resume, cancel, verify, approve, publish, or install directly.

## Implementation

### Additive database substrate

`supabase/migrations/20260830120000_phased_workflow_substrate.sql` adds all required records:

- `project_sources` and `source_snapshots` retain immutable, content-addressed source identity.
- `workflow_runs`, private `workflow_tasks`, and `workflow_events` persist status, phase, hashes, references, wait metadata, cancellation, lease generation/owner/expiry, bounded attempts, retry classification, and monotonic sequence/version.
- `workflow_evidence` and `capability_plans` link exact existing analysis evidence/capability rows instead of copying authoritative bytes.
- `verification_checks` and `installations` provide bounded, tenant-linked phase output records for later phase adapters.
- Private `workflow_commands` records bounded command results and input hashes for transactional idempotency without persisting raw wait tokens.

The migration is additive and backfills existing project, analysis, task, event, evidence, and plan links. RLS, least-privilege grants, tenant/project composite foreign keys, legal-transition triggers, claim/lease indexes, and a security-definer monotonic event append function are included. Generic workflow task updates do not invoke the legacy analysis synchronization trigger.

Legacy `analysis_evidence` remains retention-bounded. A tenant-constrained detach trigger clears only the expiring legacy row pointer before deletion, preserving the immutable `urn:sha256` workflow reference and the existing release/evidence retention lock behavior.

### Repository and controller contract

`packages/database/src/workflow.ts` defines the single workflow contract:

- deterministic registry: preflight -> ownership -> browser auth -> explore -> propose -> review wait -> controlled mutation verification -> compile -> candidate verify -> publish -> install verify;
- exact run/task/event/source/evidence/plan records and repository methods;
- 60-second leases, serialized default 15-second heartbeats, three attempts, full-jitter exponential retry, and bounded five-minute Retry-After;
- stable side-effect keys, lease proof before new effects, lookup/execute/reconcile, and cleanup in `finally`;
- no fallback provider behavior and no second plan or workflow IR.

`packages/database/src/control-plane.ts` adds the deterministic in-memory implementation. It provides tenant-aware fair claiming and quotas, legal transitions, stale-generation rejection, waits that retain only token hashes, idempotent resume/cancel/completion/failure, cancellation-first propagation, expired-lease reconciliation, monotonic events, and analysis compatibility dual-writes.

`packages/database/src/postgres.ts` implements the same contract transactionally under existing app/worker RLS roles. Run-before-task lock order and per-tenant advisory claim locks make cancel-vs-claim/complete and two-worker quota decisions deterministic. Reconciliation requeues stale leases or repairs a missing next task without duplicating phases.

`apps/worker/src/runner.ts` now carries the claimed analysis lease generation through heartbeat, completion, and failure, so a stale worker cannot mutate the compatibility projection after reclaim.

## Files

- `supabase/migrations/20260830120000_phased_workflow_substrate.sql`
- `packages/database/src/workflow.ts`
- `packages/database/src/control-plane.ts`
- `packages/database/src/postgres.ts`
- `apps/worker/src/runner.ts`
- `packages/database/src/workflow.test.ts`
- `packages/database/src/workflow-migration.test.ts`
- `packages/database/src/postgres.integration.test.ts`

## Strict TDD evidence

The initial contract tests were written before `workflow.ts` existed:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow.test.ts
ERR_MODULE_NOT_FOUND: Cannot find module packages/database/src/workflow.ts
test files 1; pass 0; fail 1
```

After the first transition implementation, the controller heartbeat regression was added and run in isolation. It failed because no automatic task heartbeat event existed:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-name-pattern "controller serializes heartbeats" packages/database/src/workflow.test.ts
expected at least two task.heartbeat events; actual 0
tests 1; pass 0; fail 1
```

The PostgreSQL retention regression was observed against a fresh ephemeral PostgreSQL cluster before the final detach policy:

```text
Postgres integration: publication evidence locking serializes with retention cleanup
update or delete on table "analysis_evidence" violates foreign key constraint "workflow_evidence_evidence_id_fkey"
tests 5; pass 4; fail 1
```

The regression was fixed at the storage contract: the immutable digest/reference remains, while only the retention-bounded compatibility evidence ID detaches.

## Focused GREEN

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow.test.ts packages/database/src/workflow-migration.test.ts packages/database/src/control-plane.test.ts apps/worker/src/runner.test.ts
tests 33; pass 33; fail 0; skipped 0; duration 549 ms
```

The heartbeat test was hardened during full-suite verification to synchronize on two intentionally slow heartbeats and assert maximum concurrent heartbeats is exactly one. Its final focused run passed.

## Hermetic PostgreSQL evidence

A fresh local PostgreSQL cluster was initialized in `/tmp`, all repository migrations were applied in order, least-privilege `page2webmcp_app`, `page2webmcp_worker`, and maintenance roles were exercised through a `NOINHERIT` test login, and the integration suite was run with explicit test URLs. This is hermetic database evidence, not a live deployment claim.

```text
workflow substrate tables: 9/9
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/postgres.integration.test.ts
tests 5; pass 5; fail 0; skipped 0; duration 1068 ms
```

The suite covers the full legacy lifecycle, generic two-worker claim race, concurrent identical resume, cancel-vs-claim and cancel-vs-complete races, retry exhaustion, exact candidate/plan/evidence persistence, and retention/publication serialization.

## Full verification

The final implementation tree was run with the trusted TSX requested by the brief:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
tests 281; pass 275; fail 0; skipped 6; duration 3573 ms
```

Five of the ordinary-suite skips are the environment-gated PostgreSQL tests exercised separately above. The remaining skip is the existing separately launched production-route worker integration.

Direct gates all exited 0 on the implementation tree:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check
```

Production source audits found no `Acme` / fixture branch and no locale-sensitive sorting in the new workflow, database, migration, or worker paths. No provenance or quarantine metadata was changed.

## Self-review

- Confirmed all app operations are tenant-scoped and all worker mutations operate under the existing non-inheriting worker role.
- Confirmed lock order is workflow run before task/job across claim, heartbeat, completion, failure, cancellation, and reconciliation, preventing cancellation deadlock/inversion.
- Confirmed cancellation is persisted before task/job propagation and every lease mutation checks owner, expiry, and generation.
- Confirmed raw wait tokens are returned only once to the caller and only their SHA-256 hash is retained; concurrent resume is serialized by the run lock and replays the same task result.
- Confirmed event sequence/version are allocated under a locked workflow run, task phase/idempotency uniqueness prevents duplicate next tasks, and controller outputs are content-addressed references only.
- Confirmed analysis completion links the exact canonical plan digest and immutable evidence reference; diagnostic-only analysis never creates verify/publish/install workflow phases.
- Confirmed all canonical ordering added here is code-point based and production paths contain no source-name/default fixture branches.

## Concerns and deployment gates

- No managed PostgreSQL or production worker credentials were available. The migration and RLS contract passed a fresh hermetic PostgreSQL cluster, but staging must still rehearse the backfill against a production-shaped copy, monitor lock duration, and verify grants before rollout.
- No live browser, storage, publication, GitHub, callback, or installation provider was invoked. Those remain explicit idempotent ports and must fail closed until Task 6-8 adapters supply credentials, policy attestations, bounded cleanup, and reconciliation lookups.
- Raw wait tokens are intentionally non-reconstructable from durable state. A caller must retain the one-time value returned by the wait transition; resume is durable and idempotent, but a lost wait response requires an explicit product-level reissue flow rather than persisting a bearer credential.
- The compatibility `analysis_runs` / `analysis_jobs` queue remains authoritative for analysis while migration proceeds. Generic workflow phases are additive and intentionally do not drive the legacy synchronization trigger.
- Task 1's trusted-loader dependency remains: installation must verify artifact bytes/integrity before JavaScript evaluation.

## Fix round 1 (Task 5 independent review)

Implementation commit: `dc49e3f fix: enforce phased workflow contracts`

### Findings resolved

- The SQL substrate now carries the same single phase registry as the TypeScript controller through `private.workflow_next_phase`. Run insertion accepts only `analysis` for a linked legacy analysis or `preflight` for a generic workflow. A run phase can advance only to the exact adjacent phase after its predecessor task is `succeeded`.
- A task is immutable with respect to run/tenant/project/phase/idempotency/input identity. Generic tasks must begin queued; `preflight` must be first; every later task must match the run's exact current phase, have the exact adjacent succeeded predecessor, and consume that predecessor's exact output hash. Both app and worker direct grants remain usable by the repositories but cannot bypass these triggers.
- `WorkflowPhaseHandler` now has a discriminated failure result carrying a bounded error code, `permanent` / `rate_limited` / `transient` classification, and optional Retry-After only for rate limits. Deterministic configuration/validation/required/unsupported/policy failures map to permanent; unknown operational failures remain transient. Repository retry logic retains the five-minute Retry-After cap.
- The in-memory reconciler now mirrors PostgreSQL missing-next repair. It requires a succeeded non-analysis task, the exact adjacent current phase, no existing task for that phase, and uses the completed output hash as the new task input. Repeated reconciliation creates no duplicate.
- PostgreSQL reconciliation now moves the locked run to the adjacent phase before inserting the guarded next task, retaining one transaction and the same lock order.

### Strict RED evidence

The review regressions were added before the fixes and run together:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow-migration.test.ts packages/database/src/workflow.test.ts
tests 15; pass 11; fail 4
```

The four expected failures were independent:

```text
missing private.workflow_next_phase / SQL phase-guard triggers
missing-next reconciliation: expected 1 repair, actual 0
deterministic configuration error: expected failed/permanent, actual queued/transient
typed rate-limit result: expected queued/rate_limited, actual succeeded
```

The PostgreSQL regression directly attempts the forbidden `preflight -> publish` run update and fabricated `publish` task insert under both `page2webmcp_app` and `page2webmcp_worker`; all four operations must fail with SQLSTATE `23514`.

### GREEN and parity evidence

Focused final run:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow-migration.test.ts packages/database/src/workflow.test.ts
tests 15; pass 15; fail 0; skipped 0; duration 728 ms
```

Affected repository/worker run:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow.test.ts packages/database/src/workflow-migration.test.ts packages/database/src/control-plane.test.ts packages/database/src/postgres.integration.test.ts apps/worker/src/runner.test.ts
tests 41; pass 36; fail 0; skipped 5; duration 372 ms
```

Fresh hermetic PostgreSQL migrations and integration, including app/worker direct-grant rejection and PostgreSQL missing-next repair:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/postgres.integration.test.ts
tests 5; pass 5; fail 0; skipped 0; duration 1031 ms
```

Full trusted suite on the final implementation tree:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
tests 284; pass 278; fail 0; skipped 6; duration 4841 ms
```

Direct gates all exited 0 on the same implementation tree:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check
```

The production source audit again found no locale-sensitive sort and no Acme/fixture branch in the new workflow, database, migration, or worker paths.

### Residual deployment limits

- The PostgreSQL checks are from a fresh local hermetic cluster, not a managed deployment. Staging must still rehearse the migration/backfill and grants with production-shaped data.
- Phase handlers now have the complete classified-failure contract, but live provider adapters remain later work and must deliberately classify only proven retryable failures as transient.
- Existing one-time wait-token and trusted-loader installation constraints remain unchanged from the original Task 5 report.

## Fix round 2 (Task 5 rereview)

Implementation commit: `d8bd3a5 fix: reject illegal initial workflow state`

### Finding resolved

- `private.enforce_workflow_run_phase` now rejects every runtime insert that does not begin queued with version `0`, next event sequence `1`, and empty cancellation/error state. This applies equally to direct `page2webmcp_app` and `page2webmcp_worker` grants.
- `private.enforce_workflow_task_phase` now validates the complete initial execution state before its legacy-analysis branch: queued status, zero attempts/lease generation, no lease, outputs, checkpoint, wait, resume, cancellation, retry, error, or reconciliation metadata. The legacy branch can no longer return early around these checks.
- The INSERT/phase triggers are installed after the one-time compatibility backfill. Historical analysis rows may therefore be mirrored in their real terminal, leased, cancelled, or retried states, while every repository-created row after migration is subject to the stricter runtime contract.
- PostgreSQL missing-next reconciliation now inserts a pristine queued task through the guard and marks it reconciled in a subsequent update in the same transaction. This preserves the existing exact predecessor/output-hash and idempotency behavior.

### Strict RED evidence

The focused static contract was added first and failed before implementation:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow-migration.test.ts
tests 1; pass 0; fail 1
missing /illegal initial workflow run state/
```

The direct-role behavioral regression was then run against a fresh PostgreSQL cluster. Before the guards, an illegal initial run insert fulfilled instead of failing:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-name-pattern "Postgres phased workflow" packages/database/src/postgres.integration.test.ts
tests 1; pass 0; fail 1
expected rejected; actual fulfilled
```

The regression attempts status-, version-, event-sequence-, and cancellation-seeded workflow run inserts under both direct roles. It also deletes a compatibility task as the migration owner and proves that both direct roles cannot reinsert an `analysis` task with terminal status and populated counters; every attempt must fail with SQLSTATE `23514`.

### GREEN and migration evidence

Focused contract/controller run:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow-migration.test.ts packages/database/src/workflow.test.ts
tests 15; pass 15; fail 0; skipped 0; duration 333 ms
```

A fresh hermetic PostgreSQL cluster applied every migration and the compatibility backfill before running the direct-role suite:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/postgres.integration.test.ts
tests 5; pass 5; fail 0; skipped 0; duration 870 ms
```

The local bootstrap explicitly created `pgcrypto`, which the managed Supabase environment provides, before applying repository migrations. An additional production-topology launch was attempted after the completed database suite but hit the already documented local untrusted-`tsx` worker startup timeout; it is separately environment-gated in the trusted full suite and does not affect the five completed PostgreSQL tests.

Affected repository/worker run:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/database/src/workflow.test.ts packages/database/src/workflow-migration.test.ts packages/database/src/control-plane.test.ts packages/database/src/postgres.integration.test.ts apps/worker/src/runner.test.ts
tests 41; pass 36; fail 0; skipped 5; duration 454 ms
```

Full trusted suite:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
tests 284; pass 278; fail 0; skipped 6; duration 4064 ms
```

Direct gates all exited `0`:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check
```

### Fix-round self-review and residuals

- Confirmed the raw app/worker grants remain usable for every legal repository insert and that RLS, transition triggers, immutable task identity, predecessor adjacency, one-active-run uniqueness, and legacy job synchronization are unchanged.
- Confirmed compatibility rows are the only inserts allowed to bypass runtime initial-state guards, and only while the migration is applying before the triggers are created.
- Confirmed reconciler task creation and its `reconciled_at` update remain in one transaction and retain run-before-task lock order.
- No managed deployment was changed. Staging still needs a production-shaped migration/backfill rehearsal; all pre-existing provider, wait-token, and trusted-loader deployment limits remain unchanged.
