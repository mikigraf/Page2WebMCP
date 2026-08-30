# Task 4 report: secure website source analysis pipeline

## Result

Implemented in `99ad56d` (`feat: add secure website analysis pipeline`) with final TLS transport hardening in `6bf0458` (`fix: require website TLS attestation`). A generic website URL source now has an explicit hermetic path through bounded preflight, exact ownership proof, one leased Browser Use Cloud v4 session, optional durable authentication handoff, GET/HEAD-only observation, immutable evidence, deterministic canonical-plan proposal, and the existing `compileWebMcpRelease(plans)` compiler.

No live Browser Use, DNS, HTTP, vault, proxy, or durable-state success is claimed. Production use remains fail-closed until deployment implementations satisfy every explicit provider contract and attestation described below.

## Implementation

### Website preflight and ownership

- Added `packages/providers/src/website.ts` with an explicit resolver/transport boundary. It accepts only HTTPS URLs without embedded credentials, query, or fragment; resolves at most 16 public addresses per hop; passes sorted pins to the transport; requires manual redirects and omitted credentials; and verifies the actual connected address remains one of the pins.
- Every transport response must attest an authorized TLS 1.2/1.3 connection for the exact requested hostname. Missing, unauthorized, obsolete-protocol, or wrong-server-name attestations fail with `WEBSITE_TLS_VERIFICATION_FAILED`.
- Redirects are bounded and same-origin only. DNS, TLS, response URL, and connected-address checks repeat on every hop. Cross-origin redirects, private/loopback/link-local/multicast/metadata destinations, and rebinding fail before response bytes are accepted.
- Public-page reads enforce total time, streaming byte, status, and HTML/XHTML content-type bounds. Only the SHA-256 identity of the bounded HTML is returned; raw HTML is not persisted by preflight.
- The preflight result includes a deterministic CSP report for the configured hosted-script origin. A restrictive CSP becomes an explicit worker diagnostic rather than being silently ignored.
- Ownership verification supports exact DNS TXT and exact same-origin `/.well-known/page2webmcp-verification.txt` challenges. Tokens are base64url-shaped and bounded, challenge lifetime is at most 15 minutes, replay is consumed through an explicit durable port, and evidence stores only the token digest plus exact origin/method/expiry. The short challenge expiry is not reused as the immutable evidence retention expiry.

### Browser Use Cloud v4, discovery firewall, and authentication

- Added `packages/providers/src/browser-use-v4.ts` as the explicit provider seam. The request pins API version `v4` and model `browser-use-2.0`, one exact domain/origin, a deny-by-default proxy policy reference, a ten-minute maximum TTL, ephemeral state, and the following disabled controls: recording, profile, workspace, persisted memory, downloads, uploads, skills, and agentmail.
- The provider must return an attestation digest for the exact canonical policy request. Missing or mismatched controls fail before CDP/live references reach the explorer.
- Raw live/CDP URLs are immediately exchanged through a secret-reference port. Only exact-expiry opaque `secretref:` values leave the adapter; raw URLs are never returned in analysis state or evidence.
- A durable lease port receives organization/project/run/origin/policy identity and is responsible for enforcing one active browser per project. Duplicate claims fail without starting a provider effect.
- `withBrowserUseCloudV4Session` owns provider startup, cancellation, secret-reference revocation, stop, reconcile, and lease release. Startup receives the caller signal. Success, explorer failure, provider-policy drift, and cancellation paths are covered.
- Added a durable auth handoff port with explicit open/wait/close lifecycle. Resume requires bounded deterministic same-origin state signals; wrong-origin, empty/unknown state, expired handoff, MFA timeout, caller cancellation, and any credential-shaped completion material fail closed. The evidence contains no live reference or credential material.
- Extended `createDiscoveryFirewall` so discovery permits only same-origin public GET/HEAD document/subresource observation. POST/PUT/PATCH/DELETE, private/cross-origin destinations, downloads, uploads, and unrelated tools are denied. Page text is accepted only as inert data and cannot change the decision.

### Immutable evidence and deterministic plan proposal

- Added `packages/providers/src/website-evidence.ts`. It accepts only allowlisted observation facts: exact same-origin navigations, strict structured semantic locators, bounded network/form/DOM facts, auth signals, blocked mutations, and state transitions.
- Unknown top-level and nested locator fields are discarded; raw prompts, screenshots, cookies, authorization values, CSRF values, browser URLs, and provider secrets are not part of the evidence schema. The existing recursive sanitizer is applied as a second defense.
- Counts are bounded to 100 events/fields per category, semantic strings and schema lengths are bounded, and the final canonical UTF-8 evidence content is capped at 64 KiB. Evidence is linked to exact organization/project/run, provider version/model/policy digest, and target origin, then stored under its SHA-256 URN. Store identity mismatch and later content/ownership corruption fail closed.
- Proposal consumes and verifies the immutable evidence directly; there is no second executable IR. For each logical action it prefers observed JSON API, then standard HTML form, then semantic DOM facts and constructs the existing `CapabilityPlan` discriminator only.
- Only mechanically safe read observations are proposed automatically. Multiple preferred observations, unsupported response types, blocked discovery mutations, mutation candidates, and R3 facts produce stable diagnostics. Empty observations produce a diagnostic-only result rather than an invalid empty release.
- Every proposed plan is parsed by `CapabilityPlanSchema`, canonicalized, binds the exact runtime evidence reference, and flows through `compileWebMcpRelease(plans)`. Existing Task 1/2 confirmation, idempotency, semantic-locator, evidence, integrity, and runtime invariants are unchanged.

### Worker orchestration

- Added `createWebsiteAnalysisAdapter` to `apps/worker/src/workflow.ts`. It requires every network, ownership, replay, browser, lease, vault, explorer, auth, and evidence control explicitly; there is no default live implementation or fixture fallback.
- The deterministic sequence is preflight -> ownership -> one browser session -> one public observation -> optional durable auth -> at most one authenticated observation -> bounded evidence -> deterministic proposal -> compile. The browser wrapper reconciles in every exit path.
- Analysis results contain content-addressed ownership, runtime observation/auth, and preflight evidence. Raw ownership tokens and provider URLs are absent. Restrictive CSP, blocked mutations, unsupported candidates, and no-capability outcomes remain visible as diagnostics without inventing an artifact.

## Files

- `packages/providers/src/website.ts`
- `packages/providers/src/website.test.ts`
- `packages/providers/src/browser-use-v4.ts`
- `packages/providers/src/browser-use-v4.test.ts`
- `packages/providers/src/website-evidence.ts`
- `packages/providers/src/website-evidence.test.ts`
- `packages/security/src/security.ts`
- `packages/security/src/security.test.ts`
- `apps/worker/src/workflow.ts`
- `apps/worker/src/workflow.test.ts`

## Strict TDD RED evidence

The first test in each slice was written before its implementation.

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/providers/src/website.test.ts
tests 1; pass 0; fail 1
ERR_MODULE_NOT_FOUND: packages/providers/src/website.ts

/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/providers/src/browser-use-v4.test.ts packages/security/src/security.test.ts
tests 17; pass 15; fail 2
ERR_MODULE_NOT_FOUND: packages/providers/src/browser-use-v4.ts
discovery download was incorrectly allowed

/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test packages/providers/src/website-evidence.test.ts
tests 1; pass 0; fail 1
ERR_MODULE_NOT_FOUND: packages/providers/src/website-evidence.ts

/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test apps/worker/src/workflow.test.ts
tests 1; pass 0; fail 1
createWebsiteAnalysisAdapter was not exported
```

Adversarial review regressions also demonstrated the unsafe behavior before the fixes:

```text
--test packages/providers/src/browser-use-v4.test.ts packages/providers/src/website-evidence.test.ts apps/worker/src/workflow.test.ts
tests 16; pass 13; fail 3
provider startup received no AbortSignal
nested screenshot/canary locator data was persisted
ownership evidence inherited the five-minute challenge expiry

--test packages/providers/src/website-evidence.test.ts
tests 6; pass 3; fail 3
blocked mutation observations emitted no diagnostic
empty evidence called canonicalizeCapabilityPlans([]) and threw

--test-name-pattern='requires exact authorized modern-TLS' packages/providers/src/website.test.ts
tests 1; pass 0; fail 1
unauthorized TLS attestation was accepted
```

## GREEN evidence

Focused slices after implementation/hardening:

```text
packages/providers/src/website.test.ts
tests 7; pass 7; fail 0

packages/providers/src/browser-use-v4.test.ts packages/security/src/security.test.ts
tests 22; pass 22; fail 0

packages/providers/src/website-evidence.test.ts
tests 6; pass 6; fail 0

apps/worker/src/workflow.test.ts
tests 5; pass 5; fail 0

packages/providers/src/website.test.ts apps/worker/src/workflow.test.ts
tests 12; pass 12; fail 0; duration 730 ms
```

An affected Task 1-4 run before the final hardening passed 103/103, covering the worker/runner/database, security, canonical plan, compiler contract, and browser runtime adapter suites.

## Full verification

The final exact tree was run with the trusted TSX requested by the brief:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts
tests 264; pass 259; fail 0; skipped 5; duration 4243 ms
```

The five skips are the existing environment-gated PostgreSQL/control-plane integration tests.

Direct gates all exited 0 on the exact final tree:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit --pretty false
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check
```

The production fixture-name scan returned no matches:

```text
rg -n 'Acme|acme|fixture' packages/providers/src/website.ts packages/providers/src/browser-use-v4.ts packages/providers/src/website-evidence.ts apps/worker/src/workflow.ts
```

No provenance or quarantine metadata was changed.

## Adversarial/self-review

- Verified every preflight and well-known HTTP hop binds URL, public DNS pins, actual connected address, exact TLS hostname/protocol authorization, redirect origin, content type, byte cap, and total deadline.
- Verified ownership cannot be inferred from HTML or redirect state, the raw token never enters evidence, and replay consumption precedes success.
- Verified provider page/live/CDP secrets are confined to the vault boundary and all persisted browser identity is opaque and expiring.
- Verified browser policy sorting/digests use code-point comparisons, not locale-sensitive ordering.
- Verified mutation requests remain blocked by both the Browser Use deny-proxy contract and local firewall; discovery facts can only produce read plans.
- Verified arbitrary nested locator keys cannot smuggle screenshots/prompts into evidence, exact evidence bytes are rehashed before proposal, and outer ownership must match inner ownership.
- Verified zero-plan output remains a valid diagnostic-only analysis with no release, preserving the Task 3 persistence invariant.
- Verified no production Acme/default behavior, source-specific operation map, or second executable IR was added.

## Concerns and explicit limits

- There is no credentialed live Browser Use Cloud run in this task. `v4` and `browser-use-2.0` are pinned by the reviewed contract, but a deployment adapter must validate current provider compatibility and must fail if any requested control or exact policy attestation is unavailable.
- Resolver, HTTP/TLS transport, deny-by-default proxy, secret vault, browser lease, ownership challenge/replay store, durable auth handoff, explorer/CDP implementation, and immutable evidence store are explicit ports, not live implementations. A production adapter must derive TLS/pin attestations from the real socket and enforce project-level lease uniqueness; merely echoing requested fields is not sufficient.
- The explorer is intentionally hermetic in tests. It is bounded by one public plus at most one authenticated pass, the Browser Use session TTL, the worker deadline, the GET/HEAD firewall, and evidence/action count limits. No optional model navigator is implemented, so there are zero model attempts and no raw model prompt surface in this task.
- CSP is reported and restrictive policy is diagnosed; this task does not rewrite a customer CSP or claim installation success.
- Mutation candidates are never executed or proposed during discovery. Controlled, reversible post-review mutation verification remains Task 8 work.
- The five PostgreSQL/environment integrations were not runnable in this workspace. The new result shape uses the already-tested Task 3 `AnalysisResult` persistence contract, but no live Postgres run is claimed here.
- Task 1's trusted-loader dependency remains: installation must verify artifact bytes/integrity before JavaScript evaluation.
