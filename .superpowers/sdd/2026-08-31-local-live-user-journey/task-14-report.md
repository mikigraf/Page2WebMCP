# Task 14 report: tenant-authorized website authentication UI handoff

## Status

Implemented in `2e8938b7aab59de0b179cf659ab95c3b1630e83a` (`feat(control-plane): resume website authentication`). No push was performed. The UI/API now expose the exact durable Task 12/13 authentication wait, recover it from PostgreSQL after a control-plane restart or browser reload, consult the configured gateway for deterministic evidence, and atomically resume or terminate the same checkpoint.

## Public API

`GET /api/workflow-runs/<runId>/website-authentication` returns a bounded public state. Owners/editors may receive a short-lived gateway-origin `/portal?handoff=<opaque>` URL; viewers receive only the non-actionable target origin, expiry, and state.

`POST /api/workflow-runs/<runId>/website-authentication` accepts exactly `{ "action": "check" | "cancel" }` with the existing session-bound same-origin CSRF proof and a bounded idempotency key. `check` calls the configured authentication gateway and resumes only on an exact SHA-256 evidence URN bound to the organization, project, workflow/run/task, source snapshot/identity, target-origin digest, checkpoint reference, and expiry. `cancel` persists workflow cancellation; the durable worker owns provider cleanup.

The route loads all binding values from fresh tenant-authorized database state. Foreign runs are 404, viewers cannot receive a portal or mutate, terminal states are reconstructed from PostgreSQL, and browser storage is not authoritative.

## Files changed

- Route and projections: `apps/control-plane/app/api/workflow-runs/[runId]/website-authentication/route.ts`, the analysis/workflow status routes, and `apps/control-plane/src/website-user-handoff-api.ts`.
- Pinned gateway client: `apps/control-plane/src/website-user-handoff.ts`.
- Restart/reload UI: `apps/control-plane/app/project-entry.tsx` and `apps/control-plane/src/client-workflow.ts`.
- Atomic terminal state support: `packages/database/src/control-plane.ts` and `packages/database/src/postgres.ts`.
- Startup protocol attestation: `apps/worker/src/website-live.ts`.
- Route, role, tenant, replay, recovery, expiry, cancellation, stale-response, and leakage tests in the corresponding control-plane and worker test files.

The forward migration allowing the exact waiting-to-failed transition was committed separately as `84c517d57025dd8e7f00c8079bf9c7f4860ed72e` and applied locally and to the selected hosted Supabase project.

## TDD evidence

RED contracts were added for the absent route and UI state: safe portal loading, viewer/tenant denial, gateway-only completion proof, atomic replay-safe resume, terminal persistence, cancellation, reload recovery, and startup rejection of the Task 13-only gateway protocol. Before implementation these failed because the route/client projection and user-handoff protocol did not exist.

Focused GREEN command under Docker Node `24.20.0`:

```text
tsx --test \
  apps/control-plane/tests/website-authentication-route.test.ts \
  apps/control-plane/tests/website-user-handoff-route.test.ts \
  apps/control-plane/tests/website-user-handoff.test.ts \
  apps/control-plane/tests/next-structure.test.ts \
  apps/control-plane/tests/client-workflow.test.ts \
  apps/worker/src/website-live.test.ts

54 passed, 0 failed
```

Repository GREEN evidence:

```text
Full unit/contract suite: 721 total; 701 passed; 20 environment-gated skips; 0 failed
Production build: passed, including /api/workflow-runs/[runId]/website-authentication
TypeScript, ESLint, source lint, source-security policy, git diff --check: passed
Real split-role PostgreSQL authentication suite: 8/8 passed
Migration contracts: 10/10 passed
Local Supabase contracts: 12/12 passed
Readiness contracts: 16/16 passed in the migration verification run
```

Independent final review reported no remaining Critical or Important finding.

## Concerns

- No real Browser Use v4/authentication-gateway credentials were available. The gateway protocol and restart-safe database behavior passed deterministic and real-PostgreSQL tests, but a human did not authenticate through a live gateway in this run.
- Production live success remains false. No native installed-target attestation exists for a hosted hash.
- The external gateway must attest both `authenticationCheckpointProtocolVersion: 1` and `authenticationUserHandoffProtocolVersion: 1`; Task 13-only gateways fail before leasing work.
