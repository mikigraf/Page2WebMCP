# Task 3 report: generic bounded OpenAPI source path

## Result

Implemented in `e488063` (`feat: compile bounded OpenAPI capabilities`). The former operation-ID/Acme map is gone. Bounded OpenAPI 3.0, 3.1, and 3.2 sources now produce deterministic, complete canonical `CapabilityPlan` values for browser-safe JSON operations and compile through the existing `compileWebMcpRelease(plans)` path. Production compiler, provider, and worker branches contain no Acme name, fixture URL, or fixture operation ID.

## Implementation

- Replaced `packages/openapi/src/compile.ts` with generic extraction for arbitrary paths and operations. It resolves bounded local references, incorporates exact same-origin server base paths, normalizes scalar path/query/header mappings, supports bounded JSON and URL-encoded object bodies, derives bounded response schemas/content types/success statuses/documented error mappings, and emits canonical plans with exact target origin and immutable evidence URNs.
- Pinned `@redocly/openapi-core` at exactly `2.45.0`. Provider bytes are parsed and resource-checked before the Redocly minimal structural validation path, so external references cannot be fetched by validation. JSON/YAML source size, depth, node, alias, reference, cycle, schema-depth, property, and operation counts are bounded.
- Added precise fail-closed diagnostics for malformed/unsupported schemas and serialization, cookie parameters, server mismatch, ambiguous authentication, server-only API keys/password/client credentials, unsafe secret-bearing headers, missing CSRF review, missing mutation/effect review, and R3 operations. Explicit side-effect metadata on GET cannot be downgraded to R0.
- Extended only the existing `json_api` `CapabilityPlan` discriminator with reviewed headers, optional flat mappings, and `json`/`form_urlencoded` body encoding. Cross-field validation requires exact input optionality, scalar mappings, non-credential headers, safe security-header separation, and conservative exact wire-byte bounds.
- Extended the existing generated runtime to serialize optional query/body/header mappings and form bodies. URL, URLSearchParams, Headers, TextEncoder, and TextDecoder are captured at module evaluation so later page-code replacement cannot change reviewed transport semantics.
- Added deterministic one-operation fallback grouping and one optional schema-constrained grouping call. The port receives only bounded method/path/name data, is limited to one call and five seconds, and its UTF-8 response must cover every extracted operation exactly once without invented names or operations.
- Added `packages/providers/src/openapi.ts`: a provider-neutral URL fetch contract requiring explicit DNS resolution and transport controls. Every hop uses HTTPS validation, public resolved addresses, transport pin inputs, manual redirects, omitted credentials, exact response URL, same-origin redirects, strict content types, streaming byte caps, fatal UTF-8 decoding, total timeout, and prompt caller cancellation. Private upload bytes use the same content-type/size/UTF-8/digest contract.
- Added a generic worker OpenAPI adapter. Exact source-byte digest, OpenAPI version, target origin, test page, and environment are bound into immutable evidence content; the plans reference its content hash. The worker has no default fixture behavior and fails with `ANALYZER_NOT_CONFIGURED` unless an explicit adapter is supplied.
- Moved the autonomous Acme workflow into `test-support/fixture-workflow.ts`; existing route/demo tests inject complete fixture results explicitly.

## Files

- `packages/openapi/src/compile.ts`
- `packages/openapi/src/compile.test.ts`
- `packages/providers/src/openapi.ts`
- `packages/providers/src/openapi.test.ts`
- `packages/capability-ir/src/plan.ts`
- `packages/capability-ir/src/plan.test.ts`
- `packages/compiler/src/compiler.ts`
- `packages/compiler/src/compiler.test.ts`
- `packages/security/src/security.ts`
- `apps/worker/src/workflow.ts`
- `apps/worker/src/workflow.test.ts`
- `apps/worker/src/runner.ts`
- `apps/worker/src/runner.test.ts`
- `apps/control-plane/tests/analyze-route.test.ts`
- `test-support/fixture-workflow.ts`
- `test-support/demo.ts`
- `package.json`
- `pnpm-lock.yaml`

## TDD RED evidence

The initial focused tests were added before implementation. They failed at the missing contract boundaries:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/openapi/src/compile.test.ts
module link failure: compileOpenApiWithGrouping was not exported

/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/providers/src/openapi.test.ts
ERR_MODULE_NOT_FOUND: packages/providers/src/openapi.ts

/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test apps/worker/src/workflow.test.ts
module link failure: createOpenApiAnalysisAdapter was not exported
```

Focused adversarial RED runs during implementation exposed the exact unsafe behavior before each fix:

```text
--test-name-pattern='serializes reviewed headers' packages/compiler/src/compiler.test.ts
tests 1; pass 0; fail 1
error: PAGE_REPLACEMENT_CALLED

--test-name-pattern='bounds form-encoded request bodies' packages/capability-ir/src/plan.test.ts
tests 1; pass 0; fail 1
AssertionError: Missing expected exception

--test-name-pattern='behavior-changing siblings' packages/openapi/src/compile.test.ts
tests 1; pass 0; fail 1
the $ref target compiled and silently ignored the behavior-changing sibling

--test-name-pattern='request-body optionality' packages/openapi/src/compile.test.ts
tests 1; pass 0; fail 1
both conditionally-required/required-empty request bodies incorrectly produced plans

--test-name-pattern='never downgrades explicit' packages/openapi/src/compile.test.ts
tests 1; pass 0; fail 1
the explicitly side-effecting GET incorrectly produced an R0 plan

--test-name-pattern='canonicalizes safe header' packages/capability-ir/src/plan.test.ts
tests 1; pass 0; fail 1
AssertionError: Missing expected exception for X-Client-Secret

--test-name-pattern='diagnoses cookie parameters' packages/openapi/src/compile.test.ts
tests 1; pass 0; fail 1
format/minProperties/numeric-enum and secret-header operations were not diagnosed

--test-name-pattern='binds exact source bytes' apps/worker/src/workflow.test.ts
tests 1; pass 0; fail 1
immutable evidence omitted target origin, test page, and environment

--test-name-pattern='caller cancellation' packages/providers/src/openapi.test.ts
tests 1; pass 0; fail 1; duration 102 ms
expected OPENAPI_FETCH_ABORTED; received OPENAPI_FETCH_TIMEOUT
```

## Focused GREEN evidence

Each adversarial test above was rerun immediately after its minimal implementation and passed 1/1. The final affected slice was:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/capability-ir/src/plan.test.ts packages/compiler/src/compiler.test.ts packages/openapi/src/compile.test.ts packages/providers/src/openapi.test.ts packages/security/src/security.test.ts apps/worker/src/workflow.test.ts apps/worker/src/runner.test.ts apps/control-plane/tests/analyze-route.test.ts test-support/demo.test.ts
tests 92; pass 92; fail 0; skipped 0; duration 1129 ms
```

The OpenAPI compiler's final focused run passed 19/19, covering generic 3.0/3.1/3.2 extraction, exact server paths and request mappings, auth/server-adapter diagnostics, effects, grouping, refs, hostile content, Redocly validation, and resource limits. Provider tests passed 5/5 and worker adapter tests passed 2/2.

## Full verification

```text
rg --files -g '*.test.ts' -g '*.test.mjs' | sort | xargs /usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test
tests 238; pass 233; fail 0; skipped 5; duration 3464 ms
```

The five skips are the existing PostgreSQL/environment-gated integration tests.

Direct gates, all exit 0:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check
```

The production fixture-name scan returned no matches (the expected `rg` exit status was 1):

```text
rg -n 'Acme|acme|fixture|findOrder|getOrderStatus|createSupportTicket' packages/openapi/src/compile.ts packages/providers/src/openapi.ts apps/worker/src/workflow.ts apps/worker/src/runner.ts
```

No provenance or quarantine metadata was changed. A representative three-plan artifact is 51,959 UTF-8 bytes, below the compiler's 65,536-byte artifact boundary.

## Adversarial/self-review

- Verified canonical ordering uses code-unit comparisons rather than locale-sensitive sorting, including plan records, operations, scopes, groups, and DNS pins.
- Verified the exact source-byte digest and verification context resolve through immutable evidence, while hostile examples/descriptions/secret-shaped operation IDs do not appear in plans, evidence content, manifest, or artifact bytes.
- Verified local `$ref` resolution rejects behavior-changing siblings and cycles; external refs are blocked before Redocly runs.
- Verified unrepresentable conditional body presence, unsupported validation keywords, non-scalar serialization, no-content JSON responses, ambiguous multi-schema responses, and unsafe servers fail closed instead of producing weakened plans.
- Verified runtime request constructors and fetch are captured, optional fields are omitted deterministically, form encoding uses native URLSearchParams semantics, and both static and runtime wire-byte checks remain in force.
- Verified no production Acme/default request-plan fallback remains and the persisted/reviewed output is the single canonical `CapabilityPlan` IR.

## Concerns and explicit limits

- No live DNS/HTTP transport is claimed. This task supplies the explicit resolver/transport contract and hermetic provider tests; a deployment integration must mechanically honor `pinnedAddresses`. The standalone worker intentionally fails closed until such controls are configured.
- No model provider or credentials are configured. The deterministic fallback is complete; the optional grouping port is only an interface with strict input/output/time bounds.
- Website and GitHub live adapters remain unconfigured in this task and therefore fail closed rather than retaining the former fixture implementation.
- `compileOpenApi` is the source-native API for already parsed/prevalidated in-memory documents. The production worker path always calls `validateOpenApiSource` first; callers that ingest provider bytes must do the same.
- Task 1's trusted-loader dependency is unchanged: the generated artifact includes mandatory integrity/runtime identity metadata, but installation must verify bytes before JavaScript evaluation.
