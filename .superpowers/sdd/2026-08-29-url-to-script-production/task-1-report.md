# Task 1 report: Canonical CapabilityPlan and generic auto-registering compiler

## Status

Implemented and verified. The production compiler now has one primary API, `compileWebMcpRelease(plans: readonly CapabilityPlan[])`, and accepts only complete, validated plans whose exact `targetOrigin` agrees. The generated ES module self-registers on evaluation and carries a lossless canonical manifest that can reproduce the exact artifact.

## Implementation

- Added strict version-1 `CapabilityPlan` TypeScript and Zod contracts with target origin, tool metadata, input/internal-output JSON Schemas, annotations, authentication/scopes/reviewed CSRF resolution, effects/risk/reversibility/confirmation, idempotency/retry, exact request mappings, response projection/error mappings, success conditions, and immutable SHA-256 evidence URNs.
- Added cross-field validation for unsafe origins and paths, R3, method/effect inconsistencies, duplicate/missing references, unsupported schemas, unstable CSRF selectors, missing/default error handling, absent or optional execution fields, and unsafe mutation retry without verified header idempotency.
- Canonicalized tool order plus every semantically unordered collection and record using locale-independent ordering. Canonical results and their nested values are frozen.
- Replaced the legacy shallow compiler contract and removed the production `CompilableCapability`, Acme request-plan defaults, confirmation-endpoint fallback, and all fixture-name branches.
- Emitted manifest version 3 with the complete canonical plans, release ID, and exact target origin. The compiler returns byte-accurate SHA-256 content hash and SHA-384 SRI metadata.
- Generated a dependency-free ES module that validates the exact origin and WebMCP surface, auto-registers all tools during module evaluation, atomically suppresses duplicate release registration through a global symbol registry, and aborts registration on `pagehide`/`beforeunload`.
- Preserved strict null-prototype input/output projection, same-origin credentials, bounded JSON/content-type handling, stable safe errors, total deadline/caller cancellation, controlled read retry, and verified-idempotent mutation replay with the same key across ambiguous outcomes.
- Added reviewed DOM/meta CSRF resolution and a closed-shadow-root confirmation dialog with modal, label, description, keyboard cancel, explicit cancel/confirm controls, cleanup, and abort handling. Optional native confirmation/diagnostic exports remain hooks only; execution still belongs to the generated runtime.
- Changed control-plane verification to replay exact canonical plans rather than reconstructing shallow metadata. Byte-for-byte replay is the runtime provenance gate instead of brittle source-text matching.
- Upgraded persisted and served release SRI validation to SHA-384 while preserving SHA-256 content addressing.
- Moved Acme details into an explicit fixture-plan factory and migrated all fixture/compiler/database/observability callers to complete plans.

## Files

Core contract and compiler:

- `packages/capability-ir/src/plan.ts`
- `packages/capability-ir/src/plan.test.ts`
- `packages/compiler/src/compiler.ts`
- `packages/compiler/src/compiler.contract.test.ts`
- `packages/compiler/src/compiler.test.ts`

Fixture and workflow migration:

- `apps/acme-support/src/capability-plans.ts`
- `apps/acme-support/app/api/releases/acme/route.ts`
- `apps/acme-support/tests/release-route.test.ts`
- `apps/worker/src/runner.ts`
- `apps/worker/src/workflow.ts`
- `apps/worker/src/workflow.test.ts`
- `packages/observability/src/observability.test.ts`

Canonical replay and artifact integrity:

- `apps/control-plane/src/releases.ts`
- `apps/control-plane/app/api/releases/[artifact]/route.ts`
- `apps/control-plane/tests/release-route.test.ts`
- `apps/control-plane/tests/postgres-topology.integration.test.ts`
- `packages/database/src/control-plane.ts`
- `packages/database/src/control-plane.test.ts`
- `packages/database/src/postgres.ts`
- `packages/database/src/postgres.integration.test.ts`

## TDD evidence

Initial focused RED, before adding the plan contract/replacing the compiler:

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/capability-ir/src/plan.test.ts packages/compiler/src/compiler.contract.test.ts
```

Expected result: exit 1. The new plan module was absent, and the six compiler contract tests failed against the old positional-origin API with `Invalid URL` (7 failures including the missing test module).

Focused GREEN after the contract/compiler implementation:

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/capability-ir/src/plan.test.ts packages/compiler/src/compiler.contract.test.ts
```

Result: 11 tests, 11 passed, 0 failed (before adding the focused built-in-dialog accessibility case).

Built-in confirmation accessibility RED:

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-name-pattern='built-in confirmation' packages/compiler/src/compiler.contract.test.ts
```

Expected result: 1 failure; `aria-describedby` was `null`. After adding the dialog description binding, the same command passed 1/1.

SHA-384 persistence RED:

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-name-pattern='eligible publication is content addressed' packages/database/src/control-plane.test.ts
```

Expected result: 1 failure; expected `/^sha384-/`, received the old `sha256-...`. After changing in-memory/PostgreSQL persistence and artifact verification, the same command passed 1/1.

Retained compiler runtime regression suite:

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=dot packages/compiler/src/compiler.test.ts
```

Result: 27 passed, 0 failed. Existing origin, schema, projection, response-bound, cancellation, deadline, retry, mutation replay, registration-race, confirmation, and diagnostic coverage was migrated rather than removed.

## Final verification

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
node node_modules/eslint/bin/eslint.js . --max-warnings=0
node scripts/lint-source.mjs
node scripts/check-source.mjs
git diff --check
```

All completed with exit 0 and no diagnostic output.

Full repository suite, using the trusted installed `tsx` requested in the brief:

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
```

Result: 178 tests, 173 passed, 0 failed, 5 skipped; duration 18.8 seconds. The skipped cases are the repository's PostgreSQL-dependent integration tests in an environment without the integration database.

## Self-review

- Confirmed there is no production `CompilableCapability`, compiler Acme/tool-name branch, `/api/confirmations` fallback, default request plan, or second positional compiler argument.
- Confirmed every production compiler caller passes complete plans, target origins are carried by and compared across plans, and control-plane replay uses the manifest plans losslessly.
- Confirmed generated artifacts contain no compiler dependency, control-plane secret, environment access, or fixture marker.
- Confirmed canonical sorting does not use locale-sensitive comparison and compiler output/hash/SRI are derived from the final exact bytes.
- Confirmed SHA-384 SRI is produced, persisted, served, and verified consistently while artifact URLs and ETags remain SHA-256 content-addressed.
- Confirmed all manual review findings were resolved before the final suite.

## Concerns

- Five PostgreSQL-dependent tests were skipped because no integration database was configured; TypeScript and the in-memory persistence contract cover the corresponding SHA-384 changes, but a live PostgreSQL run remains environment-dependent.
- The GitHub fixture runner now supplies one explicit complete fixture plan because the compiler correctly rejects an empty release. Replacing that fixture compatibility plan with source-derived plans belongs to the later GitHub source-path task; no fixture condition exists inside the production compiler.
- Production E2E/browser suites were outside this task's requested verification run and were not executed here; the generated modules are executed directly by the compiler contract tests.

---

## Independent review fix round 1

### Status and implementation

All 2 Critical, 9 Important, and 2 Minor findings in `task-1-review.md` were treated as blocking and fixed. This fix round is the commit containing this report section, applied after Task 1 commit `eddd08e`.

- **C1 — exact reviewed authorization unit:** `CapabilityRecord` and PostgreSQL capability rows now persist the complete canonical plan, its SHA-256 canonical digest, and the exact reviewed digest. Stable name and risk are derived from the plan. R1/R2 approval records bind the plan digest, all review/verification/publication paths revalidate the plan/name/risk/digest binding, capability-state digests include plan/review digests, and any same-name risk/request/auth/schema/effect substitution invalidates the gate. Legacy rows whose new nullable migration fields cannot be backfilled remain deliberately unpublishable.
- **C2 — redirects:** every generated fetch uses `redirect: "error"`. Real two-origin HTTP tests cover 301, 302, 303, 307, and 308 and prove the redirect sink receives no request, body, or idempotency header.
- **I1 — lifecycle:** caller, deadline, and release-lifecycle cancellation are composed for every execution. Reads and confirmed mutations abort in flight on lifecycle teardown. Duplicate registration waiters re-check controller/status after the shared promise and report `REGISTRATION_CANCELLED` rather than success.
- **I2 — CSRF:** raw CSS selectors were replaced by strict meta-name or hidden-input-name locators. Names and headers must be CSRF/XSRF-specific, credential/password/OTP/session markers are rejected, hidden controls must be unambiguous and non-autocomplete credential controls, and runtime resolution requires exactly one element.
- **I3 — immutable runtime semantics:** the module captures and binds fetch at evaluation. Public registration can only attach safe diagnostics and cannot replace transport or confirmation. Source-native confirmation is an explicit reviewed plan contract tied to exact evidence and captured at evaluation; otherwise the bundled closed-shadow dialog is mandatory. Confirmation inputs are immutable without freezing the `AbortSignal`.
- **I4 — exact immutable evidence:** fixture placeholders were replaced with real content digests. In-memory and PostgreSQL persistence store content, reference, source, exact organization/project/run ownership, and expiry. Ingestion, approval, verification, and publication recompute and resolve every cited reference. Publication obtains all exact evidence rows through a least-privilege security-definer locking function so retention cleanup serializes with the release transaction.
- **I5 — identity and corruption:** manifests carry a renderer digest, renderer-keyed release identity, and mandatory `sha256`/`sha384` trusted-loader integrity policy. Duplicate identity changes when runtime renderer bytes change even for identical plans. `verifyWebMcpReleaseBytes` rejects a still-parseable changed artifact before evaluation. No false in-module self-check is claimed: JavaScript cannot authenticate bytes that are already evaluating.
- **I6 — deterministic ordering:** all canonical plan, schema, evidence, capability, manifest-selection, and canonical-JSON sorting uses explicit code-unit/code-point comparison rather than locale-sensitive comparison.
- **I7 — exact bounded requests:** finite string/enum/array bounds, schema depth/property and total worst-case validation-work bounds, scalar-only mappings, exact URL/body byte caps, lowercase non-reserved non-colliding headers, and a compiler-level 64 KiB artifact cap now align generated candidates with persistence.
- **I8 — no unverified replay:** persistent in-memory/session recovery state is used only for verified header idempotency with `safe_once`. An unverified `retry: "none"` mutation receives a fresh ephemeral key per invocation and never persists or reuses ambiguous state.
- **I9 — JSON semantics:** poison keys (`__proto__`, `constructor`, `prototype`) are rejected recursively before Zod/object-literal reconstruction, so returned, persisted, and embedded canonical JSON cannot silently change semantics.
- **M1/M2:** 204/205 are rejected by the JSON response adapter contract; runtime length validation counts Unicode code points for input and output.

Additional production-alignment fixes made during self-review:

- Evidence must resolve before worker result ingestion and again before approval, not only at release time.
- PostgreSQL publication locks and returns every exact evidence row without granting the application role table-update authority.
- The production-topology integration test accepts an optional trusted `tsx` CLI path so the required separate worker can run without modifying macOS provenance metadata.

### Files changed in the fix round

- Core contract/compiler: `packages/capability-ir/src/plan.ts`, `packages/capability-ir/src/plan.test.ts`, `packages/compiler/src/compiler.ts`, `packages/compiler/src/compiler.contract.test.ts`, `packages/compiler/src/compiler.test.ts`, `packages/compiler/src/compiler.integrity.test.ts`.
- Persistence/release authorization: `packages/database/src/control-plane.ts`, `packages/database/src/control-plane.test.ts`, `packages/database/src/postgres.ts`, `packages/database/src/postgres.integration.test.ts`, `apps/control-plane/src/releases.ts`, `apps/control-plane/tests/release-route.test.ts`, `apps/control-plane/tests/capability-review-route.test.ts`, `apps/control-plane/tests/analyze-route.test.ts`, `apps/control-plane/tests/postgres-topology.integration.test.ts`, `supabase/migrations/20260829100000_capability_plan_authorization.sql`.
- Explicit fixture/result migration: `apps/acme-support/src/capability-plans.ts`, `apps/worker/src/runner.ts`, `apps/worker/src/runner.test.ts`.

### RED evidence

Focused tests were written before their corresponding changes. Representative expected failures:

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/capability-ir/src/plan.test.ts
```

Initial review regressions produced 6 failures: raw credential CSRF locators, locale-dependent Unicode property order, unbounded/non-scalar mappings, unsafe header collisions, poison-key loss, and 204/205 acceptance. A later focused credential-name case failed with `Missing expected exception` for `csrf-password`/`csrf-otp` before the sensitive-name rejection was added.

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/compiler/src/compiler.integrity.test.ts
```

Expected RED initially failed because `verifyWebMcpReleaseBytes` and mandatory renderer/integrity metadata did not exist. The later artifact-bound test failed with `Missing expected exception` before compilation enforced the 64 KiB persistence boundary.

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test apps/control-plane/tests/release-route.test.ts packages/database/src/control-plane.test.ts
```

Expected RED showed same-name risk/request/auth/schema substitutions passing shallow verification, and missing/changed/cross-run/expired references returning success. The ingestion/approval audit then produced exactly 2 failures (`Missing expected rejection`) before evidence was required at those boundaries.

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-name-pattern='bounds input schemas|larger than the persistence' packages/capability-ir/src/plan.test.ts packages/compiler/src/compiler.integrity.test.ts
```

Expected RED: 2 tests, 0 passed, 2 failed; both nested worst-case input validation and an oversized release were accepted before the final I7 bounds.

The duplicate-waiter race was also proved RED by temporarily removing the status re-check: the original registration reported cancellation while both waiters returned `{ supported: true, alreadyRegistered: true }`. Restoring the re-check made the strict concurrent behavior test pass.

### Focused GREEN evidence

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/capability-ir/src/plan.test.ts packages/database/src/control-plane.test.ts
```

Result: 28 passed, 0 failed.

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/database/src/control-plane.test.ts packages/database/src/postgres.test.ts packages/database/src/postgres.integration.test.ts apps/control-plane/tests/capability-review-route.test.ts apps/control-plane/tests/release-route.test.ts
```

Result without a configured database: 32 passed, 0 failed, 4 skipped. All exact plan/evidence release tests passed.

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/compiler/src/compiler.test.ts packages/compiler/src/compiler.contract.test.ts packages/compiler/src/compiler.integrity.test.ts
```

Result: all compiler/runtime, adversarial redirect/cancellation/CSRF/transport/confirmation/replay/Unicode/integrity tests passed. The integrity file finishes with 4/4, including renderer identity, parseable corruption rejection, and artifact size enforcement.

### Final verification

The macOS-provenance-stalled package-manager shims were not altered. TypeScript and tests were invoked through their trusted JavaScript entrypoints:

```text
node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
node node_modules/eslint/bin/eslint.js . --max-warnings=0 && node scripts/lint-source.mjs
node scripts/check-source.mjs
git diff --check
```

All exited 0 with no diagnostics.

```text
node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
```

Final result: 204 tests, 199 passed, 0 failed, 5 skipped; duration 16.0 seconds. The five skips are the environment-gated PostgreSQL cases, which were then run explicitly below.

```text
PAGE2WEBMCP_TEST_TSX_CLI=/Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs bash -c 'pnpm() { if [[ "$1" == "exec" && "$2" == "tsx" ]]; then shift 2; node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs "$@"; else command pnpm "$@"; fi; }; export -f pnpm; exec bash scripts/test-rls-local.sh'
```

The script was run with its two `pnpm exec tsx` calls routed to the same trusted CLI without changing provenance metadata. Result: every migration and standalone tenant/retention RLS assertion passed; PostgreSQL repository integration 4/4 passed; separate-worker production topology 1/1 passed; final output `Standalone PostgreSQL RLS and production-topology integration tests passed.`

Diff/security checks also confirmed no compiler fixture-name branch, legacy `CompilableCapability`, default request plan, locale-sensitive production comparator, redirect-following fetch, or per-execution mutable `globalThis.fetch` dereference remains.

### Residual dependency / concern

I5 necessarily depends on Task 8's trusted installation/loader layer. A self-registering ES module cannot securely hash or authenticate the bytes that have already started evaluating. This task therefore supplies mandatory integrity metadata, exact SHA-256/SHA-384 verification, a pre-evaluation verification helper, and renderer-keyed duplicate identity; Task 8 must make the trusted loader call that verification and refuse import/evaluation on mismatch. Directly importing generated bytes without that loader remains unsupported and must not be presented as corruption-safe.
