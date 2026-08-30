# Task 7 Rereview Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a dedicated GitHub worker from failing website/OpenAPI jobs and enforce active-lease-scoped PostgreSQL reads for reviewed GitHub workflow material.

**Architecture:** Extend the common analysis claim contract with an optional bounded source-type filter, and configure the GitHub production runtime to claim only GitHub jobs. Bind reviewed-material RLS to transaction-local task/worker/generation context plus an active, unexpired task lease; set that context only after the repository proves the lease.

**Tech Stack:** TypeScript, Node test runner, PostgreSQL 15+, Supabase RLS migrations.

**Spec:** `.superpowers/sdd/2026-08-29-url-to-script-production/task-7-rereview.md`

## Global Constraints

- Strict RED→GREEN for both findings.
- Preserve Task 1–7 canonical plan/evidence/review/workflow invariants.
- No production test/fixture fallback, no merge/install surface, and no live-success claim.
- Use `apply_patch`; no subagents.

---

### Task 1: Source-Type-Gated Analysis Claims

**Files:**
- Modify: `apps/worker/src/production-runtime.test.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Modify: `apps/worker/src/runner.ts`
- Modify: `packages/database/src/control-plane.ts`
- Modify: `packages/database/src/postgres.ts`
- Modify: repository tests as required for parity

**Interfaces:**
- Consumes: durable analysis queue and `PAGE2WEBMCP_PROVIDER_MODE=github`.
- Produces: `claimAnalysis(workerId, leaseMs, sourceTypes?)` and `ProcessAnalysisOptions.sourceTypes?`.

- [x] Write a real in-memory production-runtime regression enqueuing website/OpenAPI work under GitHub mode and assert the iteration does not claim or fail either run.
- [x] Run the focused test and capture failure showing a non-GitHub run becomes `failed` with `SOURCE_TYPE_NOT_CONFIGURED`.
- [x] Add bounded, unique source-type filters to runner/repository claims; configure the GitHub runtime with `['github']`.
- [x] Add in-memory/PostgreSQL claim parity tests and run focused GREEN.

### Task 2: Active-Lease RLS Context

**Files:**
- Modify: `packages/database/src/github-workflow-migration.test.ts`
- Modify: `packages/database/src/postgres.integration.test.ts`
- Modify: `packages/database/src/postgres.ts`
- Modify: `supabase/migrations/20260830180000_github_workflow_binding.sql`
- Modify: `supabase/tests/tenant_isolation_standalone.sql` if necessary

**Interfaces:**
- Consumes: claimed workflow `taskId`, `workerId`, and `leaseGeneration`.
- Produces: transaction-local `page2webmcp.workflow_task_id`, `page2webmcp.worker_id`, and `page2webmcp.lease_generation` RLS context.

- [x] Add a direct-role PostgreSQL regression proving no-context, wrong-worker, wrong-generation, and expired/unleased sessions see zero reviewed material while the matching active lease sees only its rows.
- [x] Run the static policy test and capture the expected missing-context RED before the policy implementation.
- [x] Replace existence-only material policies with active running/unexpired task predicates matching all three context values.
- [x] Set the transaction-local context only after `getWorkflowExecutionMaterial` proves the exact lease.
- [x] Run static policy, focused repository, and ephemeral PostgreSQL GREEN.

### Task 3: Verification, Report, Commit

**Files:**
- Modify: `.superpowers/sdd/2026-08-29-url-to-script-production/task-7-report.md`

- [x] Run affected/full trusted suites and direct typecheck/lint/security/diff gates.
- [x] Append exact RED/GREEN, PostgreSQL, and residual evidence to the report.
- [x] Self-review the diff for cross-source queue starvation and RLS context bypass.
- [x] Commit the verified fix/report and report exact HEAD.
