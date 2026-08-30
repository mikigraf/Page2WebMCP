# Task 7 Production Wiring Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. The task explicitly forbids subagents.

**Goal:** Make the configured GitHub source path executable from the production worker and control plane through immutable analysis, sandbox verification, and draft-PR/check reconciliation, while failing startup closed without exact controls.

**Architecture:** A pinned GitHub REST transport supplies the existing provider ports from an exact repository allowlist. The Task 5 workflow run stores only an additive reference to the reviewed analysis; a worker-only material read reconstructs canonical plans/evidence and re-captures the same commit before each idempotent side effect. The control plane starts and reports workflows, while the worker alone runs the controller and providers.

**Tech Stack:** TypeScript, Node fetch/crypto, Next.js App Router route handlers, PostgreSQL/Supabase RLS, Node test runner.

**Spec:** `.superpowers/sdd/2026-08-29-url-to-script-production/task-7-brief.md` and `.superpowers/sdd/2026-08-29-url-to-script-production/task-7-review.md`

## Global Constraints

- Canonical `CapabilityPlan` plus exact evidence/review binding remains the only persisted authorization IR.
- GitHub App tokens are repository-scoped, callback-only, no longer than one hour, and never persisted.
- No fixture/Acme production branch, local source-control fallback, autonomous merge, or installation-success claim.
- Provider/model code cannot transition Task 5 state; only `WorkflowController` and repository methods do.
- Missing credentials, repository bindings, sandbox controls, or exact provider responses fail closed.

---

### Task 1: GitHub conclusion compatibility

**Files:** Modify `packages/providers/src/github.test.ts` and `packages/providers/src/github.ts`.

**Interfaces:** `verifyGitHubCheckWebhook(...)` accepts GitHub's valid `stale` conclusion without weakening identity, signature, freshness, or replay checks.

- [ ] Add a signed-webhook regression whose exact conclusion is `stale` and assert successful bounded output.
- [ ] Run the test and capture `GITHUB_WEBHOOK_CHECK_STATUS_INVALID` RED.
- [ ] Add `stale` to the exact conclusion allowlist.
- [ ] Run the focused provider test GREEN.

### Task 2: Production GitHub analysis composition

**Files:** Create `apps/worker/src/github-live.ts`, `apps/worker/src/production-runtime.ts`, and tests; modify `apps/worker/src/main.ts`, `apps/control-plane/src/config.ts`, and config tests.

**Interfaces:** `createProductionWorkerRuntime(repository, environment, dependencies?)` returns an explicit `analyze` dispatcher and workflow controller. `createConfiguredGitHubPorts` builds installation selection, installation-token, immutable-tree, Git mutation/check/preview, and sandbox ports using only pinned `https://api.github.com` REST calls and an exact configured sandbox origin.

- [ ] Add tests proving missing provider mode/credentials/bindings/sandbox fail before a claim and no test adapter is consulted.
- [ ] Add a hermetic fetch integration proving a configured GitHub analysis traverses the real factory and returns canonical evidence without a fabricated PR.
- [ ] Run focused tests and capture missing-export RED.
- [ ] Implement bounded JSON/body/status/origin/redirect/deadline checks, App JWT signing, repository-scoped token issuance, ref/tree/blob reads, and explicit runtime dispatch.
- [ ] Change `main.ts` to construct the runtime once and pass `runtime.analyze` on every analysis claim.
- [ ] Run focused worker/config tests GREEN.

### Task 3: Exact reviewed-analysis workflow binding

**Files:** Create an additive migration; modify `packages/database/src/workflow.ts`, `control-plane.ts`, `postgres.ts`, mapping/tests, and migration tests.

**Interfaces:** `StartWorkflowInput` accepts `analysisRunId`; `WorkflowRunRecord.reviewedAnalysisRunId` retains it. `ControlPlaneRepository.getWorkflowExecutionMaterial(workerId, taskId, leaseGeneration)` returns the exact GitHub source, immutable analysis result, and capability review records only while the caller owns the live task lease.

- [ ] Add parity/migration tests rejecting a cross-project, failed, stale-source, blocked, or unreviewed analysis binding and accepting exact reviewed plans.
- [ ] Add a worker-material test proving stale lease and non-GitHub/missing analysis fail closed.
- [ ] Run focused database tests and capture type/schema/behavior RED.
- [ ] Add the nullable reviewed-analysis FK, exact project/source validation, worker read grants/RLS, mappings, and in-memory/Postgres parity.
- [ ] Run focused database tests GREEN, including ephemeral PostgreSQL when available.

### Task 4: Reachable controller and provider side effects

**Files:** Modify `packages/database/src/workflow.ts`, `apps/worker/src/github-workflow.ts`, `github-live.ts`, `production-runtime.ts`, `main.ts`, and worker tests.

**Interfaces:** `WorkflowSideEffectRequest` includes immutable task/run identity. `createConfiguredGitHubWorkflowSideEffect(...)` re-captures the reviewed commit, re-derives exact canonical plans/patch, runs the attested sandbox, reconciles a draft PR/check with stable keys, verifies successful check/optional preview, and returns only content-addressed output.

- [ ] Add controller integration RED covering the full configured phase chain, exact reviewed plan/commit drift rejection, cancellation, ambiguity reconciliation, sandbox failure, check failure, and no merge/install result.
- [ ] Add all three GitHub wait-registry phases as deterministic installation/review validation effects, so no phase is unhandled.
- [ ] Implement the task-aware side-effect request and configured GitHub side-effect router; keep repository/provider transitions separated.
- [ ] Make the production loop process both legacy analysis claims and generic workflow tasks with cancellation and reconciliation.
- [ ] Run focused worker/controller tests GREEN.

### Task 5: Truthful API/UI and fixture removal

**Files:** Create workflow start/status route handlers and tests; modify `apps/control-plane/app/project-entry.tsx`, `client-workflow.ts`, and `analyze-route.test.ts`.

**Interfaces:** `POST /api/projects/workflow` starts an exact reviewed-analysis GitHub workflow. `GET /api/workflow-runs/[runId]` exposes bounded run/task status. The UI labels GitHub success only as tested patch plus draft PR/check reconciliation and never exposes a hosted-release link for it.

- [ ] Replace the fabricated GitHub `draftPullRequest` analysis fixture with a real configured adapter test and assert analysis has no PR claim.
- [ ] Add route authorization/idempotency/exact-analysis tests and UI source assertions; run to capture missing-route and disabled-flow RED.
- [ ] Implement start/status handlers using fresh actor and repository checks, and add GitHub workflow polling/resume state to the client.
- [ ] Keep immutable release publication unchanged for website/OpenAPI and make the GitHub action distinct.
- [ ] Run affected route/UI tests GREEN.

### Task 6: Verification, report, and commit

**Files:** Append `.superpowers/sdd/2026-08-29-url-to-script-production/task-7-report.md`.

- [ ] Run focused, affected, full trusted, native workflow, and ephemeral PostgreSQL suites.
- [ ] Run TypeScript, worker build, ESLint, source/security/dependency/audit, production-branch scans, and `git diff --check`.
- [ ] Self-review token, origin, redirect, commit, review, side-effect, UI truthfulness, and no-merge/install boundaries.
- [ ] Append exact RED/GREEN/output evidence and residual live-provider limitations using `apply_patch`.
- [ ] Commit the fix and verify a clean worktree.
