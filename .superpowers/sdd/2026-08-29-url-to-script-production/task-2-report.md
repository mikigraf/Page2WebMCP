# Task 2 report: standard form and semantic DOM runtime adapters

## Result

Implemented and verified in `53feb057f883c95d19c32c700d8c60c44465f122` (`feat: add semantic browser capability adapters`). The canonical `CapabilityPlan` is now a single discriminated union for `json_api`, `html_form`, and `semantic_dom`, and all three branches compile through the existing `compileWebMcpRelease(plans)` API. JSON remains the fixture and production source preference; the generated module still auto-registers without customer initialization.

## Implementation

- Added narrow semantic locator contracts for exact role/accessible-name, associated label, `name`, or an explicitly reviewed stable `data-*` application attribute. The IR has no arbitrary CSS/query selector, positional selector, transient class, or framework-private locator path.
- Added exact HTML form plans: a reviewed absolute same-origin action, GET/POST method, named scalar control mappings with schema-matched optionality, HTML content type, exact semantic success condition, semantic output projection, and reviewed error mappings.
- Added semantic DOM plans: a uniquely resolved scope, optional/required scalar input locators, read or non-navigating click action, exact semantic success condition, and bounded object output projection.
- Preserved the complete canonical plan as the authorization/replay unit. Adapter discriminators must agree, map and plan sorting is locale-independent, plans retain exact evidence references, and source-native confirmation remains bound to reviewed evidence.
- Added browser-specific cross-field validation for effect/action/method consistency, same-origin form actions, scalar and byte-bounded mappings, projection/source types, exact required outputs, safe-only form idempotency, and a blanket prohibition on DOM retry/idempotency.
- Extended the generated runtime with captured platform DOM operations, exact semantic resolution, native input/textarea/select/checked setters, bubbling `input` and `change` events, and captured native click. Sensitive controls, disabled controls, ambiguous/drifted nodes, cross-origin/navigating anchors, submit buttons, `formaction`, and `formtarget` fail closed.
- Form execution revalidates the exact form before and after confirmation/setters, constructs the reviewed URL-encoded request itself, uses captured same-origin fetch with `redirect: "error"`, parses a bounded HTML response with the captured DOM parser, checks the exact success condition, and projects only reviewed output.
- Page snapshots bind document identity and exact URL. Lifecycle/caller cancellation aborts work, DOM condition waits observe cancellation/navigation, and a page guard now remains active through both form fetch and streaming response consumption. Navigation during a stalled body cancels the stream with `STALE_PAGE`.
- Form mutations use the existing confirmation path. Unverified mutations never retry; only a reviewed, verified idempotency header or hidden form field can use one safe retry with the same pending key. DOM mutations cannot retry an ambiguous effect.
- Added a generic non-Acme hermetic browser fixture under test support. No fixture names or source-specific branches were added to production compiler or IR code.

## Files

- `packages/capability-ir/src/plan.ts`
- `packages/capability-ir/src/plan.adapters.test.ts`
- `packages/capability-ir/src/plan.test.ts`
- `packages/compiler/src/compiler.ts`
- `packages/compiler/src/compiler.adapters.test.ts`
- `packages/compiler/src/compiler.contract.test.ts`
- `packages/compiler/src/compiler.integrity.test.ts`
- `packages/compiler/src/compiler.test.ts`
- `test-support/semantic-browser-fixture.ts`
- `apps/acme-support/src/capability-plans.ts`
- `apps/control-plane/tests/release-route.test.ts`

## TDD evidence

### Initial IR RED

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/capability-ir/src/plan.adapters.test.ts
tests 6; pass 2; fail 4
```

The two incidental passes were rejection assertions already satisfied by the old JSON-only strict schema. The four positive/cross-field cases failed because the adapter union did not exist.

### Initial runtime RED

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/compiler/src/compiler.adapters.test.ts
tests 9; pass 0; fail 9
```

All browser execution cases failed before implementation because form and semantic DOM plans were rejected by the canonical plan schema.

### Navigation-through-body RED

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec --test-name-pattern='form cancellation' packages/compiler/src/compiler.adapters.test.ts
tests 1; pass 0; fail 1
AssertionError: Missing expected rejection
```

This adversarial case changed the page after response headers while its body stream remained open. It exposed that the first page guard ended at fetch resolution; the guard was extended through bounded body consumption.

### Focused GREEN

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/capability-ir/src/plan.test.ts packages/capability-ir/src/plan.adapters.test.ts packages/compiler/src/compiler.adapters.test.ts packages/compiler/src/compiler.contract.test.ts packages/compiler/src/compiler.integrity.test.ts packages/compiler/src/compiler.test.ts
tests 73; pass 73; fail 0; skipped 0
```

The targeted post-review navigation/cancellation run also passed 1/1, including stream cancellation and DOM caller cancellation.

### Affected suites

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/capability-ir/src/*.test.ts packages/compiler/src/*.test.ts apps/acme-support/tests/*.test.ts apps/control-plane/tests/*.test.ts packages/database/src/*.test.ts
tests 167; pass 162; fail 0; skipped 5
```

The five skips are existing PostgreSQL/environment-gated tests.

## Full verification

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
tests 219; pass 214; fail 0; skipped 5; duration 3946 ms
```

Direct gates, all exit 0:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check
```

The trusted `tsx` CLI was used as directed. No provenance/quarantine metadata was altered.

## Adversarial/self-review

- Verified production IR/compiler sources contain no Acme name, legacy `CompilableCapability`, arbitrary `querySelector` API, positional selector, or transient test/framework locator path.
- Verified wrong-origin form actions and role-masquerading cross-origin anchors fail before fetch/click, exact form structure fails on missing/duplicate/unreviewed named controls, target identity is re-resolved after input events, and exact document/URL drift is checked throughout effects and response consumption.
- Verified native operations and fetch/DOM parser/event constructors are captured at module evaluation, and registration/confirmation/transport hooks remain restricted to the Task 1 contracts.
- A representative three-plan JSON artifact is 50,779 bytes, leaving 14,757 bytes below the 64 KiB compiler/persistence boundary.

## Concerns and explicit limits

- These are hermetic browser-style doubles, not a claim of live browser/provider success. Live installation and provider validation remain later integration work.
- Task 1's installation-layer integrity dependency is unchanged: the generated module supplies exact integrity/runtime identity metadata, but Task 8's trusted loader must verify bytes before evaluation. A JavaScript module cannot authenticate bytes that have already begun evaluating.
- Semantic DOM mutation deliberately supports only reviewed non-navigating native clicks. Anchors and submit-like targets fail closed; broader navigation/submission behavior requires a separately reviewed future contract, not runtime inference.

## Fix round 1 — semantic mutation target and drift review

Implementation commit: `28e7ec06d16199b781ebea61ea1f23d7f0d6ec16` (`fix: constrain semantic DOM mutations`).

The independent review's 1 Critical and 1 Important finding were reproduced and fixed without a contested skip.

### C1 — generic scripted click targets

- Added a distinct canonical `SemanticClickLocator` contract. Mutation click locators must now bind an exact `button` or `input`; role targets must be the exact `button` role, and named/reviewed stable-attribute targets cannot declare generic elements.
- Runtime role resolution enforces the reviewed element tag. Immediately before dispatch, it re-resolves the exact target identity and mechanically requires an enabled native `button`/`input` with exact `type="button"`; submit defaults, other input types, `formaction`, and `formtarget` fail with `STALE_PAGE`.
- Added a browser regression whose generic `div[role=button]` handler would update the success state. The bundle now rejects before native click dispatch, with zero click calls and zero handler side effects.
- Added IR coverage that rejects a reviewed stable-attribute click target declared on a generic `div`. A cross-origin anchor likewise cannot satisfy the native-control locator and is classified as structural `STALE_PAGE` before click.

### I1 — zero-match/drift during DOM success waits

- The runtime captures the exact reviewed success node before confirmation/effect and revalidates both scope identity and success-node identity before click and on every wait iteration.
- A stable target whose value has not reached the reviewed condition continues to wait; zero match, multiple match, node replacement/removal, scope replacement/removal, document replacement, or URL drift throws `STALE_PAGE` immediately.
- Added a regression that removes the reviewed status node from the native button handler. It now rejects as `STALE_PAGE` rather than falling through to `DEADLINE_EXCEEDED`.

### RED

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec --test-name-pattern='generic scripted|disappearing reviewed' packages/compiler/src/compiler.adapters.test.ts
tests 2; pass 0; fail 2
both failures: AssertionError: Missing expected rejection
```

The generic role target executed its handler and returned success; the disappearing status target remained pending beyond the regression's bounded wait.

### Focused GREEN

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec --test-name-pattern='generic scripted|disappearing reviewed' packages/compiler/src/compiler.adapters.test.ts
tests 2; pass 2; fail 0

/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/capability-ir/src/plan.adapters.test.ts packages/capability-ir/src/plan.test.ts packages/compiler/src/compiler.adapters.test.ts packages/compiler/src/compiler.contract.test.ts packages/compiler/src/compiler.integrity.test.ts packages/compiler/src/compiler.test.ts
tests 75; pass 75; fail 0; skipped 0
```

### Affected and full verification

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec packages/capability-ir/src/*.test.ts packages/compiler/src/*.test.ts apps/acme-support/tests/*.test.ts apps/control-plane/tests/*.test.ts packages/database/src/*.test.ts
tests 169; pass 164; fail 0; skipped 5

/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test --test-reporter=spec test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
tests 221; pass 216; fail 0; skipped 5; duration 3556 ms
```

The five skips remain the existing PostgreSQL/environment-gated tests. Direct typecheck, ESLint, source lint, security policy, and `git diff --check` all exited 0. The trusted runner was used and no provenance metadata was changed.

The representative three-plan JSON artifact is now 51,024 bytes, leaving 14,512 bytes below the 64 KiB boundary. The pre-evaluation Task 8 trusted-loader dependency and hermetic-browser-test limitation remain unchanged.
