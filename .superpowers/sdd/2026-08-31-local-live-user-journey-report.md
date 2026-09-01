# Page2WebMCP local-live user journey implementation report

Date: 2026-09-01

Branch: `codex/url-to-script`

Worktree: `.worktrees/url-to-script`
Push performed: no

## Outcome

The locked implementation and durable website authentication handoff are in the worktree, but the full user-level live acceptance journey was **not genuinely completed**. No command or database row reported `liveSuccess:true`.

Production live success genuinely achieved: **No**.

Truthful readiness value: **`liveSuccess:false`**.

The remaining blockers are external, not converted into test doubles:

- no real native local verifier origin/token or target install page was supplied;
- no Browser Use v4 gateway, ownership, egress, KMS/TTL secret-store, evidence, CDP, lease, or authentication credentials were supplied;
- no GitHub App/repository binding/sandbox credentials were supplied;
- no hosted Supabase server secret or hosted runtime database login URLs were available for artifact upload/application startup; and
- the hosted project contains no release or native installation attestation.

## Implemented behavior

- The UI preserves three independent source paths: OpenAPI, Website, and GitHub.
- OpenAPI stores the exact `sourceUrl`, `targetOrigin`, `testPageUrl`, and `environment` per project and uses bounded DNS/pinned HTTPS fetching.
- Website uses the existing Browser Use v4 factory and fails startup closed before repository construction unless every real control is valid. Recording, persistent profile/workspace/memory, uploads, and downloads are not enabled.
- Website authentication can now suspend without retaining a worker lease, expose only a safe gateway portal to an authorized owner/editor, recover the exact checkpoint from PostgreSQL after restart/reload, resume once on deterministic evidence, and queue durable cleanup for cancellation/failure/expiry.
- GitHub uses the selected-repository App factory, immutable commit evidence, bounded sandbox, and idempotent draft-PR-only side effect. No merge or fabricated PR path exists.
- One worker process constructs exactly one `openapi`, `website`, or `github` adapter. Missing selected-provider controls are startup failures.
- Publication uploads exact candidate bytes to the configured public Supabase Storage bucket at `<sha256>.js`; hosted and download reads must hash to the same bytes.
- Readiness accepts exactly one of `--hermetic`, `--local-live`, or `--live`. Hermetic/local-live can never produce live success, and live requires an exact native installation proof for the selected hash.

## Migrations and Supabase state

Supabase CLI is pinned and verified through `pnpm exec` at **2.116.0**.

The alternate local Docker stack is running without touching the unrelated stacks:

- API/Auth/Storage: `127.0.0.1:58321`
- PostgreSQL: `127.0.0.1:58322`
- Studio: `127.0.0.1:58323`
- Inbucket: `127.0.0.1:58324`
- SMTP/POP3: `58325`/`58326`
- Analytics: `58327`
- Pooler: `58329`

All **27** committed migrations were cleanly replayed locally. The local ledger is exact from `20260826000000` through `20260901094032`. Split-role PostgreSQL authentication tests passed 8/8, including wait, exact resume, replay, terminal failure/expiry, tenant denial, and restart-safe cleanup.

The same **27** migrations were applied to Supabase project `bimqgiedckdurqiywctl` (`Page2WebMCP`, `eu-west-2`, PostgreSQL 17.6). Hosted verification found:

- exact migration range `20260826000000`–`20260901094032`;
- public `page2webmcp-releases` bucket, 65,536-byte limit, JavaScript MIME allowlist;
- forced RLS intact on the application tables checked;
- bounded app/worker/maintenance roles remain NOLOGIN/non-superuser/non-bypass;
- zero Supabase security advisories and zero performance advisories; and
- zero projects, releases, installations, and hosted Storage objects.

## Verification run

- Docker Node `24.20.0` full suite: **721 total; 701 passed; 20 environment-gated skips; 0 failed**.
- Focused website authentication/API/UI/worker suite: **54/54 passed**.
- Release-route regression suite: **27/27 passed**.
- Readiness/local-Supabase suite after accepting the exact generated NOINHERIT login URLs: **28/28 passed**.
- Production build passed for Acme fixture, control plane, and worker; the new authentication route appears in the Next route manifest.
- TypeScript, focused ESLint, source lint, source-security policy, and `git diff --check` passed.
- Conditional E2E: **1 passed, 2 skipped**. The real local-live OpenAPI and production-live cases skipped with explicit missing-control names.
- Independent final review found no remaining Critical or Important implementation issue.

Observed readiness results:

```json
{"status":"passed","code":"HERMETIC_READINESS_PASSED","liveSuccess":false}
{"status":"skipped","code":"LIVE_CONTROLS_REQUIRED","liveSuccess":false,"missingKeys":["PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN","PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN"]}
{"status":"skipped","code":"LIVE_CONTROLS_REQUIRED","liveSuccess":false,"missingKeys":["DATABASE_URL","PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN","PAGE2WEBMCP_MAINTENANCE_DATABASE_URL","PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN","PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN"]}
```

The local-live result used the actual generated app and maintenance login URLs and the running alternate-port stack; it stopped only on the two absent verifier controls.

## Artifact evidence

One content-addressed, non-Acme-origin bundle remains in local Docker Storage:

- target origin: `https://widgets.example`
- tool: `listwidgets_4f17b177`
- public URL: `http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/9442bf29ae310e3580435c925bdf1d5937c911a9b16dcf46de5e1e18046db24b.js`
- SHA-256: `9442bf29ae310e3580435c925bdf1d5937c911a9b16dcf46de5e1e18046db24b`
- SRI: `sha384-utcjOJ/PWSd2EhW7gZq3Ug9jXVdD12HM7wyhRNm59ThOewF26pu1fw98liFqSmZI`
- bytes: 47,890
- served and named-download SHA-256: identical
- locality: `localOnly:true`; never eligible for `--live`

The last clean migration reset left local database project/release/installation counts at zero while the immutable Storage object remained. Therefore this object is byte/hash evidence, **not** claimed as the completed persistent local-live OpenAPI user journey.

The hosted bucket currently has zero objects. A request for the local hash at the hosted prefix failed, so no hosted artifact URL, hosted SHA/SRI, or hosted download identity is claimed.

## Missing provider credentials

Website startup returned `WEBSITE_LIVE_CONFIGURATION_REQUIRED` with these exact missing names:

`PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN`, `PAGE2WEBMCP_AUTH_HANDOFF_TOKEN`, `PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN`, `PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN`, `PAGE2WEBMCP_BROWSER_USE_API_KEY`, `PAGE2WEBMCP_BROWSER_USE_API_ORIGIN`, `PAGE2WEBMCP_CDP_OBSERVER_ORIGIN`, `PAGE2WEBMCP_CDP_OBSERVER_TOKEN`, `PAGE2WEBMCP_EGRESS_POLICY_ORIGIN`, `PAGE2WEBMCP_EGRESS_POLICY_TOKEN`, `PAGE2WEBMCP_EGRESS_PROXY_ORIGIN`, `PAGE2WEBMCP_EGRESS_PROXY_TOKEN`, `PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN`, `PAGE2WEBMCP_EVIDENCE_STORE_TOKEN`, `PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN`, `PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN`, `PAGE2WEBMCP_PUBLIC_ORIGIN`, `PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID`, `PAGE2WEBMCP_SECRET_STORE_ORIGIN`, `PAGE2WEBMCP_SECRET_STORE_TOKEN`.

GitHub startup returned `GITHUB_LIVE_CONFIGURATION_REQUIRED` with:

`PAGE2WEBMCP_GITHUB_APP_ID`, `PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64`, `PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS`, `PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN`, `PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN`.

The OpenAPI provider itself constructed successfully with no provider-specific secret. Completing local-live still requires a real loopback native verifier and target/source/install URLs. Completing production live additionally requires hosted application/maintenance database logins, hosted Storage server credentials for upload, an HTTPS verifier, a selected hosted release hash, and native installation attestation.

## Final acceptance status

- Authentication handoff implementation: **yes**, with deterministic and real-PostgreSQL restart/replay coverage.
- Authentication handoff exercised by a human against real Browser Use/gateway controls: **no**.
- Migrations applied locally: **yes, 27/27**.
- Migrations applied to `bimqgiedckdurqiywctl`: **yes, 27/27**.
- Persistent Docker local-live OpenAPI user journey after the final reset: **no**.
- Hosted non-Acme artifact published: **no**.
- Native installed-target proof: **no**.
- Production `liveSuccess:true`: **no**.
