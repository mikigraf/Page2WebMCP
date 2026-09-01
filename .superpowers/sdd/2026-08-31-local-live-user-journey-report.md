# Page2WebMCP local-live user journey implementation report

Date: 2026-09-01
Branch: `codex/url-to-script`
Worktree: `.worktrees/url-to-script`
Push performed: no

## User-level outcome

The full product acceptance journey was **not** achieved in this environment. A real user cannot yet complete the locked URL-to-installed-script production journey here because:

- The fixed Docker Supabase ports are occupied by an unrelated local project, so the required persistent Docker local-live OpenAPI journey could not run.
- The selected hosted Supabase project has no applied Page2WebMCP migrations or public release bucket, and no hosted database or Storage service credentials were available.
- No non-Acme artifact was published, installed, or natively attested.
- Website ownership is durable and exact-source-bound, but authenticated website exploration intentionally fails closed with `WEBSITE_DURABLE_AUTHENTICATION_HANDOFF_REQUIRED`; a durable human authentication pause/resume is not implemented.
- Browser Use and GitHub App controls were not supplied, so neither real external provider journey ran.

Production live success genuinely achieved: **No**.
Observed `liveSuccess:true`: **No**.
Current truthful value: **`false`**.

No artifact, pull request, credential, installation attestation, hash, or `liveSuccess` value was fabricated.

## Implemented product-lock behavior

- The UI offers independent Website URL, OpenAPI URL, and GitHub repository paths.
- OpenAPI persists `sourceUrl`, `targetOrigin`, same-origin `testPageUrl`, and `environment` per project and uses bounded DNS plus pinned HTTPS fetching.
- Website analysis requires externally verified ownership for the exact immutable active source. The Browser Use v4 runtime requires the real egress, KMS/TTL secret, lease, evidence, CDP, ownership, and authentication controls before repository construction or leasing.
- GitHub uses the real selected-repository App factory, immutable commit evidence, a bounded sandbox, idempotent draft-PR side effects, and never merges or fabricates a PR.
- The worker recognizes `PAGE2WEBMCP_PROVIDER_MODE=openapi|website|github` and constructs exactly one adapter. `local` remains an explicitly rejected production-worker mode.
- Release publication is bound to exact candidate bytes and the selected Page2WebMCP public Storage prefix. Hosted and download identities share one content-addressed `<sha256>.js` object.
- Installation state is recovered from the latest exact durable attempt. “Production verified” additionally requires matching candidate and installation live verifier identities and native execution evidence.
- GitHub UI recovery binds the latest reviewed workflow to a PR from that exact workflow. Active work resumes, terminal work without a completed install-verification PR can retry, and completion requires a succeeded workflow plus `install_verify` PR evidence with a completed successful check.
- Readiness accepts exactly one of `--hermetic`, `--local-live`, or `--live`. Hermetic and local-live can never return live success. Live ignores the local verifier origin and requires the exact selected hosted hash plus native installed-target proof.
- The final readiness topology contains the exact 22-migration ledger, including the app-only source-lock definer and its grant posture.

## Verification that ran

- Docker Node `24.20.0` full test suite: **655 tests; 643 passed, 12 environment-gated skips, 0 failed**.
- Coverage gates passed: **87.41% lines, 79.73% branches, 85.16% functions**.
- Golden evaluation: **3/3 passed**.
- Full lint, source-security policy, TypeScript typecheck, production build, and `git diff --check`: passed.
- Production dependency audit: **no known vulnerabilities**.
- PostgreSQL `17.6` replayed all **22 migrations** in lexical order; repository integration passed **11/11**, and separate app/worker topology passed **1/1**. Both two-connection source commit-order races passed.
- The PostgreSQL TypeScript harness used the working local Node `22.14.0` native type-strip runner because the Homebrew Node 24 executable hung on this host. All application, build, coverage, and focused contract gates ran under Docker Node 24.
- Conditional E2E contracts: **1 passed, 2 skipped** with exact missing-control diagnostics.
- Playwright discovered **16 browser journeys across 7 files**. Browser execution is not claimed because the required isolated Chromium runtime and live services were unavailable.
- Independent final review found no remaining Critical or Important issue beyond the explicitly unachieved authenticated-website journey.
- Supabase CLI version: **2.116.0** through `pnpm exec`.

Readiness commands returned:

- `--hermetic`: `HERMETIC_READINESS_PASSED`, `liveSuccess:false`, exit 0.
- `--local-live` without controls: `LIVE_CONTROLS_REQUIRED`, `liveSuccess:false`, exit 2.
- `--live` without controls: `LIVE_CONTROLS_REQUIRED`, `liveSuccess:false`, exit 2.

## Docker Supabase and local-live result

The exact Page2WebMCP local stack requires ports `54321` and `54322`. An unrelated stack named `next-supabase-saas-kit-turbo` currently owns both ports. It was not stopped, modified, or reused. A prior exact `local:up` attempt also encountered Docker writable-store capacity pressure.

Therefore these are **not** claimed:

- Docker Supabase startup/reset for this worktree.
- Local Auth signup through the running Page2WebMCP control plane.
- Process-restart persistence through that exact topology.
- A non-Acme OpenAPI release in Docker Storage.
- Local-live installed-target verification.

The isolated PostgreSQL result proves migrations, RLS, source locking, leases, and separate app/worker topology. It is not relabeled as the full Docker Supabase journey.

The conditional Docker OpenAPI E2E reported these missing inputs:

- `PAGE2WEBMCP_E2E_CONTROL_URL`
- `PAGE2WEBMCP_E2E_INSTALL_PAGE_URL`
- `PAGE2WEBMCP_E2E_LOCAL_LIVE`
- `PAGE2WEBMCP_E2E_PROCESS_CONTROL`
- `PAGE2WEBMCP_E2E_SOURCE_URL`
- `PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN`
- `PAGE2WEBMCP_LOCAL_STACK`
- `PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN`
- `PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL`
- `PAGE2WEBMCP_PROVIDER_MODE`
- `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN`
- `PAGE2WEBMCP_STORAGE_MODE`

## Source-path evidence

### OpenAPI

The independent source path and verification context are implemented and covered by generic non-Acme contract tests. With `PAGE2WEBMCP_PROVIDER_MODE=openapi`, the real adapter constructed, then startup stopped before a claim with:

- code: `DATABASE_URL_REQUIRED`
- missing: `DATABASE_URL`

The full persistent local-live user journey did not run for the Docker reasons above.

### Website

The ownership UI/API, exact source attestation, atomic enqueue/source lock, real Browser Use v4 control factory, exact allowlists, and cleanup behavior are implemented. Missing controls fail before repository construction with `WEBSITE_LIVE_CONFIGURATION_REQUIRED` and these exact operator-only names:

- `PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN`
- `PAGE2WEBMCP_AUTH_HANDOFF_TOKEN`
- `PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN`
- `PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN`
- `PAGE2WEBMCP_BROWSER_USE_API_KEY`
- `PAGE2WEBMCP_BROWSER_USE_API_ORIGIN`
- `PAGE2WEBMCP_CDP_OBSERVER_ORIGIN`
- `PAGE2WEBMCP_CDP_OBSERVER_TOKEN`
- `PAGE2WEBMCP_EGRESS_POLICY_ORIGIN`
- `PAGE2WEBMCP_EGRESS_POLICY_TOKEN`
- `PAGE2WEBMCP_EGRESS_PROXY_ORIGIN`
- `PAGE2WEBMCP_EGRESS_PROXY_TOKEN`
- `PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN`
- `PAGE2WEBMCP_EVIDENCE_STORE_TOKEN`
- `PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN`
- `PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN`
- `PAGE2WEBMCP_PUBLIC_ORIGIN`
- `PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID`
- `PAGE2WEBMCP_SECRET_STORE_ORIGIN`
- `PAGE2WEBMCP_SECRET_STORE_TOKEN`

No recording, persistent profile, workspace, model memory, upload, or download fallback is enabled. Public/unauthenticated exploration is covered by deterministic provider contracts. Authenticated targets are **not end-to-end**: even with controls, the worker returns `WEBSITE_DURABLE_AUTHENTICATION_HANDOFF_REQUIRED` before credential entry because the required durable human wait/resume phase is absent. The removed UI/API handoff does not pretend otherwise.

### GitHub

With `PAGE2WEBMCP_PROVIDER_MODE=github`, startup failed before repository access with `GITHUB_LIVE_CONFIGURATION_REQUIRED` and:

- `PAGE2WEBMCP_GITHUB_APP_ID`
- `PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64`
- `PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS`
- `PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN`
- `PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN`

No GitHub branch, check, preview, or draft PR was created. No merge path exists.

## Artifact Storage and hashes

Selected hosted topology:

- Supabase project: `bimqgiedckdurqiywctl` (`Page2WebMCP`)
- API origin: `https://bimqgiedckdurqiywctl.supabase.co`
- bucket: `page2webmcp-releases`
- public prefix: `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases`
- object key: `<sha256>.js`

A read-only project check found the project active and healthy, but its migration list was empty and `storage.buckets` had no `page2webmcp-releases` row. `PAGE2WEBMCP_SUPABASE_SECRET_KEY`, hosted database credentials, and live runtime controls were unavailable. No partial hosted mutation was attempted.

Consequently:

- published non-Acme SHA-256: **not produced**
- published non-Acme SRI: **not produced**
- hosted artifact URL: **not produced**
- hosted/download byte comparison: **not runnable**
- native installed release hash: **not produced**

## Readiness missing controls

The direct empty-environment local-live probe named:

- `DATABASE_URL`
- `PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN`
- `PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN`
- `PAGE2WEBMCP_LOCAL_STACK`
- `PAGE2WEBMCP_MAINTENANCE_DATABASE_URL`
- `PAGE2WEBMCP_PROVIDER_MODE`
- `PAGE2WEBMCP_PUBLIC_ORIGIN`
- `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN`
- `PAGE2WEBMCP_STORAGE_MODE`

The direct empty-environment live probe named:

- `DATABASE_URL`
- `PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN`
- `PAGE2WEBMCP_MAINTENANCE_DATABASE_URL`
- `PAGE2WEBMCP_PROVIDER_MODE`
- `PAGE2WEBMCP_PUBLIC_ORIGIN`
- `PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN`
- `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN`
- `PAGE2WEBMCP_STORAGE_MODE`

After those controls are supplied, production also requires `PAGE2WEBMCP_READINESS_RELEASE_HASH` and the exact native installation proof for that hash. The conditional live E2E additionally requires `PAGE2WEBMCP_E2E_LIVE_INSTALLATION`. Hosted Storage requires `PAGE2WEBMCP_SUPABASE_URL=https://bimqgiedckdurqiywctl.supabase.co` and a real server-only `PAGE2WEBMCP_SUPABASE_SECRET_KEY`.

## Remaining operator/product work

1. Implement the durable website human-authentication wait/resume state before claiming authenticated websites work end to end.
2. Free the fixed Page2WebMCP local ports without destroying or reusing the unrelated Supabase project, then run `local:up`, `local:reset`, and the conditional Docker OpenAPI journey.
3. Provide hosted database/Storage credentials for `bimqgiedckdurqiywctl`, apply all 22 migrations, and create the public `page2webmcp-releases` bucket through supported Supabase tooling.
4. Publish exact non-Acme candidate bytes, record SHA-256/SRI, and prove hosted/download byte identity.
5. Provide real Browser Use or GitHub App controls for the selected external journey.
6. Install the exact hosted hash on a normal HTTPS target and obtain native WebMCP authenticated-read plus confirmed-reversible-mutation evidence.
7. Run `--live` with that exact hash. Only that evidence may produce `LIVE_READINESS_PASSED` and `liveSuccess:true`.
