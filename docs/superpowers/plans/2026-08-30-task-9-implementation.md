# Task 9 UI, Observability, Operations, and Golden Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete truthful workflow UI states and actions, export redacted correlated operational projections from the authoritative database event stream, and add deterministic evaluation and recovery release gates.

**Architecture:** The existing PostgreSQL/in-memory workflow event stream remains the only authoritative lifecycle record. UI presentation, vendor telemetry, metrics, evaluations, and readiness checks are additive projections over existing canonical plans, exact verification/release/install records, and workflow events; none may transition workflow state or invent live success.

**Tech Stack:** TypeScript 5.9, Node test runner, Next.js 16 App Router, PostgreSQL/Supabase RLS, OpenTelemetry/Langfuse, PostHog, GitHub Actions.

**Spec:** `docs/superpowers/plans/2026-08-30-task-9-brief.md`

## Global Constraints

- Preserve all Task 1–8 canonical plan, evidence, review, exact-artifact, RLS, lease, cancellation, and installation invariants.
- No new workflow engine, Redis/cache/model swarm, live credential fabrication, autonomous GitHub merge, or weakening of fail-closed diagnostics.
- Database workflow events are authoritative; OTel, Langfuse, PostHog, logs, metrics, and alerts are redacted non-authoritative projections.
- Website, OpenAPI, and GitHub journeys remain independently truthful; absent live controls stay explicitly unavailable.
- Deterministic checks gate promotion; model judges are diagnostic only.

---

### Task 1: Truthful workflow and capability presentation

**Files:**
- Create: `apps/control-plane/src/workflow-presentation.ts`
- Modify: `apps/control-plane/app/project-entry.tsx`
- Modify: `apps/control-plane/app/api/workflow-runs/[runId]/route.ts`
- Test: `apps/control-plane/tests/workflow-presentation.test.ts`
- Test: `apps/control-plane/tests/github-workflow-route.test.ts`
- Test: `apps/control-plane/tests/next-structure.test.ts`

**Interfaces:**
- Consumes: canonical `CapabilityPlan`, analysis diagnostics, workflow/tasks/events/evidence/plan links, exact verification/release/install records.
- Produces: `capabilityReviewPresentation(capability)` and `workflowPresentation(input)` with bounded states and enabled/disabled actions.

- [x] **Step 1: Write and run failing presentation tests**
- [x] **Step 2: Implement the minimal pure presentation contract and run it GREEN**
- [ ] **Step 3: Add failing API/UI tests for durable detail refresh, cancel/retry/review conflict, verify/publish/copy/download/self-host/installed-check, and source-specific truthfulness**
- [ ] **Step 4: Enrich the workflow GET projection and bind the client UI to the pure presentation without browser-trusted roles or state**
- [ ] **Step 5: Run control-plane focused tests GREEN**

### Task 2: Exact durable provider/tool/model lifecycle events

**Files:**
- Modify: `packages/database/src/workflow.ts`
- Modify: `packages/database/src/control-plane.ts`
- Modify: `packages/database/src/postgres.ts`
- Modify: `supabase/migrations/<generated_task9_migration>.sql`
- Test: `packages/database/src/workflow.test.ts`
- Test: `packages/database/src/postgres.integration.test.ts`
- Test: `packages/database/src/task9-migration.test.ts`

**Interfaces:**
- Consumes: `WorkflowController.sideEffect(kind, inputHash)` and active task lease/generation.
- Produces: bounded immutable `task.side_effect_started|completed|failed` records whose payload permits only operation kind, input/output hashes, duration, pinned version, and bounded cost.

- [ ] **Step 1: Write failing in-memory/controller tests proving every side effect has ordered correlated start/terminal events and failures redact thrown text**
- [ ] **Step 2: Generate the migration with `supabase migration new` and write failing SQL/static parity tests**
- [ ] **Step 3: Add lease-scoped repository event recording and controller instrumentation in memory and PostgreSQL**
- [ ] **Step 4: Run focused repository, migration, and explicit environment-gated PostgreSQL tests GREEN**

### Task 3: Batched redacted workflow telemetry and operational metrics

**Files:**
- Create: `packages/observability/src/workflow.ts`
- Create: `packages/observability/src/metrics.ts`
- Modify: `packages/observability/src/index.ts`
- Modify: `packages/observability/src/server.ts`
- Test: `packages/observability/src/workflow.test.ts`
- Test: `packages/observability/src/metrics.test.ts`
- Test: `packages/observability/src/server.test.ts`

**Interfaces:**
- Consumes: complete ordered workflow events plus bounded task/evidence/artifact/verification/install projections.
- Produces: batches of at most 100 sanitized observations correlated by workflow/task/request UUID, real nested Langfuse observations, the documented PostHog funnel with pseudonymous actor/org grouping, and bounded metric/alert snapshots.

- [ ] **Step 1: Write failing exporter tests for ordering, batching, redaction, correlation, nested spans, hashes/version/cost/latency/outcome, drop accounting, and PostHog identity/funnel restrictions**
- [ ] **Step 2: Write failing metrics/alerts tests for queues, leases, retries, provider/browser/model errors, verification, conversion, pools, reconciliation/retention, and drops**
- [ ] **Step 3: Implement pure sanitization/projection first, then vendor adapters; all failures remain fail-open and counted**
- [ ] **Step 4: Run observability focused tests GREEN**

### Task 4: Executable deterministic golden evaluations

**Files:**
- Create: `packages/evals/src/golden.ts`
- Create: `packages/evals/src/golden.test.ts`
- Create: `packages/evals/fixtures/golden-cases.json`
- Modify: `packages/evals/src/verify.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: bounded fixture inputs and literal expected deterministic outcomes.
- Produces: `runGoldenEvaluations(cases)` with release-gating deterministic failures and separate non-gating model-judge diagnostics.

- [ ] **Step 1: Add the complete required golden matrix and run the missing-runner test RED**
- [ ] **Step 2: Implement deterministic safety checks for auth, confirmation/reversibility, unsupported/high-risk, poisoned output/prompt injection, OAS versions/auth, GitHub draft-only behavior, ownership/auth failures, crash/resume/cancel, exact installs, and native/compatibility WebMCP**
- [ ] **Step 3: Prove model-judge results never change deterministic eligibility and run the golden suite GREEN**

### Task 5: Deployment/version/recovery gates and runbooks

**Files:**
- Create: `packages/operations/src/readiness.ts`
- Create: `packages/operations/src/readiness.test.ts`
- Create: `scripts/check-release-readiness.mjs`
- Create: `docs/runbooks/task-9-recovery.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: exact package/runtime/provider/compiler/parser version manifest, environment capabilities, migration state, and named recovery scenario.
- Produces: fail-closed promotion result, executable hermetic recovery checks, and explicit `SKIPPED_LIVE_CONTROLS_REQUIRED` results without live claims.

- [ ] **Step 1: Write failing readiness tests for version drift, missing required controls, absent live infrastructure, rollback/restore, and every required recovery scenario**
- [ ] **Step 2: Pin critical versions and implement the readiness CLI plus deterministic recovery registry**
- [ ] **Step 3: Add the deterministic gates to CI and document operator procedures with exact commands and stop conditions**
- [ ] **Step 4: Run readiness tests and the hermetic CLI GREEN**

### Task 6: Verification, report, and commit

**Files:**
- Create: `.superpowers/sdd/2026-08-29-url-to-script-production/task-9-report.md`

- [ ] **Step 1: Run all focused and affected trusted tests**
- [ ] **Step 2: Run the full trusted suite once**
- [ ] **Step 3: Run bounded typecheck, lint, source/security, dependency/version, diff, PostgreSQL, browser, and provider gates; record exact skips/stalls without live claims**
- [ ] **Step 4: Self-review canonical integrity, tenant/lease boundaries, redaction, UI truthfulness, and recovery fail-closed behavior**
- [ ] **Step 5: Write the report, commit all Task 9 changes, and confirm a clean worktree**
