# Operations

## Truth boundary

Page2WebMCP has three user-selectable sources: OpenAPI, website, and GitHub. A production worker runs exactly one adapter selected by `PAGE2WEBMCP_PROVIDER_MODE=openapi|website|github`; the UI still offers all three. Missing controls are startup failures before the worker opens the repository or claims a lease.

Acme is a test-only fixture. Hermetic and local-live results always report `liveSuccess: false`. Production success requires one explicitly selected hash, the exact HTTPS verifier, and a normal, unintercepted native WebMCP page load. A compatibility shim, injected registration, intercepted route, synthetic harness, fabricated PR, plausible environment strings, or loopback artifact can never provide live success.

## Supported toolchain and local services

- Node.js 24
- pnpm 10.14.0
- Docker
- Supabase CLI 2.116.0, pinned as a dev dependency and invoked through `pnpm exec`

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec supabase --version
pnpm local:up
pnpm local:reset
pnpm local:status
pnpm dev:local-live
pnpm local:down
```

`local:up` starts Docker Supabase and bootstraps runtime roles. `local:reset` resets only the CLI-managed local database, replays every migration in lexical order, loads fixture-only seed data, verifies the applied migration ledger, and rotates the local runtime secrets. `dev:local-live` starts the control plane and one real selected worker; it does not start Acme.

The conditional OpenAPI acceptance test owns the application processes so it can prove a real restart. Start only the Docker stack, leave control-plane port `3100` free, and provide all of these controls before running `pnpm exec tsx --test e2e/local-live-openapi.test.ts`:

```text
PAGE2WEBMCP_E2E_CONTROL_URL=http://127.0.0.1:3100
PAGE2WEBMCP_E2E_INSTALL_PAGE_URL=<real non-Acme HTTPS install page>
PAGE2WEBMCP_E2E_LOCAL_LIVE=true
PAGE2WEBMCP_E2E_PROCESS_CONTROL=owned
PAGE2WEBMCP_E2E_SOURCE_URL=<real non-Acme HTTPS OpenAPI document>
PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN=<real loopback native verifier>
PAGE2WEBMCP_LOCAL_STACK=true
PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN=<exact HTTPS target origin>
PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL=<same-origin real test page>
PAGE2WEBMCP_PROVIDER_MODE=openapi
PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN=<32-4096 character verifier token>
PAGE2WEBMCP_STORAGE_MODE=postgres
```

`PAGE2WEBMCP_E2E_PROCESS_CONTROL=owned` is the operator handshake authorizing the test to start and terminate only its own two generations of the `dev:local-live` launcher. The test checks the pinned CLI status and fixed Docker endpoints, runs the journey with one control-plane/worker generation, stops the launcher and waits for its supervised children plus port `3100` to close, starts a second generation, reloads the persisted release, and submits a new analysis to the restarted worker. A missing handshake, an occupied port, a different local topology, or any missing external source/verifier/install control skips or fails closed; a second HTTP client alone is not restart evidence.

| Service | Local address |
| --- | --- |
| Shadow database | `127.0.0.1:58320` |
| Supabase API, Auth, and Storage | `http://127.0.0.1:58321` |
| PostgreSQL owner URL (bootstrap/reset only) | `postgresql://postgres:postgres@127.0.0.1:58322/postgres` |
| Studio | `http://127.0.0.1:58323` |
| Inbucket HTTP | `http://127.0.0.1:58324` |
| Optional Inbucket SMTP | `127.0.0.1:58325` |
| Optional Inbucket POP3 | `127.0.0.1:58326` |
| Analytics | `127.0.0.1:58327` |
| Optional database pooler | `127.0.0.1:58329` |
| Edge-runtime inspector (unchanged) | `127.0.0.1:8083` |

The bootstrap accepts only the exact IP-literal loopback database host. It creates `page2webmcp_app_local`, `page2webmcp_worker_local`, and `page2webmcp_maintenance_local`. Each login can assume exactly one matching NOLOGIN authorization role and must remain non-owner, non-superuser, and non-bypass-RLS. Fresh bounded passwords and three distinct connection URLs are written atomically to gitignored `.page2webmcp/local.env` with mode 0600. The owner URL is neither stored there nor passed to a long-running process.

`PAGE2WEBMCP_LOCAL_STACK=true` permits HTTP only for exact `127.0.0.1`/`[::1]` local Supabase and control-plane origins. It does not relax provider targets, production artifacts, or `--live`. `PAGE2WEBMCP_TEST_MODE` is not a production HTTP exception.

## Source controls

### OpenAPI

Select `PAGE2WEBMCP_PROVIDER_MODE=openapi`. The UI requires and persists this bounded per-project verification context:

```text
sourceUrl=https://provider.example/openapi.json
targetOrigin=https://target.example
testPageUrl=https://target.example/webmcp-test
environment=test|staging|production
```

The source and target inputs are exact HTTPS. `testPageUrl` is same-origin with `targetOrigin` and has no query or fragment. Fetches use bounded DNS resolution, pinned public A/AAAA addresses, TLS SNI/certificate verification, manual same-origin redirects, omitted credentials, and response/content/reference limits. Missing secure construction fails `OPENAPI_LIVE_CONFIGURATION_REQUIRED`; missing per-project context fails `OPENAPI_VERIFICATION_CONTEXT_REQUIRED`.

### Website / Browser Use v4

Select `PAGE2WEBMCP_PROVIDER_MODE=website`. The factory is Browser Use API v4 with model `browser-use-2.0`, exact target allowlists, ephemeral sessions, and recording/profile/workspace/memory/uploads/downloads disabled. Every listed control is required:

`PAGE2WEBMCP_BROWSER_USE_API_ORIGIN` is the exact HTTPS origin of an operator-deployed Page2WebMCP Browser Use v4 gateway, not `api.browser-use.com`. The gateway owns the Page2WebMCP `/v1/readiness` and session-control contract, forwards only the bounded v4 operations, and must attest that its configured upstream accepted the supplied Browser Use key and selected `browser-use-2.0`.

```text
PAGE2WEBMCP_BROWSER_USE_API_KEY
PAGE2WEBMCP_BROWSER_USE_API_ORIGIN
PAGE2WEBMCP_EGRESS_PROXY_ORIGIN
PAGE2WEBMCP_EGRESS_PROXY_TOKEN
PAGE2WEBMCP_EGRESS_POLICY_ORIGIN
PAGE2WEBMCP_EGRESS_POLICY_TOKEN
PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN
PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN
PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID
PAGE2WEBMCP_SECRET_STORE_ORIGIN
PAGE2WEBMCP_SECRET_STORE_TOKEN
PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN
PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN
PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN
PAGE2WEBMCP_AUTH_HANDOFF_TOKEN
PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN
PAGE2WEBMCP_EVIDENCE_STORE_TOKEN
PAGE2WEBMCP_CDP_OBSERVER_ORIGIN
PAGE2WEBMCP_CDP_OBSERVER_TOKEN
PAGE2WEBMCP_PUBLIC_ORIGIN
```

An API key alone is not partial readiness. Any missing or invalid item produces `WEBSITE_LIVE_CONFIGURATION_REQUIRED`; privileged startup/readiness output lists the sorted environment names without values. The public API shows only the stable code.

### GitHub App

Select `PAGE2WEBMCP_PROVIDER_MODE=github` and configure:

```text
PAGE2WEBMCP_GITHUB_APP_ID
PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64
PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS
PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN
PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN
```

Bindings select exact repository IDs/installations/refs. The provider snapshots an immutable commit, holds one-hour installation tokens in memory, and runs validation in the isolated sandbox. It may create one idempotent draft PR only. Never merge a PR, synthesize a PR response, broaden the selected repository, or run without the sandbox. Invalid controls produce `GITHUB_LIVE_CONFIGURATION_REQUIRED` with sorted key names only on operator surfaces.

## Auth and runtime configuration

Local-live obtains the local browser-safe publishable key from `pnpm exec supabase status -o env`. Only that key may enter `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; service-role/secret keys are server-only and rejected from every `NEXT_PUBLIC_*` setting. Local users sign up through Supabase Auth and personal-organization provisioning; committed fixture identities do not have local login passwords.

The generated local file supplies:

```text
PAGE2WEBMCP_LOCAL_STACK=true
PAGE2WEBMCP_STORAGE_MODE=postgres
DATABASE_URL=<app login URL>
PAGE2WEBMCP_WORKER_DATABASE_URL=<worker login URL>
PAGE2WEBMCP_MAINTENANCE_DATABASE_URL=<maintenance login URL>
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:58321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<browser-safe local key>
PAGE2WEBMCP_SUPABASE_URL=http://127.0.0.1:58321
PAGE2WEBMCP_SUPABASE_SECRET_KEY=<server-only local Storage key>
PAGE2WEBMCP_SESSION_SECRET=<fresh bounded secret>
PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN=http://127.0.0.1:3100
PAGE2WEBMCP_PUBLIC_ORIGIN=http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases
```

Production uses distinct managed app, worker, and maintenance login secrets and verified-TLS database URLs. Never deploy with the migration owner URL or give one login multiple authorization memberships.

## Production images and deployment identity

Build the control plane and worker as separate images from one clean, committed source tree. The operator must supply an approved `node:24@sha256:<lowercase-digest>` base image (an optional registry prefix is allowed); an unpinned tag or a non-Node-24 repository/tag is rejected inside each build. Generate the immutable identity and committed-source archive once before either image build, then pass the same commit, release ID, and HTTPS control-plane origin to both builds:

```bash
PAGE2WEBMCP_GIT_COMMIT_SHA=<exact-clean-commit> \
PAGE2WEBMCP_APPLICATION_RELEASE_ID=<immutable-release-id> \
PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN=https://control.example \
pnpm build:identity

docker build -f deploy/Dockerfile.control-plane \
  --build-arg NODE_BASE_IMAGE=<approved-node-24-image@sha256:digest> \
  --build-arg PAGE2WEBMCP_GIT_COMMIT_SHA=<exact-clean-commit> \
  --build-arg PAGE2WEBMCP_APPLICATION_RELEASE_ID=<immutable-release-id> \
  --build-arg PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN=https://control.example \
  -t page2webmcp-control-plane:<immutable-release-id> .

docker build -f deploy/Dockerfile.worker \
  --build-arg NODE_BASE_IMAGE=<approved-node-24-image@sha256:digest> \
  --build-arg PAGE2WEBMCP_GIT_COMMIT_SHA=<exact-clean-commit> \
  --build-arg PAGE2WEBMCP_APPLICATION_RELEASE_ID=<immutable-release-id> \
  --build-arg PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN=https://control.example \
  -t page2webmcp-worker:<immutable-release-id> .
```

Identity generation fails on a dirty tree, commit mismatch, non-HTTPS origin, or conflicting prior manifest/archive. It writes read-only `.dist/deployment-identity.json` and `.dist/deployment-source.tar`. Each image extracts only that exact committed archive, re-hashes it, compares its active Dockerfile with the committed Dockerfile, and verifies the same runtime identity arguments before installing or compiling anything. Later workspace edits therefore cannot enter an image under an older identity. Both images run as the base image's non-root `node` user and copy the same read-only deployment identity.

## Immutable Supabase Storage artifacts

The fixed public bucket is `page2webmcp-releases`; every key is exactly `<sha256>.js`. Publication uploads the exact candidate bytes with `upsert:false`. If the object exists, publication reads and verifies it instead of overwriting it. Serving and download bytes, SHA-256 and SHA-384 SRI, release identity, candidate observation, and installed observation must match.

Required server-only configuration:

```text
PAGE2WEBMCP_SUPABASE_URL=<this app's Supabase API origin>
PAGE2WEBMCP_SUPABASE_SECRET_KEY=<server-only Storage credential>
PAGE2WEBMCP_PUBLIC_ORIGIN=<exact /storage/v1/object/public/page2webmcp-releases prefix>
```

The selected hosted project is `bimqgiedckdurqiywctl`. Its intended prefix is:

```text
https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases
```

Hosted publication credentials are required before any object or successful hosted URL may be reported. Fullbeam must never be used for Page2WebMCP artifacts. Do not place a placeholder object in the bucket and do not infer success from the dashboard project reference. Local Docker Storage uses the equivalent loopback prefix and marks every release `localOnly:true`; a loopback object cannot satisfy `--live`.

The control-plane content-addressed release route remains a local integrity fallback. Production script tags and downloads use the persisted Storage identity. Artifact requests omit credentials and must not redirect.

## Verifier and readiness

Pass exactly one of `--hermetic`, `--local-live`, or `--live`:

```bash
pnpm exec tsx scripts/check-release-readiness.ts --hermetic
pnpm exec tsx scripts/check-release-readiness.ts --local-live
pnpm exec tsx scripts/check-release-readiness.ts --live
```

- Hermetic diagnostic success is `HERMETIC_READINESS_PASSED` with `liveSuccess:false`.
- Local-live diagnostic success is `LOCAL_LIVE_READINESS_PASSED` with `liveSuccess:false`.
- Live controls missing or unreachable return `LIVE_CONTROLS_REQUIRED` with `liveSuccess:false`.
- Valid controls without matching selected native proof return `LIVE_INSTALLATION_EVIDENCE_REQUIRED` with `liveSuccess:false`.
- Only exact proof returns `LIVE_READINESS_PASSED` with `liveSuccess:true`.

`--live` ignores `PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN` and requires `PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN` to be an exact HTTPS origin plus a 32–4096 character `PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN`. It also requires lowercase 64-hex `PAGE2WEBMCP_READINESS_RELEASE_HASH`, `PAGE2WEBMCP_STORAGE_MODE=postgres`, the hosted Storage prefix, the selected real provider controls, `DATABASE_URL`, and `PAGE2WEBMCP_MAINTENANCE_DATABASE_URL`.

Local-live may use `PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN=http://127.0.0.1:<port>` only with `PAGE2WEBMCP_LOCAL_STACK=true`. That verifier must still perform a real native browser check; the exception changes transport labeling, not evidence quality.

Both verifier profiles must answer authenticated `POST /v1/readiness` without redirect and report the exact supported mode, protocol, and native implementation. Live evidence is accepted only when the release, served, executed, and trusted-loader hashes; SRI; candidate/install verifier identity; provider provenance; expected/registered tool digest and count; and target/artifact identity all match. The page load must be normal and unintercepted native WebMCP, with no injection, synthetic harness, harmful duplicate load, model call, or control-plane call.

The readiness CLI emits one bounded JSON object. Exit 0 means the selected diagnostic gate passed; exit 1 means a deterministic gate failed; exit 2 means required controls or installation evidence are absent. No mode scans for another tenant's “latest” success.

## Production-live operator journeys

The shared preflight and the two customer-path commands are:

```bash
pnpm live:preflight -- --dry-run --provider openapi
pnpm live:preflight -- --dry-run --provider website
pnpm live:openapi -- --dry-run
pnpm live:website -- --dry-run
pnpm live:openapi -- --live
pnpm live:website -- --live
```

The live commands load `.env` with Node's built-in `--env-file-if-exists=.env` support. Keep that file owner-only and never commit it; the commands print control names only, never values.

Set `PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE` to an owner-only, non-symlink mode-0600 JSON file containing exactly `email` and `password`. Set `PAGE2WEBMCP_E2E_ENVIRONMENT=test|staging|production`. The command authenticates through the deployed control-plane CSRF/session APIs; it never inserts journey rows with SQL and never prints the credentials.

These commands are deliberately resumable through server idempotency and durable PostgreSQL state. A nonzero action result is a checkpoint, not success:

- `WEBSITE_OWNERSHIP_ACTION_REQUIRED`: complete the displayed project ownership flow in the UI, then rerun.
- `WEBSITE_WORKER_RESTART_AND_AUTHENTICATION_REQUIRED`: recycle the production worker, complete the safe owner/editor handoff in the UI, then rerun Website with `--resume-authentication`. The database still requires a different completing worker/lease generation; the flag itself is not evidence.
- `CAPABILITY_REVIEW_REQUIRED`: review the evidence-backed capabilities in the UI, then rerun.
- `INSTALLATION_ACTION_REQUIRED`: install the returned exact module script in the target's site-wide layout. Rerun with `--confirm-installed <returned-sha256>` only after installation.

The command then requests normal-load native installation verification, runs `--live` readiness for that exact hash, and writes a receipt only from the bounded persisted maintenance projection. A missing projection, stale verifier attestation, incomplete cleanup, or unsuccessful readiness remains nonzero with `liveSuccess:false`.

Successful live receipts are stored under `.page2webmcp/production-live-receipts/<receipt-sha256>.json`. The writer creates the directory with mode 0700 and each immutable file with mode 0600; it rejects symlinks, non-owner paths, permissive modes, and any same-name byte conflict. Preserve these receipts with the corresponding deployment and artifact records.

## Operator diagnostics

Startup and readiness may print sorted missing environment-variable names because they are privileged operator surfaces. They never print values, URLs containing credentials, tokens, private keys, candidate code, DOM, repository source, or API bodies. Public UI/API responses expose stable codes only.

Useful fail-closed codes include `OPENAPI_LIVE_CONFIGURATION_REQUIRED`, `WEBSITE_LIVE_CONFIGURATION_REQUIRED`, `GITHUB_LIVE_CONFIGURATION_REQUIRED`, `RELEASE_VERIFIER_CONFIGURATION_REQUIRED`, `LIVE_CONTROLS_REQUIRED`, and `LIVE_INSTALLATION_EVIDENCE_REQUIRED`.

## Database inspection and retention

Use the maintenance login only for bounded, schema-qualified maintenance functions. It must prove `current_user`, non-superuser/non-bypass status, and membership in `page2webmcp_maintenance` alone before reading readiness identity or purging retention data. Do not grant it candidate code, tenant source URLs, or direct table mutation.

The durable workflow event stream is authoritative. Inspect workflow/task events, migration history, forced-RLS flags, verification IDs, release hashes, and installation attestations through their bounded application/maintenance projections. Vendor telemetry is diagnostic only.

Run `private.purge_expired_data(max_rows)` from an external scheduler at least hourly, with `max_rows` from 4 to 1000, a short lock timeout, and a 30-second statement timeout. Use one transaction per call and never run it as the migration owner.

## Observability and recovery

Structured JSON lifecycle logs exclude passwords, cookies, authorization headers, source URLs, evidence bodies, candidate code, and user email. Optional Langfuse and PostHog exports remain redacted and non-authoritative. Profiles, autocapture, and session replay are disabled.

For lease loss, retry exhaustion, provider outage, leaked browser session, compromised artifact, verifier drift, GitHub revocation, rollback, and restore procedures, follow [Task 9 recovery](./runbooks/task-9-recovery.md). A retry must reuse its idempotency key and identical input. Never convert an unknown external effect into success.

Before promotion, run:

```bash
pnpm lint
pnpm security:policy
pnpm typecheck
pnpm test
pnpm test:golden
pnpm build
pnpm exec tsx scripts/check-release-readiness.ts --hermetic
```

Run Docker/PostgreSQL and browser suites when their explicit controls are available. If hosted Storage credentials, Browser Use controls, GitHub App controls, or verifier/install access are absent, record the precise stop boundary and keep production `liveSuccess:false`.
