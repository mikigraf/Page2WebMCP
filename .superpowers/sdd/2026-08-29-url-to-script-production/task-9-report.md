# Task 9 implementation report

## Outcome

Implemented the Task 9 UI/presentation, authoritative workflow observability, product funnel, metrics/alerts, executable golden matrix, promotion readiness/version-drift gate, and incident recovery runbook. All live-only claims remain fail closed: the hermetic readiness result explicitly reports `liveSuccess: false`, and absent live controls produce `LIVE_CONTROLS_REQUIRED` with exit 2.

## Implementation

- Added pure, deterministic capability/workflow presentation for ownership, browser-auth wait, review/version conflicts, cancellation/retry/failure, unsupported diagnostics, verification, immutable release, self-host, and installed states. The client renders the exact canonical plan digest/version, schemas, auth/scopes/CSRF, effects/risk/confirmation/reversibility, idempotent request plan, and immutable evidence refs; it exposes candidate verification, publish, copy-script, exact download, self-host URL, and installed-target verification without claiming installation before attestation.
- Extended the workflow event contract with lease-scoped `task.side_effect_started|completed|failed` events. Both repositories emit bounded operation/input-output hashes/version/cost/latency/outcome, and the SQL migration validates exact JSON shape and requires the active worker/task/lease context before insert. Workflow status reconstructs tasks, events, evidence, plans, diagnostics, and exact capability reviews from one run ID.
- Added ordered, bounded (100 observation) redacted workflow telemetry projection with workflow/task parentage and fail-open non-authoritative export. Added the six-event product funnel through verified installation, pseudonymous actor/org UUID grouping, no profiles/autocapture/replay, and SDK-buffered PostHog capture. Production funnel routes supply fresh actor/org identity.
- Added deterministic metrics/alerts for queue depth/age, leases, retries, provider/browser/model errors, verification, publish-to-install conversion, DB pools, reconciliation/retention, and telemetry drops.
- Added 25 bounded executable golden cases covering the required website, OpenAPI 3.0/3.1/3.2/auth, GitHub, injection/poison, ownership/auth, crash/resume/cancel, hosted/self-host/native/compatibility, and model-diagnostic-only cases.
- Added exact dependency/provider/compiler pin checks, hermetic/live readiness CLI, explicit CI golden/readiness promotion gates, and an eight-scenario recovery checker/runbook. Updated operations guidance to remove the obsolete production-Acme claim.

## Main files

- `apps/control-plane/src/workflow-presentation.ts`, `apps/control-plane/app/project-entry.tsx`, workflow status and lifecycle routes
- `packages/database/src/workflow.ts`, `control-plane.ts`, `postgres.ts`
- `supabase/migrations/20260830190000_workflow_event_observability.sql`
- `packages/observability/src/workflow.ts`, `metrics.ts`, `index.ts`, `server.ts`
- `packages/evals/src/golden.ts`, `packages/evals/fixtures/golden-cases.json`
- `packages/operations/src/readiness.ts`, `scripts/check-release-readiness.ts`
- `.github/workflows/ci.yml`, `docs/OPERATIONS.md`, `docs/runbooks/task-9-recovery.md`

## TDD evidence

- Presentation RED: module missing; UI static RED: `Exact reviewed capability` absent. GREEN: presentation/workflow/UI route slice 7/7, then final UI static 2/2.
- Side-effect event RED: workflow suite 17 pass / 1 fail (`actual []`); migration RED: generated migration empty. GREEN: workflow 18/18 and migration static 1/1.
- Telemetry/metrics RED: modules missing. GREEN: workflow telemetry 3/3 and metrics/alerts 2/2.
- PostHog RED: `per-event flush must not be called`. GREEN: UUID/org grouped buffered capture 1/1 (server suite 3/3).
- Golden/readiness RED: modules/scripts missing (and package ranges detected as drift). GREEN: golden 3/3; operations 3/3; readiness CLI 2/2.
- Focused command: trusted `tsx --test` over UI/database/observability/evals/operations/readiness — 53 tests, 53 passed, 0 failed, 0 skipped.
- After final type fixes: UI/vendor/readiness regression slice — 7/7.

## Full verification

- Trusted full unit/integration suite: 391 tests; 382 passed, 0 failed, 9 explicitly skipped; exit 0; 7.2 s. Skips are environment-gated PostgreSQL/live controls, not counted as live success.
- Direct TypeScript: `/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit` — exit 0.
- Focused ESLint over all changed TypeScript/TSX production files — exit 0.
- `scripts/check-source.mjs` — exit 0; `scripts/lint-source.mjs` — exit 0; `git diff --check` — exit 0.
- The first `pnpm` typecheck/source invocations stalled under local executable provenance and were bounded; the same gates were rerun successfully with trusted `/usr/local/bin/node`.
- No live provider/browser/deployment check was run because credentials/infrastructure were absent. No live success is claimed. The PostgreSQL runtime integration remains its existing explicit environment skip; migration shape/lease enforcement was exercised hermetically.

## Concerns / residuals

- Vendor export is deliberately non-authoritative and fail-open; operators must schedule/project the durable database event stream and monitor `telemetry_drops`.
- Ownership/browser-auth resume and cancellation are represented by the durable Task 5 controller and presentation contract; actual availability remains source/provider-control dependent and fails closed when unavailable.
- Live readiness requires real isolated verification, database/RLS, and provider controls and cannot be inferred from the hermetic gate.

## Fix round 1 — independent review

### Findings addressed

1. The workflow-status route now resolves the persisted project source type and selects `reviewedAnalysisRunId` for the GitHub reviewed workflow or `analysisRunId` for the website/OpenAPI compatibility workflow. It returns the actual source type, capabilities, diagnostics, evidence, plans, and source-specific outcome. Only GitHub may return draft-PR outcome labels. A successful analysis without a persisted release is now `ready_for_verification`, never implicitly `published`.
2. Durable workflow telemetry and operational metrics now have a non-test runtime callsite in the authenticated workflow-status lifecycle. The route projects its already-loaded authoritative DB run/tasks/events/evidence/plan links into redacted batches, derives and logs metrics/alerts, and returns bounded export counts. Vendor export remains fail-open and cannot alter DB state. When observability is enabled, the production server lazily initializes and installs a real Langfuse sink that creates workflow → task → event observation nesting; the test override remains forbidden in production.

### Strict RED → GREEN evidence

- Source-status RED: website response had `sourceType === undefined`; presentation RED returned `published` rather than `ready_for_verification`. GREEN regression covers both website and OpenAPI plus unchanged GitHub behavior: 8/8 route/presentation tests.
- Runtime-callsite RED: the telemetry sink override/export was absent, then the route exported 0 durable observations where 5 were expected. GREEN integration proves every durable status event reaches the configured sink and that response/log projection contains runtime metrics/alerts.
- Production-sink RED: `createLangfuseWorkflowTelemetrySink` export was missing. GREEN server regression proves real workflow/task/event parent nesting and exact approved hash metadata.
- Combined focused suite after implementation: 17 passed, 0 failed, 0 skipped.

### Verification

- Full trusted suite: 395 tests; 386 passed, 0 failed, 9 explicit environment skips; exit 0.
- Trusted direct TypeScript: exit 0.
- Focused ESLint over all changed production files: exit 0.
- Source policy, source lint, and `git diff --check`: exit 0.
- No PostgreSQL/live vendor/browser infrastructure was available; existing explicit environment skips remain, and no live success is claimed.
