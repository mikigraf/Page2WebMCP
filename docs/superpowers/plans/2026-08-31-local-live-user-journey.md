# Page2WebMCP Local-Live User Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the locked three-path user journey with Docker-persisted local-live OpenAPI, fail-closed real website/GitHub startup, exact Supabase Storage artifacts, and production `liveSuccess` only for an explicitly selected release with native installation evidence.

**Architecture:** Keep the Task 1–9 capability IR, compiler, repository, workflow leases, verifier, release, installation, and RLS boundaries unchanged. Add typed immutable source configuration at `project_sources`; select exactly one live adapter at worker startup; publish verified candidate bytes through a small Supabase Storage port; and evaluate readiness from controls plus persisted, hash-bound verifier evidence. Local lifecycle scripts create narrowly privileged loopback login principals and never expose the database owner or Storage secret to the browser.

**Tech Stack:** TypeScript 5.9, Node 24, pnpm 10.14.0, Next.js 16 App Router, PostgreSQL 17, Supabase Auth/Storage/CLI 2.116.0, Zod 4, Node test runner, Playwright.

**Specs:** `docs/superpowers/specs/2026-08-31-local-live-user-journey-design.md` and locked addendum `docs/superpowers/specs/2026-08-31-local-live-user-journey-design.addendum.md`.

## Global constraints

- Work only in `.worktrees/url-to-script`; preserve the completed Task 1–9 behavior and tests.
- Never invent Browser Use, GitHub, proxy, KMS, Storage, verifier, ownership, sandbox, or target credentials.
- Never make hermetic or local-live evidence set `liveSuccess:true`; never accept Acme, a loopback artifact, a shim, injection, interception, or a fabricated PR as live proof.
- A production worker constructs exactly one adapter before polling and claims only its source type.
- Exact missing environment-variable names are operator-only; public APIs receive stable codes.
- Published Storage bytes are the verified candidate bytes. SHA-256, SHA-384 SRI, served bytes, download bytes, release identity, and installed evidence must agree.
- Keep the control-plane `/api/releases/<sha256>.js` route only as a local integrity fallback; production installation URLs come from this app's Supabase Storage bucket.

---

### Task 1: Pin Supabase CLI and make the Docker topology reproducible

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Modify: `supabase/config.toml`
- Create: `scripts/local-supabase.mjs`
- Create: `scripts/local-runtime-roles.mjs`
- Create: `scripts/dev-local-live.mjs`
- Test: `test-support/local-supabase.test.ts`
- Test: `packages/database/src/postgres.integration.test.ts`

**Interfaces:**
- `pnpm local:up|local:reset|local:status|local:down` invokes only `pnpm exec supabase`.
- `scripts/local-runtime-roles.mjs` accepts only exact loopback Postgres owner URLs and writes `.page2webmcp/local.env` with distinct app, worker, and maintenance login URLs.
- The public bucket name is the literal `page2webmcp-releases`; its local public prefix is `http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases`.

- [ ] **Step 1: Write failing static/lifecycle tests**
  - Assert `supabase` is pinned to `2.116.0`, package scripts use `pnpm exec`, Storage declares the public release bucket, and `.page2webmcp/` is ignored.
  - Assert the role bootstrap rejects non-loopback hosts and produces three distinct bounded secrets without printing them.

- [ ] **Step 2: Pin and verify the CLI**
  - Run `pnpm add -D -E supabase@2.116.0` and `pnpm exec supabase --version`; if this exact binary cannot run, pin the newest runnable 2.x and record the evidence in operations docs and the final report.

- [ ] **Step 3: Implement lifecycle and least-privilege login bootstrap**
  - Start/reset/status/stop Docker Supabase, print/check the complete lexical migration ledger, require `20260830190000`, and run the idempotent loopback-only role bootstrap.
  - Create login principals that can assume only one existing `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS` application role; refuse owner/superuser/bypass-RLS runtime connections.

- [ ] **Step 4: Implement the local-live launcher**
  - Load generated local variables, pass separate database URLs to control plane and worker, start no Acme process, forward cancellation, and stop both children on failure.

- [ ] **Step 5: Run tests and a real local reset**
  - Run `pnpm exec tsx --test test-support/local-supabase.test.ts`.
  - Run `pnpm local:up`, `pnpm local:reset`, and the role-membership integration assertions.

- [ ] **Step 6: Commit**
  - `git add package.json pnpm-lock.yaml .gitignore supabase/config.toml scripts test-support/local-supabase.test.ts packages/database/src/postgres.integration.test.ts`
  - `git commit -m "chore: add pinned local Supabase topology"`

### Task 2: Persist typed per-project source configuration

**Files:**
- Modify: `packages/database/src/workflow.ts`
- Modify: `packages/database/src/control-plane.ts`
- Modify: `packages/database/src/postgres.ts`
- Create: `supabase/migrations/20260831090000_source_configuration.sql`
- Modify: `apps/control-plane/src/projects.ts`
- Modify: `apps/control-plane/app/api/projects/route.ts`
- Modify: `apps/control-plane/app/api/projects/[projectId]/route.ts`
- Test: `packages/database/src/control-plane.test.ts`
- Test: `packages/database/src/postgres.integration.test.ts`
- Test: `packages/database/src/source-configuration-migration.test.ts`
- Test: `apps/control-plane/tests/projects-route.test.ts`

**Interfaces:**

```ts
type SourceConfiguration =
  | { kind: "openapi"; targetOrigin: string; testPageUrl: string; environment: "test" | "staging" | "production" }
  | { kind: "website" }
  | { kind: "github" };
```

- Store canonical bounded configuration in `public.project_sources.source_configuration` and `private.analysis_jobs.source_configuration`.
- Include canonical source configuration in the immutable source identity hash and copy it into every claimed analysis job.
- Backfill existing rows to an explicit legacy-unconfigured marker that cannot start a new live OpenAPI analysis.

- [ ] **Step 1: Write failing schema/repository/API tests**
  - Cover required same-origin HTTPS target/test page, bounded environment enum, canonical serialization, hash changes, immutable job copy, tenant isolation, and legacy rejection with `OPENAPI_VERIFICATION_CONTEXT_REQUIRED`.

- [ ] **Step 2: Generate the additive migration with the pinned CLI**
  - Run `pnpm exec supabase migration new source_configuration`, then edit it to add constraints, backfill, forced-RLS-compatible grants, and worker access without exposing the field to `anon` or `authenticated`.

- [ ] **Step 3: Implement the discriminated repository contract**
  - Parse database JSON into the typed union at the repository boundary; reject free-form/unrecognized keys.
  - Update in-memory and PostgreSQL create/enqueue/claim/list paths and source snapshot hashes.

- [ ] **Step 4: Bind the project API**
  - Make OpenAPI creation require the verification context and return the active typed source from project detail; keep website/GitHub source shapes strict.

- [ ] **Step 5: Run focused and PostgreSQL tests**
  - Run project/repository/migration tests, reset local Supabase, and run the explicit database integration cases.

- [ ] **Step 6: Commit**
  - `git commit -am "feat: persist typed source verification context"`

### Task 3: Expose all three truthful source paths in the UI

**Files:**
- Modify: `apps/control-plane/app/project-entry.tsx`
- Modify: `apps/control-plane/src/client-workflow.ts`
- Modify: `apps/control-plane/app/globals.css`
- Test: `apps/control-plane/tests/next-structure.test.ts`
- Test: `apps/control-plane/tests/project-source-pagination.test.ts`
- Test: `e2e/user-journey.spec.ts`

**Prerequisite:** Before editing Next.js application files, read the relevant forms/client-components/routing guidance under `node_modules/next/dist/docs/` as required by `apps/control-plane/AGENTS.md`.

- [ ] **Step 1: Write failing UI persistence tests**
  - Prove website, OpenAPI, and GitHub are simultaneously visible and selectable.
  - Prove OpenAPI shows/source-persists `sourceUrl`, `targetOrigin`, `testPageUrl`, and `environment`; refresh hydrates server state rather than stale browser defaults.
  - Prove blocked provider configuration is presented as an unavailable stable code and never as a successful analysis.

- [ ] **Step 2: Implement the source-specific form and resume projection**
  - Add semantic labels, descriptions, validation feedback, and local-only/production-verification copy.
  - Preserve current review, publish, download, copy-script, installation-check, retry, cancel, and resume actions.

- [ ] **Step 3: Run focused UI tests and browser smoke**
  - Run the Next structure/route tests and the real local Auth/project-create refresh flow when Docker is running.

- [ ] **Step 4: Commit**
  - `git commit -am "feat: expose three source journeys with durable context"`

### Task 4: Implement the bounded production OpenAPI transport

**Files:**
- Create: `apps/worker/src/node-network.ts`
- Create: `apps/worker/src/openapi-live.ts`
- Modify: `apps/worker/src/workflow.ts`
- Test: `apps/worker/src/node-network.test.ts`
- Test: `apps/worker/src/openapi-live.test.ts`
- Test: `apps/worker/src/workflow.test.ts`
- Test: `packages/providers/src/openapi.test.ts`

**Interfaces:**
- `createConfiguredOpenApiAnalysisAdapter(environment, dependencies)` validates startup controls and supplies only the existing bounded resolver/HTTPS provider ports.
- Adapter verification context comes from the claimed immutable `sourceConfiguration`, not deployment-wide environment variables.
- The transport pins a resolved public A/AAAA address while retaining the requested hostname for TLS SNI/certificate verification; it does not follow redirects itself.

- [ ] **Step 1: Write failing network policy tests**
  - Cover public IPv4/IPv6, empty DNS, private/loopback/link-local/multicast/documentation/metadata denial, DNS rebinding, TLS/SNI mismatch, abort/timeout, bounded bodies, and no credential forwarding.

- [ ] **Step 2: Implement Node DNS and HTTPS ports**
  - Use explicit `node:dns/promises` and `node:https`; return the transport metadata already required by the provider contract.
  - Never use unrestricted global `fetch` for the source document.

- [ ] **Step 3: Refactor OpenAPI adapter context to per-run data**
  - Parse the claimed source configuration, enforce exact HTTPS/same-origin test page, and return `OPENAPI_LIVE_CONFIGURATION_REQUIRED` only for missing operator transport construction.

- [ ] **Step 4: Run focused adapter/provider tests**

- [ ] **Step 5: Commit**
  - `git add apps/worker/src packages/providers/src/openapi.test.ts && git commit -m "feat: add bounded live OpenAPI transport"`

### Task 5: Dispatch exactly one real provider and fail closed before polling

**Files:**
- Modify: `apps/control-plane/src/config.ts`
- Modify: `apps/worker/src/production-runtime.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/website-live.ts`
- Modify: `apps/worker/src/github-live.ts`
- Test: `apps/control-plane/tests/config.test.ts`
- Test: `apps/worker/src/production-runtime.test.ts`
- Test: `apps/worker/src/website-live.test.ts`
- Test: `apps/worker/src/github-live.test.ts`

**Interfaces:**
- Recognize only `PAGE2WEBMCP_PROVIDER_MODE=local|openapi|website|github`.
- Production worker rejects `local`; hermetic launch owns that adapter.
- Every runtime has one `analysisSourceTypes` member and construction completes before the polling loop.
- `websiteMissingControls(env)` is a sorted set of the exact operator keys required by the existing Browser Use v4 factory: real API key, exact egress/ownership/control endpoints, KMS-backed TTL secret store, browser lease, auth handoff, evidence, CDP observer, and public artifact prefix.

- [ ] **Step 1: Write failing mode/dispatch/startup tests**
  - Prove each mode builds/claims only its matching source type.
  - Prove missing website controls throw `WEBSITE_LIVE_CONFIGURATION_REQUIRED` before `claimAnalysis`; operator diagnostics name missing keys without values.
  - Retain GitHub tests for selected repository bindings, immutable commit SHA, isolated sandbox, one idempotent draft PR, and never merge/fabricate.

- [ ] **Step 2: Widen shared configuration without weakening provider factories**
  - Keep public failures stable and emit detailed missing-key arrays only from privileged startup/readiness reporting.

- [ ] **Step 3: Construct real adapters**
  - OpenAPI uses Task 4.
  - Website assembles the existing Browser Use v4/preflight/ownership/lease/evidence contracts only when every real port is configured; enforce API `v4`, model `browser-use-2.0`, exact origin/route allowlists, ephemeral sessions, and `recording/profile/workspace/memory/uploads/downloads=false`.
  - GitHub keeps the existing App factory; never introduce a local or fake fallback.
  - Non-GitHub runtimes use a controller with no unrelated GitHub side effects.

- [ ] **Step 4: Run focused startup tests and prove no job was leased on configuration failure**

- [ ] **Step 5: Commit**
  - `git commit -am "feat: select one fail-closed production provider"`

### Task 6: Publish exact candidate bytes to Supabase Storage

**Files:**
- Create: `apps/control-plane/src/artifact-storage.ts`
- Test: `apps/control-plane/tests/artifact-storage.test.ts`
- Modify: `supabase/config.toml`
- Create: `supabase/migrations/20260831100000_release_artifact_storage.sql`
- Test: `packages/database/src/release-artifact-storage-migration.test.ts`
- Modify: `apps/control-plane/src/config.ts`

**Interfaces:**

```ts
interface ReleaseArtifactStore {
  publish(input: {
    code: string;
    contentHash: string;
    integrity: string;
    targetOrigin: string;
  }, signal: AbortSignal): Promise<{
    artifactUrl: string;
    downloadUrl: string;
    contentHash: string;
    integrity: string;
  }>;
}
```

- Fixed public bucket: `page2webmcp-releases`; fixed key: `<sha256>.js`.
- Server-only credentials: `PAGE2WEBMCP_SUPABASE_URL` and `PAGE2WEBMCP_SUPABASE_SECRET_KEY`; reject either from `NEXT_PUBLIC_*`.
- `PAGE2WEBMCP_PUBLIC_ORIGIN` is the exact Storage public URL prefix, not the control-plane origin.
- Upload with JavaScript content type, immutable cache metadata, and `upsert:false`; on object-exists, fetch and byte-verify rather than overwrite.

- [ ] **Step 1: Write failing artifact-port contract tests**
  - Exact object key, no overwrite, bounded abort/timeout, safe error codes, no secret in errors, and rejection of a mismatched public prefix/project/bucket.
  - Re-fetch public serving and download URLs; assert both byte streams equal candidate, SHA-256, and SHA-384 SRI.

- [ ] **Step 2: Generate bucket migration/config**
  - Create the public bucket idempotently with object-size and JavaScript MIME bounds; allow public object reads while writes remain server-only.
  - Keep RLS/privileges explicit and run Supabase database/storage advisors after applying hosted changes.

- [ ] **Step 3: Implement the Storage port**
  - Keep Supabase secret server-only, set no cookies, use content-addressed idempotency, and fail closed if a pre-existing object differs.

- [ ] **Step 4: Run local Docker Storage contract**
  - Upload a non-Acme candidate into Docker Storage, GET both URLs, and record matching bytes/hash/SRI.

- [ ] **Step 5: Commit**
  - `git add apps/control-plane/src/artifact-storage.ts apps/control-plane/tests/artifact-storage.test.ts supabase && git commit -m "feat: publish immutable bundles to Supabase Storage"`

### Task 7: Connect publication and installation to the stored artifact identity

**Files:**
- Modify: `apps/control-plane/src/releases.ts`
- Modify: `apps/control-plane/app/api/projects/[projectId]/releases/route.ts`
- Modify: `apps/control-plane/app/api/projects/[projectId]/installations/route.ts`
- Modify: `packages/database/src/control-plane.ts`
- Modify: `packages/database/src/postgres.ts`
- Create: `supabase/migrations/20260831110000_release_artifact_identity.sql`
- Test: `apps/control-plane/tests/release-route.test.ts`
- Test: `apps/control-plane/tests/release-verification.test.ts`
- Test: `packages/database/src/postgres.integration.test.ts`

- [ ] **Step 1: Write failing exact-byte publication tests**
  - Verification persists first; Storage receives those exact candidate bytes; DB release and returned guide use the Storage identity.
  - Simulate Storage mismatch/upload failure/DB failure/idempotent retry and prove no corrupt or falsely installed release is returned.
  - Prove hosted/download/self-host identities and previous immutable release URL stay content-addressed.

- [ ] **Step 2: Persist the canonical artifact URL/prefix identity**
  - Add only the fields necessary to ensure later installation verification cannot reconstruct a different control-plane URL.

- [ ] **Step 3: Inject the artifact store into publication**
  - Publish candidate bytes, verify public retrieval, insert/reconcile immutable DB release, and build the exact Storage script tag.
  - Mark loopback HTTP artifacts `localOnly:true`; never allow them to satisfy live installation evidence.

- [ ] **Step 4: Verify installation against the persisted artifact URL**
  - Send the verifier the stored hash/SRI/URL and normal target page; reject mismatch, injection, interception, synthetic harness, compatibility shim, or non-native implementation.

- [ ] **Step 5: Run route, verifier, repository, and Docker Storage tests**

- [ ] **Step 6: Commit**
  - `git commit -am "feat: bind releases to exact Storage artifacts"`

### Task 8: Persist verifier identity and implement truthful three-mode readiness

**Files:**
- Modify: `apps/control-plane/src/release-verification.ts`
- Modify: `packages/database/src/control-plane.ts`
- Modify: `packages/database/src/postgres.ts`
- Modify: `packages/operations/src/readiness.ts`
- Modify: `scripts/check-release-readiness.ts`
- Create: `supabase/migrations/20260831120000_live_readiness_attestation.sql`
- Test: `apps/control-plane/tests/release-verification.test.ts`
- Test: `packages/operations/src/readiness.test.ts`
- Test: `test-support/readiness-cli.test.ts`
- Test: `packages/database/src/postgres.integration.test.ts`

**Interfaces:**
- CLI flags are mutually exclusive: `--hermetic | --local-live | --live`.
- `--live` never reads `PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN`.
- Live verifier requires exact HTTPS origin/token and a bounded authenticated `POST /v1/readiness` response `{ protocolVersion, mode:"live", webMcpImplementation:"native" }` with no redirect.
- `PAGE2WEBMCP_READINESS_RELEASE_HASH` selects exactly one 64-hex release; no “latest success” scan.
- Readiness query uses a maintenance-only database connection and returns only bounded artifact/evidence identity, not tenant data or candidate code.

- [ ] **Step 1: Write failing pure and CLI truthfulness tests**
  - Hermetic/local-live always false.
  - Missing controls names are sorted operator-only diagnostics.
  - Complete controls without selected native evidence yield `LIVE_INSTALLATION_EVIDENCE_REQUIRED` and false.
  - Only same hash, Storage HTTPS prefix, `verification_mode=live`, matching verifier origin digest/protocol, normal native installation, and all negative flags false yield `LIVE_READINESS_PASSED` and true.

- [ ] **Step 2: Add `local_live` and verifier provenance additively**
  - Persist verification mode, protocol version, and SHA-256 verifier-origin digest; persist matching bounded install attestation.
  - Grant the maintenance role the minimum read-only identity projection required by readiness.

- [ ] **Step 3: Implement readiness provider construction and verifier handshake**
  - Validate common controls, construct the selected real provider before DB polling, check the exact Storage public prefix, then perform verifier health and selected-hash evidence lookup.
  - Local-live actively checks Docker migration/RLS/non-owner/provider/Storage state but remains false.

- [ ] **Step 4: Run focused tests and negative live probes**
  - Prove plausible environment strings and fabricated DB rows cannot make live success true.

- [ ] **Step 5: Commit**
  - `git commit -am "feat: require native selected-hash live evidence"`

### Task 9: Document/operator surfaces and conditional hosted publication

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `.github/workflows/ci.yml`
- Create: `e2e/local-live-openapi.test.ts`
- Create: `e2e/live-installation.test.ts`
- Test: `test-support/documentation.test.ts`

- [ ] **Step 1: Write failing documentation/conditional-acceptance tests**
  - Require the pinned CLI version, exact commands, local URLs, separate roles, all three provider key sets, Storage bucket/prefix, local/live verifier distinction, missing-control exit semantics, and no Acme/live conflation.

- [ ] **Step 2: Document and expose operator diagnostics**
  - Public UI/API show only stable codes; privileged startup/readiness output names missing variables without values.
  - Record hosted project ref `bimqgiedckdurqiywctl` and the intended public prefix without recording any database password or Storage secret.

- [ ] **Step 3: Run the Docker non-Acme OpenAPI journey**
  - Use real local Auth and separate app/worker principals; create/resume a non-Acme project; analyze; review; verify; publish to Docker Storage; fetch/download exact bytes; restart processes; and prove persistence.
  - Record source URL, target context, release ID, object URL, SHA-256, SRI, and observed stop boundary. Local-live remains false.

- [ ] **Step 4: Apply hosted migrations and publish only if real hosted credentials are available**
  - Confirm the selected project is `bimqgiedckdurqiywctl`; never use Fullbeam.
  - Apply migrations in order through supported Supabase tooling, create/check the public bucket, upload a non-Acme verified candidate with the app's real server-only credential, and GET/hash the public URL.
  - If credentials are absent, do not fabricate the object or URL; report exact missing names and leave production live false.

- [ ] **Step 5: Run conditional real live installation test**
  - With a real exact HTTPS verifier and normal installed target, execute native discovery/read/reversible mutation and persist attestation; otherwise exit with `LIVE_INSTALLATION_EVIDENCE_REQUIRED`.

- [ ] **Step 6: Commit**
  - `git commit -am "docs: add truthful local-live and live operations"`

### Task 10: Full verification, security review, and final evidence report

**Files:**
- Create: `.superpowers/sdd/2026-08-31-local-live-user-journey-report.md`

- [ ] **Step 1: Run focused tests for every task**
- [ ] **Step 2: Run `pnpm lint`, `pnpm security:policy`, `pnpm typecheck`, `pnpm test`, `pnpm test:golden`, `pnpm build`, and applicable Playwright/PostgreSQL suites**
- [ ] **Step 3: Run Supabase security/performance advisors after hosted database changes and fix relevant findings**
- [ ] **Step 4: Self-review type/spec coverage**
  - Confirm exhaustive source unions, one adapter per worker, immutable source/hash identity, exact artifact byte equality, server-only secrets, RLS/role isolation, fail-closed website/GitHub, draft-only GitHub, exclusive readiness modes, and selected-native-evidence truthfulness.
- [ ] **Step 5: Request independent code review and resolve findings with tests**
- [ ] **Step 6: Write the evidence report**
  - State exactly what ran, Docker persistence evidence, public/local artifact URLs, SHA-256/SRI values, missing credential names, environment skips, and whether production live success was genuinely achieved.
- [ ] **Step 7: Commit the report and confirm no push occurred**
