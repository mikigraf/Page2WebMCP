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
