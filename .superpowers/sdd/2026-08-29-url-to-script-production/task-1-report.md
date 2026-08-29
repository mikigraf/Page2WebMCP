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
