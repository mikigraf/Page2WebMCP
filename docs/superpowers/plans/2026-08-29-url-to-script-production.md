# Page2WebMCP URL-to-Script Production Implementation Plan

**Source of truth:** the user-provided “Page2WebMCP URL-to-Script Production Plan” in this session. This file decomposes that approved product contract into reviewable implementation tasks; it does not narrow the contract.

**Goal:** a previously unknown user can submit a verified non-Acme HTTPS website, authenticate in an isolated browser without surrendering credentials, review evidence-backed safe capabilities, receive one exact self-contained auto-registering JavaScript artifact, install it by script tag or identical self-hosted bytes, and verify native WebMCP reads plus a confirmed reversible mutation. OpenAPI and GitHub remain independently complete paths.

## Global Constraints

- The installed bundle contains no model or agent, embeds no secret, makes no Page2WebMCP/control-plane/telemetry call during tool execution, uses the website’s existing browser session, and fails closed.
- One canonical strict `CapabilityPlan` is the only compiler input and persisted reviewed unit. Every executable claim is tied to immutable evidence references. No production compiler or source-planning branch recognizes Acme names or operation IDs.
- Bundles are deterministic, origin-bound ES modules that auto-register through `document.modelContext.registerTool`, register nothing on wrong origin/unsupported WebMCP/corruption, prevent duplicate release registration, and connect lifecycle cancellation to navigation/unload where possible.
- Runtime adapters are preferred in this order: observed same-origin JSON API, standard semantic HTML form, stable semantic DOM bridge. Positional selectors, transient CSS classes, private framework protocols, and runtime model reasoning are forbidden.
- Runtime validates input/output, bounds time/body/content type, uses `credentials: "same-origin"`, resolves only reviewed stable CSRF mechanisms at execution time, maps stable logged-out/forbidden/stale/timeout/validation/target errors, and never retries a mutation without verified idempotency.
- Low-risk mutation confirmation is supplied by an encapsulated accessible bundle dialog unless an approved source-native host callback exists. R3/high-consequence actions are never generated.
- Every website/OpenAPI release exposes immutable hosted `<sha256>.js`, identical downloadable bytes, `manifest.json`, SHA-384 SRI, exact target origin, compatibility metadata, installation guidance, verification state, and previous immutable release.
- PostgreSQL is authoritative. State transitions, task effects, next-task creation, workflow version changes, and append-only events are transactional. Delivery is at least once with stable idempotency keys, bounded classified retries, 60-second leases, 15-second heartbeats, durable cancellation, checkpoints, and reconciliation.
- Use one deterministic workflow controller, one bounded browser explorer, at most one schema-constrained semantic grouping call, and deterministic compiler/verifier. No model spawns agents, mutates during discovery, approves, verifies, publishes, decides state, or treats page text as instructions.
- AuthZ derives from fresh Supabase identity plus database membership. Owner approves/publishes R2; editor creates/analyzes and reviews R0/R1; viewer reads; R3 is blocked.
- Browser Use integration uses the current supported, explicitly pinned Cloud API/model. As of implementation, official docs designate API v4 as current; provider configuration must include a custom deny-by-default egress proxy, no profile/workspace/recording/skills/agentmail, live authentication handoff, CDP observation, and guaranteed stop/reconciliation.
- All external-provider paths have hermetic contract tests and fail closed when credentials or mechanically enforced security controls are absent. Tests may not claim live success from a simulator.
- TDD is mandatory for every production behavior: add a focused failing test, observe the expected failure, implement minimally, run focused green tests, then run the full suite once per task before commit.

## Task 1: Canonical CapabilityPlan and generic auto-registering compiler

**Files:** create `packages/capability-ir/src/plan.ts`; replace the shallow compiler input in `packages/compiler/src/compiler.ts`; update compiler tests and the minimum fixture/call sites required to compile.

1. Define a strict, versioned `CapabilityPlan` schema and type containing target origin; tool name/title/description; input and internal output JSON Schemas; read/untrusted annotations; authentication; effects/risk/reversibility/confirmation; idempotency; exact JSON request plan with method/path template/path-query-body mappings; optional reviewed meta/DOM CSRF resolution; response content types/projection/error mappings; success conditions; and non-empty immutable evidence references.
2. Reject unknown fields, duplicate tool names, R3, unsafe origins/paths/method-effect combinations, missing evidence, mutation retry without verified idempotency, unstable CSRF selectors, unsupported schema constructs, and any referenced input/output field that is absent or optional when execution requires it.
3. Canonicalize semantically unordered fields and tool ordering so equivalent plans produce byte-identical code, SHA-256 content hashes, and SHA-384 SRI.
4. Delete Acme/default request plans. The compiler accepts only complete validated plans.
5. Generate a self-contained ES module with complete plans and no runtime dependency. On evaluation it validates origin and `document.modelContext.registerTool`, atomically prevents duplicate registration for the release, registers all tools, exports diagnostic registration state for tests/support, and aborts registrations on pagehide/beforeunload.
6. Preserve strict input/output projection, bounded JSON response/content-type handling, total timeout/caller cancellation, same-origin credentials, exact origin checks before each effect, stable structured errors, and safe idempotent mutation retry only when declared.
7. Supply an encapsulated accessible confirmation dialog for approved low-risk mutations. No customer-authored initialization is required; optional source-native confirmation hooks cannot replace execution semantics.
8. Update fixture callers to pass explicit complete plans without introducing production Acme branches.
9. Tests must execute generated modules (not grep source) and cover arbitrary non-Acme plans, canonical-order determinism, auto-registration, wrong-origin/unsupported/duplicate loads, schema/auth/error/cancellation/response bounds, CSRF resolution, confirmation denial/approval, mutation replay, secret/control-plane absence, and SHA-256/SHA-384 metadata.

## Task 2: Standard form and semantic DOM runtime adapters

**Files:** extend `packages/capability-ir/src/plan.ts`, `packages/compiler/src/compiler.ts`, and compiler browser-style tests; add a generic semantic fixture only under test support.

1. Add strict discriminated adapters for a standard HTML form and a stable semantic DOM bridge, retaining JSON API as first preference.
2. Resolve forms/actions/methods/control names and DOM targets uniquely through roles, accessible names, labels, names, or explicitly reviewed stable application attributes; reject zero/multiple matches and any positional/transient selector.
3. Apply inputs with native setters/events, honor caller cancellation/navigation, require deterministic reviewed success conditions, project bounded output, and return `STALE_PAGE` on drift.
4. Mutations use the same confirmation/idempotency rules and never auto-retry an ambiguous DOM/form effect.
5. Test real DOM behavior with non-Acme markup, ambiguous/missing targets, state change, cancellation, confirmation, and drift.

## Task 3: Generic independent OpenAPI path

**Files:** refactor `packages/openapi/src/compile.ts`; add provider/fetch boundary under `packages/providers`; integrate its output with the canonical plan; update worker and OpenAPI tests.

1. Securely accept bounded URL bytes or upload bytes, validate OpenAPI 3.0/3.1/3.2 with pinned `@redocly/openapi-core@2.45.0`, disable external references by default, and preserve bounded local-reference/cycle/resource controls.
2. Extract arbitrary operations, request/response schemas, security schemes/scopes, serialization, errors/examples, and deterministic effect/risk indicators without operation-ID maps.
3. Permit one bounded schema-constrained semantic grouping call behind a port; deterministically validate every grouping and provide a deterministic no-model grouping path for tests.
4. Produce complete evidence-backed CapabilityPlans for browser-safe same-origin cookie/public/OAuth operations; otherwise produce an explicit server-adapter requirement or precise unsupported diagnostic.
5. Require target origin/test page and test environment before production verification.
6. Test non-Acme 3.0/3.1/3.2 JSON/YAML corpora, auth/serialization, hostile refs, ambiguous schemas, high-risk operations, rate-limit/auth/error behavior, and deterministic output.

## Task 4: Secure website preflight, ownership, browser handoff, and evidence explorer

**Files:** add website/provider contracts and live Browser Use v4 adapter under `packages/providers`; extend `packages/security`; add worker website exploration modules and tests.

1. Implement HTTPS/public-address/redirect/DNS-rebinding/CSP/public-page preflight and DNS TXT or exact `/.well-known/page2webmcp-verification.txt` ownership challenges.
2. Create an ephemeral Browser Use Cloud v4 run/browser with explicit pinned model, no persistent profile/workspace/recording/skills/agentmail, exact route/origin allowlist enforced by the custom outbound deny proxy, and TTL secret references for live/CDP URLs.
3. Pause durably for human authentication through the live view; resume without extracting credentials.
4. Attach Playwright/CDP observation, a mechanically enforced GET/HEAD-only discovery firewall, and bounded navigation/action/time/evidence budgets. Treat page text as data.
5. Record immutable sanitized DOM/accessibility/network/navigation/state evidence and blocked mutation candidates; derive plans only from deterministic evidence and adapter preference order.
6. Stop/reconcile the provider session in every exit path. Fail closed when proxy, provider version, secret store, or CDP guarantees are unavailable.
7. Test with hermetic provider/HTTP/CDP doubles plus a real local non-Acme authenticated fixture: read discovery, blocked mutation, authorized controlled mutation phase, injection content, SSO redirect, rebinding, expiry, cancellation, provider failure, and cleanup.

## Task 5: Durable phased workflow substrate and controller

**Files:** add a Supabase migration; extend in-memory/Postgres repositories; replace monolithic worker dispatch; add API routes and fault/concurrency tests.

1. Add `project_sources`, `source_snapshots`, `workflow_runs`, `workflow_tasks`, `workflow_events`, `workflow_evidence`, `capability_plans`, `verification_checks`, and `installations`, linking existing immutable releases/verification records rather than duplicating them.
2. Implement the approved workflow states and event vocabulary from the source plan with monotonic sequence/version, stable task idempotency, input/output hashes, checkpoints, wait keys, cancellation timestamps, lease generation, attempt/budget fields, retry classification, and reconciliation metadata.
3. Enforce legal transitions and transition+event+next-task atomicity in both repositories/SQL. Keep current analysis tables as a compatibility projection until all callers move.
4. Implement fair tenant-aware claiming, organization quotas, 60-second lease/15-second serialized heartbeat, three transient attempts with full-jitter exponential backoff and bounded `Retry-After`, durable cancel-first propagation, auth/ownership waits that consume no worker, idempotent resume, and a reconciler.
5. Implement a deterministic phase registry for preflight, ownership, browser auth, explore, propose, review wait, controlled mutation verification, compile, candidate verify, publish, and install verify. Models/providers cannot transition state directly.
6. Tests cover every legal/illegal transition, crash at every boundary, stale completion, duplicate delivery, cancellation races, resume replay, reconciliation, maximum evidence, and two-tenant load in memory and PostgreSQL.

## Task 6: Supabase Auth SSR identity, organizations, projects, and authorization

**Files:** control-plane auth clients/routes/middleware/UI; database migration/RLS policies; auth/project tests.

1. Replace fixture sessions in production with `@supabase/ssr` signup, email verification, login, recovery/update, logout, refresh/revocation, and idempotent personal-organization provisioning. Fixture auth remains explicitly test-only.
2. Derive every actor from fresh server identity plus membership; never accept UI roles. Enforce owner/editor/viewer/R3 policy and same-origin CSRF on mutations.
3. Add durable cursor-paginated project list/detail/resume endpoints and UI; remove silent limits and Acme source restrictions while preserving secure normalization and idempotency.
4. Force RLS and explicit grants/policies on every exposed table and test new user, reload/new tab, recovery/logout/revocation, duplicate requests, pagination, and cross-tenant denial.

## Task 7: Source-native GitHub App path

**Files:** provider contract/live GitHub App adapter, source analyzer, webhook/callback routes, worker phase, sandbox abstraction, tests.

1. Implement repository-scoped GitHub App installation and one-hour installation token generation without persistence; validate immutable installation/repository/commit identity.
2. Analyze a bounded immutable commit for supported Next.js App Router/TypeScript routes/forms/handlers/validation/auth/services and derive canonical plans plus concrete source-native runtime/install changes.
3. Run build/type/tests in an isolated resource/network-bounded sandbox without provider/database credentials.
4. Reconcile an idempotent branch and linked draft PR; validate signed timestamped delivery-ID-deduplicated webhooks, installation/repository/commit, checks, and preview when present. Never merge.
5. Test a non-Acme repository fixture, malicious source, replay, duplicate PR, failed build, retry/reconciliation, and a live staging PR only when dedicated credentials exist.

## Task 8: Exact candidate verification, immutable publication, and installed-target proof

**Files:** verifier package/worker phases; release records/routes/storage; installation routes; Acme fixture consumption; tests/e2e.

1. Compile exact reviewed plans once, persist candidate bytes/hash/manifest, inject those exact bytes into the verified real target session, and execute schema/auth/read/mutation/confirmation/final-state/replay/selection/leakage checks.
2. Publish only that verified hash to the immutable artifact boundary. Serve `<sha256>.js` and `manifest.json` with JavaScript/JSON types, immutable cache, exact-origin CORS, CORP cross-origin, content-hash ETag, no cookies/credentials, and SHA-384 SRI. Download bytes are identical.
3. Return exact script tag, expected origin, WebMCP/browser compatibility, CSP result, framework installation guidance, verification state, and prior immutable release. Require detected self-host hash when CSP blocks hosted delivery.
4. Installed verification loads the normal target without injection/interception and confirms the exact hash auto-registered expected tools and executes required final-state checks.
5. Remove Acme’s independent release route/manual loader; make it consume only a normal published/self-hosted release.
6. Tests cover corrupt/stale candidates, publication races, byte/manifest/SRI/header identity, hosted/self-hosted install, unsupported browser/CSP, unintercepted auto-registration, authenticated read, one confirmed reversible mutation, and absence of runtime control-plane/model calls.

## Task 9: Complete workflow UI, observability, operations, and golden gates

**Files:** control-plane project workflow UI/APIs, observability packages, E2E/golden suites, CI/config/docs.

1. Implement ownership and live-browser auth handoffs; evidence/schema/auth/effect/risk/request-plan/provenance review; optimistic approve/block/unblock; verify/publish/copy/download/install-check; retry/resume/cancel/recovery and actionable diagnostics for all three paths.
2. Make database workflow events authoritative and export correlated nested OTel/Langfuse observations with hashes/redaction/batching/graceful flush. Restrict PostHog to the approved pseudonymous funnel with grouping, profiles/autocapture/replay disabled.
3. Add metrics/health/readiness/alerts, pinned versions, separate immutable build targets, migration/retention/reconciliation processes, SBOM/security scans, restore/rollback drills, and provider-drift promotion gates.
4. Replace synthetic/intercepted acceptance tests with the full golden matrix, including non-Acme URL-to-installed-script, independent OpenAPI/GitHub, crash/resume/cancel, safety negatives, exact hosted/self-hosted bytes, and current Chrome native WebMCP. Simulator-only tests are labeled and never satisfy live gates.
5. Update README/architecture/operations/demo to state the actual supported envelope and precise fail-closed diagnostics.

