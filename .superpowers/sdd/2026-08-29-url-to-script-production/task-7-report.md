# Task 7 report: GitHub App source-native draft PR path

Date: 2026-08-30

## Result

Implemented a generic, fail-closed GitHub source path using the existing canonical `CapabilityPlan`, immutable evidence, compiled release, `AnalysisResult`, and Task 5 workflow contracts. No second persisted IR or database migration was added. The production path has no Acme/fixture branch, no default live GitHub client, and no local source-control fallback.

The implementation provides:

- explicit repository-scoped GitHub App selection and one-hour installation-token ports;
- callback-scoped tokens with local expiry, cancellation, recursive result leak detection, and unconditional revocation;
- exact installation/repository/ref/commit validation at token, ref, tree, patch, draft PR, check, webhook, and preview boundaries;
- bounded immutable snapshots (256 files, 256 KiB/file, 1 MB total, depth/path/kind/duplicate checks) with locale-independent content-addressed identity;
- TypeScript AST analysis for supported Next.js App Router route handlers, linked TSX forms, Zod request/output validation, exact called auth functions, exact response expressions, imported service implementations, and verified idempotency headers;
- deterministic complete canonical JSON API plans, with JSON API preference when a linked form exists, and bounded per-operation diagnostics when proof is absent or canonical validation fails;
- concrete content-addressed source-native runtime, verification test, and security documentation files from `compileWebMcpRelease`;
- an isolated sandbox port requiring exact CPU/memory/time/log limits, empty credentials, fixed build/typecheck/test steps, deny-network attestation, bounded sanitized logs, and exact snapshot/patch/base-commit identity;
- idempotent base branch, concrete patch application, draft PR, and check reconciliation with distinct immutable base and patched head commits, stable keys, no merge/install operation, and sanitized content-addressed workflow output;
- official raw-body HMAC-SHA256 GitHub webhook verification, signed in-body freshness, delivery replay protection, and exact installation/repository/head/check matching;
- optional preview verification that fails closed when unavailable and returns only a content-addressed result after exact origin/head validation;
- GitHub Task 5 phase handlers that invoke only controller side effects, plus provider-response ambiguity recovery, cancellation, lease-loss abort, and cleanup tests;
- a read-only compatibility analysis adapter that persists canonical candidate/evidence/diagnostics but truthfully does not claim a draft PR before the controller side effect completes.

No provider or model can transition workflow state. `publish` maps to a draft-PR reconciliation side effect and `install_verify` maps to check reconciliation; neither writes an installation record or claims a merge/deployment.

## Files

- `packages/providers/src/github.ts` — GitHub App session, immutable snapshot, concrete patch/draft PR/check reconciliation, webhook, and preview contracts.
- `packages/providers/src/github.test.ts` — token, snapshot, reconciliation, webhook, preview, and no-fallback regressions.
- `packages/providers/src/github-sandbox.ts` — isolated sandbox request/attestation/result contract.
- `packages/providers/src/github-sandbox.test.ts` — resource, credential, network, log, cancellation, and failure regressions.
- `packages/providers/src/local.ts` and `local.test.ts` — removed `LocalSourceControlProvider`; retained only local browser/artifact test providers.
- `packages/source-analyzer/src/analyze.ts` — bounded deterministic Next.js/TypeScript AST evidence, canonical plans/diagnostics, and concrete source-native change generation.
- `packages/source-analyzer/src/analyze.test.ts` — generic non-Acme routes/forms/auth/validation/service, hostile source, ambiguity, resource, poison-key, dynamic-route, response-linkage, and patch regressions.
- `package.json` and `pnpm-lock.yaml` — keep the pinned TypeScript AST parser available to the production worker rather than only development installs.
- `apps/worker/src/workflow.ts` — explicit GitHub analysis adapter with exact source/installation selection and diagnostic-only unsupported results.
- `apps/worker/src/github-workflow.ts` — Task 5 phase-to-side-effect mapping and stable sanitized draft-PR side-effect composition.
- `apps/worker/src/github-workflow.test.ts` — persistence, fail-closed configuration, controller-only effects, ambiguity recovery, cancellation/lease loss, unsupported repositories, and durable sanitized output.

No Next.js app code, Supabase schema, RLS policy, or database repository contract changed.

## TDD evidence

All test commands used the required trusted TSX. The Homebrew Node 24 launcher remained blocked even for `node --version`, so the previously documented trusted `/usr/local/bin/node` was used without changing provenance/quarantine metadata.

Initial RED, before implementation:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test \
  packages/providers/src/github.test.ts \
  packages/providers/src/github-sandbox.test.ts \
  packages/source-analyzer/src/analyze.test.ts

tests 3; pass 0; fail 3
ERR_MODULE_NOT_FOUND: github.ts
ERR_MODULE_NOT_FOUND: github-sandbox.ts
analyze.ts does not provide analyzeGitHubSourceSnapshot
```

Additional focused RED regressions were observed before their implementations:

```text
apps/worker/src/github-workflow.test.ts
ERR_MODULE_NOT_FOUND: github-workflow.ts

preview/patch hardening
github.ts does not provide verifyGitHubPreview

immutable snapshot binding
github.ts does not provide gitHubSourceSnapshotReference

dynamic path and poison schema
canonical plan construction threw instead of returning an operation diagnostic

base/head and exact AST linkage
GITHUB_COMMIT_IDENTITY_MISMATCH; shallow auth/response proof incorrectly produced a plan

canonical 204 handling
canonical plan construction threw instead of returning CANONICAL_PLAN_UNSUPPORTED

sandbox log sanitation
sk-live and a database URL remained in the sanitized result

controller composition
github-workflow.ts did not provide createGitHubDraftPullRequestSideEffect

production dependency classification
pnpm list --prod omitted typescript; package.json production dependency assertion exited 1
```

Focused GREEN on the final tree:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test \
  packages/providers/src/github.test.ts \
  packages/providers/src/github-sandbox.test.ts \
  packages/providers/src/local.test.ts \
  packages/source-analyzer/src/analyze.test.ts \
  apps/worker/src/github-workflow.test.ts

tests 24; pass 24; fail 0; skipped 0; duration 1250 ms
```

Affected canonical-plan/compiler/worker/database suite:

```text
tests 75; pass 75; fail 0; skipped 0; duration 1658 ms
```

## Full verification

The same split used by Task 6 avoided the known TSX/Node workflow-test provenance issue:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test \
  $(rg --files -g '*.test.ts' -g '!node_modules' \
    | rg -v '^packages/database/src/workflow\.test\.ts$' | LC_ALL=C sort)

tests 319; pass 312; fail 0; skipped 7; duration 4474 ms

/usr/local/bin/node --experimental-transform-types --test packages/database/src/workflow.test.ts

tests 14; pass 14; fail 0; skipped 0; duration 270 ms
```

Combined final result: 333 tests, 326 pass, 7 explicit environment skips, 0 failures.

One pre-existing fairness test was demonstrably order-sensitive: one native run failed at `workflow.test.ts:319` when the opaque-ID tie-break claimed tenant B first, and immediate unchanged reruns passed 14/14. Task 7 has no database/workflow implementation diff. The successful final native run above is recorded, and the flake is not hidden.

Direct gates on the final implementation tree:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.worker.json
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
/usr/local/bin/node /opt/homebrew/Cellar/pnpm/10.14.0/bin/pnpm list --prod typescript --depth 0
/usr/local/bin/node /opt/homebrew/Cellar/pnpm/10.14.0/bin/pnpm audit --prod --audit-level=high
No known vulnerabilities found
git diff --check
production source scan for Acme/LocalSourceControlProvider/api.github.com/merge APIs
All exited 0; production scan returned no matches.
```

## Self-review and concerns

- Re-read the Task 7 brief and Task 1–6 invariants after implementation. Canonical plans remain the only authorization/replay unit, evidence references are exact content hashes, and GitHub source-native candidates still pass through the common compiler.
- Verified generated artifacts contain no repository prompt/comment text, credentials, provider/control-plane URLs, or live token values.
- Verified installation tokens never appear in snapshots, analysis results, workflow outputs, or generated patches and are revoked for completion, error, cancellation, and local expiry.
- Verified every mutating GitHub request is scoped to the selected installation/repository and immutable base/patched head, uses stable idempotency keys, and has no merge/install API surface.
- Verified unsupported repositories succeed only as diagnostic-only analyses with no release or invented draft PR.
- Live GitHub App, sandbox, webhook delivery, and preview credentials were unavailable. No live success is claimed. Only explicit hermetic fakes were exercised; production construction remains fail-closed without every control.
- The sandbox implementation is an attested provider boundary, not an in-process shell executor. A real isolated runner must enforce the requested limits and return the exact attestation; weaker/no controls are rejected.
- The installation/deployment layer must still perform Task 1's mandatory trusted pre-evaluation artifact integrity enforcement. This task generates and checks content-addressed source-native bytes but does not weaken or replace that dependency.

## Fix round 1 — production wiring and truthful workflow reachability

Date: 2026-08-30

### Result

Resolved every finding in `task-7-review.md`.

- Production `main.ts` now constructs one explicit GitHub runtime before claiming work. Configuration requires a pinned GitHub App, exact repository/installation/ref/origin bindings, and a separate exact-origin isolated-sandbox service; absent controls fail startup before a queue claim. There is no test-adapter fallback.
- The same production loop now drains compatibility analysis work and the Task 5 workflow controller. All eleven GitHub phases have explicit handlers, including deterministic installation/authorization/review verification phases.
- Every controller side-effect request now carries worker, task, workflow, phase, and lease-generation identity. The provider reloads the exact reviewed analysis under that live lease, re-captures the configured ref, and requires exact commit/snapshot/evidence/plan/release/source-native bytes before sandbox or GitHub mutations.
- Added the minimum richer persisted reference required for safe resume: `workflow_runs.reviewed_analysis_run_id`, constrained to the same project/organization analysis. This is an authorization reference to the existing canonical plans/evidence/release, not a second IR.
- Added lease-scoped PostgreSQL RLS for the exact source snapshot, evidence, and reviewed capabilities. In-memory and PostgreSQL repositories enforce the same reviewed-run/project/source-snapshot/plan-digest contract.
- Added bounded live GitHub REST adapters for repository-scoped tokens, immutable snapshots, branches, Git objects, draft PRs, completed-success checks backed by passed sandbox evidence, and deployment preview lookup. Requests pin GitHub API version `2026-03-10`, reject redirects/origin/content-type/size drift, and never expose merge/install operations.
- Added a bounded exact-origin sandbox HTTP adapter. Its response remains subject to the existing deny-network, empty-environment, resource-limit, step, log, and identity attestation checks.
- Added production workflow start/status routes. The UI persists and resumes the workflow ID, reports pending state without claiming a PR, and only reports tested patch/draft PR/check/preview reconciliation after the durable workflow succeeds. It explicitly says nothing was merged or installed.
- Removed the analyze-route fixture's fabricated `draftPullRequest`. A generic real GitHub analysis + review + workflow-route integration now proves analysis alone returns no PR and workflow start binds the exact reviewed run.
- Accepted signed GitHub check conclusion `stale`.

### Files

- `apps/worker/src/github-live.ts` and `.test.ts` — fail-closed production GitHub App/REST/sandbox/preview factories and hermetic integration coverage.
- `apps/worker/src/production-runtime.ts` and `.test.ts`, `main.ts` — explicit analysis/controller production composition and loop reachability.
- `apps/worker/src/github-workflow.ts` and `.test.ts` — all-phase mapping, exact reviewed-material derivation, sandbox/PR/check/preview side effect, cancellation and no-merge/install coverage.
- `packages/database/src/workflow.ts`, `control-plane.ts`, `postgres.ts` and tests — lease identity, reviewed analysis reference, exact execution material, in-memory/PostgreSQL parity.
- `supabase/migrations/20260830180000_github_workflow_binding.sql`, static migration test, PostgreSQL integration test, and RLS test update — additive reviewed binding and worker least-privilege reads.
- `apps/control-plane/app/api/projects/[projectId]/workflows/route.ts`, `app/api/workflow-runs/[runId]/route.ts`, route test, `project-entry.tsx`, and client workflow state — truthful start/resume/status UI/API.
- `apps/control-plane/tests/analyze-route.test.ts` — removed fabricated GitHub PR readiness.
- `packages/providers/src/github.ts` and `.test.ts` — valid `stale` webhook conclusion.
- `.env.example` — explicit production GitHub controls without committed secrets.

### Strict TDD evidence

Focused RED was captured before each behavior was implemented:

```text
signed stale conclusion: GITHUB_WEBHOOK_CHECK_STATUS_INVALID
production composition: ERR_MODULE_NOT_FOUND production-runtime.ts; LIVE_PROVIDER_UNSUPPORTED
exact reviewed binding: startWorkflow accepted unreviewed/cross-project state and no lease-scoped execution-material API existed
all-phase mapping: ownership/browser_auth/review_wait handlers were undefined
control-plane workflow route: ERR_MODULE_NOT_FOUND app/api/workflow-runs/[runId]/route.ts
```

Focused/affected GREEN on the final tree:

```text
/usr/local/bin/node .../tsx/dist/cli.mjs --test \
  apps/worker/src/github-live.test.ts apps/worker/src/production-runtime.test.ts \
  apps/worker/src/github-workflow.test.ts packages/providers/src/github.test.ts \
  packages/database/src/workflow.test.ts packages/database/src/github-workflow-migration.test.ts \
  apps/control-plane/tests/analyze-route.test.ts apps/control-plane/tests/github-workflow-route.test.ts \
  apps/control-plane/tests/client-workflow.test.ts apps/control-plane/tests/next-structure.test.ts

tests 55; pass 55; fail 0; skipped 0; duration 3413 ms
```

Full trusted suite:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs \
  --test test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts

tests 348; pass 340; fail 0; skipped 8; duration 8265 ms
```

Ephemeral PostgreSQL migrations, direct-role RLS, repository parity, reviewed-material lease regression, and production topology:

```text
PAGE2WEBMCP_NATIVE_TYPESCRIPT_TESTS=true PAGE2WEBMCP_NODE_BINARY=/usr/local/bin/node \
  bash scripts/test-rls-local.sh

Postgres repository: tests 7; pass 7; fail 0
Production topology: tests 1; pass 1; fail 0
Standalone PostgreSQL RLS and production-topology integration tests passed.
```

Direct gates all exited zero:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check
```

### Self-review and residuals

- Re-checked that no production branch mentions Acme, fixtures, `LocalSourceControl`, or the test adapter, and that the production GitHub ports expose no merge or installation API.
- A completed-success GitHub check is created only from the exact passed sandbox evidence reference; preview verification is then exact commit/origin bound. Provider output never transitions workflow state.
- Installation tokens remain callback-scoped and are revoked after every session. The sandbox bearer is sent only to the configured exact sandbox origin and is never included in its JSON payload, logs, evidence, or workflow output.
- No live GitHub App or sandbox credentials were available, so no live provider success is claimed. Hermetic fakes exercised the exact production factories and HTTP request/response contracts; missing live controls fail startup.
- The external sandbox service and GitHub App installation remain deployment dependencies. The service must enforce the attested isolation limits, and the app must grant only checks/contents/pull-requests write plus deployments/metadata read for the configured repositories.
