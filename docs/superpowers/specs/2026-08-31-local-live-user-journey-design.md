# Page2WebMCP Local-Live User Journey Design

**Status:** Ready for written review

**Date:** 2026-08-31

**Scope:** Close the gap between the tested Acme fixture and an operator-run, Postgres-backed, non-Acme user journey without overstating production readiness.

## 1. Decision summary

Page2WebMCP will support three deliberately different execution profiles:

| Profile | Database and identity | Provider | Verification | `liveSuccess` |
| --- | --- | --- | --- | --- |
| Hermetic | Memory or isolated test Postgres; fixture identities | Local Acme/test adapters | Test verifier or compatibility shim | Always `false` |
| Local-live | Docker Supabase with non-owner runtime logins and a real non-Acme provider | `openapi`, `website`, or `github` with the provider's real controls | Real verifier over HTTPS or a separately labeled loopback verifier; never a test double | Always `false` |
| Live | Durable Postgres/Supabase and real provider controls | `openapi`, `website`, or `github` | External HTTPS verifier proves the exact installed bytes in native WebMCP on a normal page load | `true` only after that proof exists |

The first executable local-live reference path will be OpenAPI. It can exercise a real remote source without requiring Browser Use Cloud or a GitHub App. Website and GitHub remain accepted production modes, but their factories fail closed until all of their actual external controls are configured.

The normal user journey is:

```text
sign up with local Supabase Auth
  -> create a non-Acme project
  -> submit a real OpenAPI/website/GitHub source
  -> worker analyzes it through the selected live adapter
  -> review evidence-backed capabilities
  -> verify and publish the exact candidate
  -> receive <sha256>.js, SRI, script tag, and identical download
  -> install the script on the target origin
  -> external verifier loads the unmodified site and records native WebMCP proof
```

Acme remains a test fixture. It is never a source of local-live or live success.

## 2. Goals and non-goals

### Goals

1. Start PostgreSQL, Auth, Storage, Studio, and the remaining Supabase development services in Docker with the project-pinned CLI.
2. Replay every committed migration in lexical order, including `20260830190000_workflow_event_observability.sql`, then load only fixture seed identities.
3. Run the control plane, worker, and maintenance operations through separate non-owner database login principals.
4. Allow `PAGE2WEBMCP_PROVIDER_MODE=openapi|website|github` at startup and dispatch to the matching production adapter.
5. Store source-specific verification context with the project rather than requiring one deployment-wide target.
6. Prove one non-Acme OpenAPI path through the user-facing create, analyze, review, publish, download, script-tag, and installation-check surfaces using Docker-persisted state.
7. Preserve exact candidate bytes and hashes from analysis through publication and installation verification.
8. Make readiness output distinguish hermetic, local-live, configured-live, and genuinely installed-live states.
9. Document commands and missing operator credentials precisely enough that a new contributor can reproduce every locally available step.

### Non-goals

- Do not turn the local Supabase stack into a production deployment. Its HTTP endpoints and development credentials remain local-only.
- Do not invent Browser Use, GitHub App, egress proxy, public HTTPS, DNS ownership, CDN, or verifier credentials.
- Do not replace the bounded provider contracts with unrestricted `fetch`, browser, shell, or model access.
- Do not make a test double, intercepted route, injected registration, compatibility shim, or Acme fixture count as live verification.
- Do not merge a GitHub PR, execute high-risk website actions, or broaden the supported capability envelope.
- Do not add another workflow engine, queue, model agent, or cache.

## 3. Existing components retained

The implementation keeps the existing tenant-aware repository, forced RLS policies, durable leases, optimistic review versions, immutable release records, content-addressed artifact route, generic `CapabilityPlan`, deterministic compiler, release verifier contract, and provider packages.

The change is primarily production wiring and an executable local topology:

- `packages/providers/src/openapi.ts` remains the bounded OpenAPI fetch contract.
- `packages/providers/src/website.ts` and `browser-use-v4.ts` remain the website preflight, ownership, and browser-session contracts.
- `packages/providers/src/github.ts` and the existing GitHub live factory remain the GitHub path.
- `apps/worker/src/workflow.ts` remains the adapter layer that produces evidence-backed analysis results.
- `packages/compiler` remains the only bundle compiler.
- `apps/control-plane/src/release-verification.ts` remains the only candidate and installed verification boundary.
- The release artifact endpoint remains content-addressed for local operation. A production HTTPS reverse proxy/CDN or self-hosted copy is still required before a real HTTPS target can install it.

## 4. Local Supabase topology

### 4.1 Pinned CLI and lifecycle

Pin `supabase@2.116.0` as a development dependency and invoke it only through `pnpm exec supabase`. The global CLI is not part of the supported workflow.

The committed `supabase/config.toml` is the single local-stack definition. It keeps PostgreSQL 17 and enables Auth, Storage, Studio, and Inbucket. The supported commands will be:

```bash
pnpm local:up
pnpm local:reset
pnpm local:status
pnpm local:down
```

`local:up` starts the Docker stack and runs the idempotent local runtime-login bootstrap. `local:reset` runs `supabase db reset --local`, which destroys only the local development database, applies every migration in lexical order, runs `supabase/seed.sql` after migrations, and reruns the login bootstrap. Reset must print the migration list and fail if the latest observability migration is absent from migration history.

`supabase/seed.sql` continues to contain fixture identities and fixture memberships only. Those rows have no login password. A real local user signs up through Supabase Auth.

### 4.2 Authorization roles and login principals

The existing roles are authorization roles, not connection owners:

- `page2webmcp_app`
- `page2webmcp_worker`
- `page2webmcp_maintenance`

They remain `NOLOGIN`, `NOINHERIT`, non-superuser, and `NOBYPASSRLS`. Existing migrations own their grants and policies.

A committed loopback-only bootstrap creates three separate login principals:

- `page2webmcp_app_local` may `SET ROLE page2webmcp_app` only.
- `page2webmcp_worker_local` may `SET ROLE page2webmcp_worker` only.
- `page2webmcp_maintenance_local` may `SET ROLE page2webmcp_maintenance` only.

The bootstrap connects temporarily with the local Docker owner solely to create or rotate these login principals and grant the one matching authorization role. It refuses a database host other than the exact loopback addresses `127.0.0.1` or `[::1]`. It generates bounded random passwords into a gitignored local runtime environment file; no runtime password is committed.

The control plane receives the app login URL as `DATABASE_URL`. The worker launcher replaces `DATABASE_URL` with the worker login URL for that child process. Maintenance commands receive the maintenance login URL. Neither long-running process receives the owner URL.

Startup and integration checks query `current_user`, `rolsuper`, `rolbypassrls`, and role membership. A connection as `postgres`, `supabase_admin`, a superuser, a bypass-RLS role, or a login with more than its expected group membership fails closed.

### 4.3 Local control-plane and Auth exception

Production continues to require exact HTTPS origins. Local Supabase Auth and the local control plane need a narrow exception because the CLI exposes them over HTTP.

`PAGE2WEBMCP_LOCAL_STACK=true` permits HTTP only when all of these are true:

- the URL is an exact origin with no userinfo, query, fragment, or non-root path;
- the hostname is the IP literal `127.0.0.1` or `[::1]`;
- the URL is the Supabase API or control-plane origin;
- the process is not evaluating a provider target, artifact installation target, or release verifier URL.

This flag does not enable test adapters, relax SSRF rules, allow an HTTP source, allow an HTTP verifier in live mode, or change `liveSuccess`.

The local Auth configuration is obtained from `pnpm exec supabase status -o env`. Only the browser-safe local anon/publishable key is exposed to Next.js. Service-role and database-owner credentials remain server-only and are rejected from every `NEXT_PUBLIC_*` variable.

### 4.4 Local-live verifier exception

Some contributors cannot expose a public HTTPS verifier from a local machine. Local-live mode therefore has a separate, unmistakable verifier setting:

```text
PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN=http://127.0.0.1:<port>
PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN=<32-4096 characters>
```

It is accepted only when `PAGE2WEBMCP_LOCAL_STACK=true`, the hostname is the literal `127.0.0.1` or `[::1]`, and readiness runs with `--local-live`. `--live` never reads this variable and still requires `PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN` to be exact HTTPS.

The loopback verifier must still be a real browser verifier: it must execute the exact candidate or load the normal installed page and return the complete verifier report. A canned response, route interception, injected registration, compatibility shim, or synthetic harness is rejected. Verification records persist the distinct mode `local_live`; neither those records nor releases derived solely from them can satisfy production readiness. This is a transport exception, not an evidence exception.

Both verifier profiles implement an authenticated `POST /v1/readiness` handshake. The bounded JSON response contains only the verifier protocol version, verifier mode (`live` or `local_live`), and supported WebMCP implementation (`native`). The client requires status 200, `application/json`, the exact request URL without redirects, and a valid bounded response. The production endpoint must report `live`; the loopback endpoint must report `local_live`.

## 5. Runtime launch and process isolation

The current `pnpm dev` behavior remains the hermetic Acme developer demo. A separate command starts the actual persisted topology:

```bash
pnpm dev:local-live
```

That launcher requires the local Supabase stack and generated runtime environment file, starts the control plane and worker, and does not start Acme. It passes the app and worker different `DATABASE_URL` values and terminates both children on cancellation or failure.

Production continues to build and run control plane and worker as separate processes. The local launcher is convenience orchestration, not a production process manager.

The configuration contract is:

```text
PAGE2WEBMCP_STORAGE_MODE=postgres
PAGE2WEBMCP_PROVIDER_MODE=local|openapi|website|github
DATABASE_URL=<app non-owner URL in the control plane process>
PAGE2WEBMCP_WORKER_DATABASE_URL=<worker non-owner URL used by the launcher>
PAGE2WEBMCP_MAINTENANCE_DATABASE_URL=<maintenance non-owner URL>
NEXT_PUBLIC_SUPABASE_URL=<exact HTTPS origin, or exact loopback HTTP in local-stack mode>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<browser-safe key>
PAGE2WEBMCP_SESSION_SECRET=<32-4096 characters>
PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN=<exact public origin>
PAGE2WEBMCP_PUBLIC_ORIGIN=<exact immutable-artifact origin>
```

`local` remains the default only for hermetic development. The production worker entry point requires an explicit live provider mode; it must not silently fall back to Acme.

## 6. Provider dispatch

### 6.1 Common rules

`validateSharedRuntimeConfiguration` recognizes exactly `local`, `openapi`, `website`, and `github`. Any other value fails with `INVALID_PROVIDER_MODE`. Recognizing a mode does not imply its credentials are present: the selected factory performs its own full validation before the worker begins polling.

The worker builds exactly one analysis adapter and claims only that adapter's source type. A worker configured for OpenAPI cannot accidentally claim a website or GitHub job. Provider construction happens before the polling loop, so missing controls are a startup failure rather than a repeatedly leased job.

No live factory imports fixture data or recognizes Acme URLs, operation IDs, repositories, or capability names.

Source-specific settings are stored as a bounded, schema-validated configuration on `project_sources` and copied into the immutable analysis input. The source identity hash covers the canonical source URL and canonical source configuration. Changing a target origin, test page, environment, route allowlist, or other execution-relevant option therefore creates a new source version/snapshot instead of silently changing an in-flight run. The worker never reads these settings from an untrusted free-form JSON object; the repository returns a discriminated, typed source configuration.

An additive migration introduces the bounded configuration field and updates the existing app/worker grants and RLS policies without exposing it to `anon` or `authenticated`. Existing rows backfill to an explicit legacy-unconfigured marker. Website and GitHub derive the settings already held by their verified source/binding, while an existing OpenAPI project cannot begin a new analysis until the user supplies its required verification context.

### 6.2 OpenAPI reference path

OpenAPI worker mode requires only:

```text
PAGE2WEBMCP_PROVIDER_MODE=openapi
```

The project form requires the user to provide and review:

```text
sourceUrl=https://provider.example/openapi.json
targetOrigin=https://target.example
testPageUrl=https://target.example/webmcp-test
environment=test|staging|production
```

The source document URL, target origin, test page, and environment are stored with that project source. The target origin defines where the resulting browser bundle is allowed to execute; it and the test page must be exact HTTPS and same-origin. These values are visible again during review and installation.

A Node production factory implements the existing provider ports:

- DNS resolution returns all A and AAAA answers and rejects empty, private, loopback, link-local, multicast, documentation, and metadata ranges.
- Every redirect is resolved and checked again.
- The HTTPS transport connects only to one of the pinned public addresses while preserving the original hostname for TLS SNI and certificate verification.
- Redirects remain manual and same-origin; credentials are omitted.
- Response time, size, content type, redirect count, and reference depth retain the existing bounds.

The production factory supplies only the bounded DNS and HTTPS ports. `createOpenApiAnalysisAdapter` receives the immutable per-run verification context instead of a deployment-wide target. No model call is required for correctness. If semantic grouping is enabled later, deterministic validation remains authoritative.

Invalid project verification context is rejected before project creation with `OPENAPI_VERIFICATION_CONTEXT_REQUIRED`. A missing secure production transport fails worker startup with `OPENAPI_LIVE_CONFIGURATION_REQUIRED`. Network-policy failures remain stable provider diagnostics such as `OPENAPI_SSRF_BLOCKED`, `OPENAPI_TLS_VERIFICATION_FAILED`, or `OPENAPI_RESPONSE_TOO_LARGE`.

### 6.3 Website mode

Website mode is recognized but starts only when all real controls exist:

```text
PAGE2WEBMCP_PROVIDER_MODE=website
PAGE2WEBMCP_PUBLIC_ORIGIN=https://cdn.example
PAGE2WEBMCP_BROWSER_USE_API_KEY=<real Browser Use Cloud key>
PAGE2WEBMCP_EGRESS_PROXY_ORIGIN=https://proxy.example
PAGE2WEBMCP_EGRESS_PROXY_TOKEN=<32-4096 characters>
PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID=<KMS/TTL-secret-store key reference>
```

In addition, a project must have a durable ownership challenge and the configured egress proxy must issue an unexpired deny-by-default policy reference. The Browser Use factory must use API v4, model `browser-use-2.0`, ephemeral sessions, no recording/profile/workspace/memory, no uploads/downloads, and exact target allowlists. The explorer consumes only CDP references from the TTL secret store and uses the existing read-only firewall.

An API key without an egress proxy, ownership store, secret store, browser lease store, authentication handoff store, evidence store, or CDP observer is not a partial configuration. Startup fails with `WEBSITE_LIVE_CONFIGURATION_REQUIRED` and lists the missing environment keys in operator documentation, not in a secret-bearing response.

### 6.4 GitHub mode

GitHub mode retains the existing production factory and requires:

```text
PAGE2WEBMCP_PROVIDER_MODE=github
PAGE2WEBMCP_GITHUB_APP_ID=<numeric app id>
PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64=<real private key>
PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS=<bounded selected-repository JSON>
PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN=https://sandbox.example
PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN=<32-4096 characters>
```

Installation tokens remain one-hour, in-memory values; the worker analyzes an immutable commit and creates an idempotent draft PR. Missing App, repository, or sandbox controls fail startup. Missing webhook or preview controls block the phases that require them. The system never creates a fake PR and never merges.

## 7. Review, verification, publication, and installation

The release path continues to use the exact candidate produced from the reviewed `CapabilityPlan` set:

1. Analysis stores evidence, proposals, candidate code, candidate SHA-256, target origin, and manifest in Postgres.
2. The user approves or blocks capabilities through the normal UI with optimistic review versions.
3. Publication recompiles the reviewed subset deterministically and rejects any divergence from the stored candidate/provenance rules.
4. The selected real release verifier receives the exact code, SHA-256, SRI, target origin, manifest, and expected tools. An additive migration expands verification mode to `live|local_live|hermetic` and persists the protocol version and SHA-256 digest of the verifier origin with the run; no verifier token is stored.
5. Only an eligible candidate is inserted as a published immutable release.
6. `/api/releases/<sha256>.js` recomputes SHA-256 and SHA-384 before serving, uses immutable caching, exact target-origin CORS, `Cross-Origin-Resource-Policy: cross-origin`, hash ETag, and no cookies.
7. The download response contains identical bytes. The UI provides the module script tag, SRI, expected origin, previous immutable release, and self-hosting guidance.
8. Installation verification sends the normal page URL and exact artifact identity to the selected verifier. It rejects interception, injection, a synthetic harness, a compatibility shim, wrong origin/hash/tool set, or harmful duplicate loading.
9. A verified installation row must have `webmcp_implementation='native'`, the exact published release hash, the verification mode, verifier protocol version, and matching verifier-origin digest in its bounded attestation.

`PAGE2WEBMCP_PUBLIC_ORIGIN` is the one canonical artifact origin. It may equal `PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN`, or it may name a separate immutable CDN/reverse-proxy boundary. Website CSP preflight and release installation guides both use this same value. The local-stack exception may permit an exact loopback HTTP artifact origin for byte/hash testing and download, but the UI labels it local-only. Installing on a real HTTPS site requires either an operator-provided HTTPS value for `PAGE2WEBMCP_PUBLIC_ORIGIN` or the identical self-hosted file. A loopback HTTP artifact is never presented as a production installation.

## 8. Readiness semantics

The readiness command gains three explicit modes:

```bash
pnpm exec tsx scripts/check-release-readiness.ts --hermetic
pnpm exec tsx scripts/check-release-readiness.ts --local-live
pnpm exec tsx scripts/check-release-readiness.ts --live
```

### Hermetic

Checks pinned versions, migrations, RLS source assertions, and artifact-integrity tests. Success returns:

```json
{"status":"passed","code":"HERMETIC_READINESS_PASSED","liveSuccess":false}
```

### Local-live

Actively connects to Docker Postgres through the non-owner login, confirms the migration ledger and forced-RLS posture, constructs the selected non-local provider, and confirms the persisted non-Acme release/hash path. It may accept the narrow loopback Auth/control-plane exception and the separately configured real loopback verifier. Success returns:

```json
{"status":"passed","code":"LOCAL_LIVE_READINESS_PASSED","liveSuccess":false}
```

It never accepts a local provider, Acme source, test verifier, compatibility shim, intercepted route, or injected registration. Any verification evidence it records is marked `local_live` and cannot be reused as live evidence.

### Live

Requires all existing controls:

```text
PAGE2WEBMCP_PROVIDER_MODE=openapi|website|github
PAGE2WEBMCP_STORAGE_MODE=postgres
DATABASE_URL=<32-4096 character non-owner URL>
PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN=<exact HTTPS origin>
PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN=<32-4096 characters>
PAGE2WEBMCP_PUBLIC_ORIGIN=<exact HTTPS artifact origin>
PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN=<exact HTTPS application origin>
```

Those are the common controls, not the complete set. `--live` constructs the selected production provider before reporting readiness: OpenAPI must load a valid immutable project verification context and secure DNS/HTTPS transport; website must have every Browser Use, egress proxy, ownership, KMS/TTL-secret, lease, authentication, explorer, and evidence control; GitHub must have every App, repository-binding, token, and sandbox control. Missing selected-provider controls still return `LIVE_CONTROLS_REQUIRED` with `liveSuccess:false`.

The command performs a bounded authenticated compatibility/health handshake with the configured HTTPS verifier and then verifies that the database contains the explicitly selected published non-Acme release whose candidate verification mode is `live` and a matching successful installation attestation from that verifier, with normal unintercepted page load and native WebMCP. `PAGE2WEBMCP_READINESS_RELEASE_HASH` selects the exact 64-hex release. If it is absent or has no matching evidence, the result is `LIVE_INSTALLATION_EVIDENCE_REQUIRED`, not a scan for any tenant's latest success. Merely setting syntactically valid environment variables, presenting stale/unreachable controls, or presenting `local_live` evidence is insufficient for `liveSuccess:true`.

Once the Docker values, complete selected-provider controls, and external verifier values are present and reachable, `--live` must no longer return `LIVE_CONTROLS_REQUIRED`. Before a genuine selected installed attestation exists, it returns `LIVE_INSTALLATION_EVIDENCE_REQUIRED`, with `liveSuccess:false`. Only the matching native attestation returns:

```json
{"status":"passed","code":"LIVE_READINESS_PASSED","liveSuccess":true}
```

## 9. User-facing behavior

A new local user can:

1. Start the Docker stack and persisted application processes with documented commands.
2. Sign up through the real local Supabase Auth flow and receive a personal organization through the existing idempotent provisioning path.
3. Create an OpenAPI, website, or GitHub project from the project entry screen.
   For OpenAPI, this includes the target origin, same-origin test page, and environment.
4. See durable progress after refresh rather than an Acme-specific static project.
5. Review source identity, evidence, schemas, authentication, effects, risk, request plan, and diagnostics.
6. Approve supported capabilities and publish only after exact-candidate verification.
7. Copy the exact script tag or download identical bytes for self-hosting.
8. Submit the installed page for verification and see whether it is verified, awaiting self-hosting because of CSP, or failed with a stable reason.

Local-live UI copy explicitly says that Docker persistence and a real provider do not equal production verification. The release page shows `Production verified` only for a stored native installation attestation.

## 10. Error handling and fail-closed behavior

Configuration errors happen before a worker claims work. Public API and unprivileged UI errors remain stable codes without environment-variable names, raw URLs, credentials, response bodies, DOM, repository source, or provider messages. Exact missing environment names are emitted only by the operator-run readiness command, operator documentation/final report, or privileged redacted startup logs; values are never emitted.

Required distinctions include:

- `INVALID_PROVIDER_MODE`: the mode is not one of the four recognized values.
- `DATABASE_URL_REQUIRED` or `NON_OWNER_DATABASE_ROLE_REQUIRED`: persistence or least-privilege login is absent.
- `OPENAPI_LIVE_CONFIGURATION_REQUIRED`: exact target/test-page context or secure transport is absent.
- `WEBSITE_LIVE_CONFIGURATION_REQUIRED`: any Browser Use, proxy, ownership, secret, lease, authentication, explorer, or evidence control is absent.
- Existing GitHub configuration codes remain specific to App, repository binding, sandbox, and token failures.
- `RELEASE_VERIFIER_CONFIGURATION_REQUIRED`: verifier origin is not exact HTTPS or its token is absent/invalid.
- `LIVE_CONTROLS_REQUIRED`: one or more common or selected-provider live boundaries is absent, invalid, or unreachable.
- `LIVE_INSTALLATION_EVIDENCE_REQUIRED`: controls exist, but no matching real installed-native attestation exists.

Provider timeouts and classified network/429/5xx failures retain bounded retry behavior. Configuration, policy, SSRF, TLS, ownership, schema, and verification failures are permanent until the operator or user changes the input. Cancellation persists before signals propagate, and cleanup never converts an unknown external effect into success.

## 11. Test and verification strategy

Implementation follows test-first increments.

### Unit and contract tests

- Runtime configuration accepts the four exact modes and rejects unknown values.
- Each selected provider validates all of its own controls at construction.
- OpenAPI DNS/TLS transport covers public IPv4/IPv6, private and metadata denial, redirect re-resolution, rebinding, TLS/SNI mismatch, size, timeout, and content type.
- Local-stack HTTP exception accepts only IP-literal loopback Supabase/control-plane origins and never verifier/provider targets.
- Local-live verifier exception accepts only a separate IP-literal loopback setting, persists `local_live`, and is ignored by `--live`.
- Readiness preserves `liveSuccess:false` for hermetic and local-live results and refuses a fabricated attestation.
- Provider dispatch claims only the configured source type.

### Docker integration tests

- Start with the pinned CLI and run `supabase db reset --local`.
- Assert all migration versions, including `20260830190000`, exist in the ledger in lexical order.
- Assert every exposed application table has RLS enabled and expected tables have forced RLS.
- Connect separately as app, worker, and maintenance login principals; prove each is non-owner/non-superuser/non-bypass and cannot assume either of the other roles.
- Exercise signup, personal-organization provisioning, logout/reload, and cross-tenant denial.
- Run control plane and worker on their distinct login URLs and prove data survives process restart.

### Non-Acme acceptance journey

The automated conditional live test takes operator-supplied values rather than embedding a public service:

```text
PAGE2WEBMCP_E2E_SOURCE_URL
PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN
PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL
PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN
PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN
PAGE2WEBMCP_E2E_INSTALL_PAGE_URL
PAGE2WEBMCP_READINESS_RELEASE_HASH
```

When any value is absent, the live test is reported as blocked/skipped with the exact missing names and cannot set `liveSuccess`. When all are present, the test uses the actual UI/API and Docker Postgres to create, analyze, review, verify, publish, fetch, hash, download, install-check, and execute the native registered tools. It asserts:

- the source and target are not Acme and not loopback fixtures;
- hosted and downloaded bytes are identical;
- SHA-256, SRI, release ID, and installed hash match exactly;
- the target performs a normal page load without injection/interception;
- native WebMCP discovers the expected tools;
- one authenticated read and one approved reversible mutation reach the correct final state;
- tool execution makes no Page2WebMCP, model, or telemetry calls.

## 12. Documentation and operator handoff

`README.md`, `.env.example`, and `docs/OPERATIONS.md` will describe:

- supported Node 24, pnpm 10.14.0, Docker, and pinned Supabase CLI versions;
- exact local start, reset, status, stop, app, worker, test, and readiness commands;
- local URLs for Auth/API, Postgres, Studio, and Inbucket;
- how the non-owner database URLs are created and selected per process;
- the OpenAPI, website, GitHub, verifier, public-origin/CDN, and self-hosting variables;
- the difference among hermetic, local-live, and production-live results;
- why Acme is test-only and why an absent external control is a blocker rather than a simulated success;
- how to inspect migration history, RLS, workflow events, release hashes, and installation attestations.

The final implementation report must say exactly:

1. What ran successfully on Docker Supabase.
2. Which non-Acme journey steps were observed, including hashes and persistence evidence.
3. Which external controls were unavailable.
4. The exact missing environment variables and operator actions.
5. Whether production live success was genuinely achieved.

## 13. Acceptance criteria

The change is complete when all locally controllable criteria pass and external criteria are reported truthfully:

1. `pnpm local:up` starts Docker Supabase with PostgreSQL 17, Auth, Storage, Studio, and Inbucket.
2. `pnpm local:reset` replays every migration and the fixture-only seed without error.
3. App, worker, and maintenance processes use distinct non-owner login principals with only their intended role membership.
4. A new Auth user can sign up, receive a personal organization, create a project, and resume it after restart.
5. OpenAPI and website are no longer rejected as `LIVE_PROVIDER_UNSUPPORTED`; each either constructs its real adapter or returns its stable missing-control error before polling. Exact missing environment names appear only on operator-facing surfaces.
6. A real non-Acme OpenAPI source can produce evidence-backed plans and an origin-bound, auto-registering artifact persisted in Docker Postgres.
7. Review, exact-candidate verification, publication, immutable serving, identical download, script-tag generation, and installed-check are connected through the user-facing product.
8. Hermetic and local-live checks always return `liveSuccess:false`.
9. `--live` stops returning `LIVE_CONTROLS_REQUIRED` only after the Docker, selected-provider, artifact-origin, and reachable HTTPS-verifier controls all validate, but returns `LIVE_INSTALLATION_EVIDENCE_REQUIRED` until the explicitly selected release hash has a matching native installed attestation.
10. Only the real HTTPS verifier plus normal unintercepted native WebMCP installation can return `LIVE_READINESS_PASSED` with `liveSuccess:true`.
11. If the operator has not supplied Browser Use Cloud, GitHub App, egress proxy, public HTTPS artifact origin/CDN, target installation access, or live verifier credentials, the implementation stops at that boundary and names every missing environment variable on operator-facing surfaces only, without fabricating results.
