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
