# Page2WebMCP

Page2WebMCP turns a reviewed website, OpenAPI document, or GitHub repository into one origin-bound, auto-registering WebMCP module. The generated module has no model or control-plane dependency at execution time: it uses the site's existing browser session and only the exact adapters approved during review.

The product offers three independent source paths:

- **OpenAPI** fetches a real HTTPS document through bounded DNS/TLS transport and requires a per-project target origin, same-origin test page, and environment.
- **Website** explores a real site through the Browser Use v4 factory. It starts only with the Browser Use key plus every ownership, egress, KMS/TTL-secret, lease, authentication-handoff, evidence, and CDP-observer control.
- **GitHub** analyzes an immutable commit selected through GitHub App repository bindings, tests generated work in an isolated sandbox, and can create one idempotent draft PR. It never merges.

Acme remains a test-only fixture. Missing live controls block a path with a stable diagnostic; no fixture, fabricated PR, compatibility shim, or injected registration substitutes for the real provider.

## Execution profiles

| Profile | Persistence and provider | Verification result |
| --- | --- | --- |
| Hermetic | In-memory/test persistence and explicit fixtures | `liveSuccess` is always `false` |
| Local-live | Docker Supabase and one real non-local adapter | `liveSuccess` is always `false` |
| Live | Hosted Supabase Storage, real provider controls, and external HTTPS verifier | `liveSuccess` is `true` only for selected-hash native installation proof |

## Toolchain and verification

Use Node.js 24, pnpm 10.14.0, Docker, and Supabase CLI 2.116.0 (the CLI is a pinned dev dependency):

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec supabase --version
pnpm test:all
```

The strongest repository gate runs lint/source policy, type checking, Node tests, the PostgreSQL/RLS suite, production builds, and browser tests. Individual checks are also available as `pnpm lint`, `pnpm security:policy`, `pnpm typecheck`, `pnpm test`, `pnpm test:golden`, and `pnpm build`.

## Hermetic development

```bash
cp .env.example .env.local
pnpm dev
```

Open `http://127.0.0.1:3100`. This starts the control plane and Acme fixture. It is useful for deterministic development, but it is not local-live or production evidence.

## Docker local-live

The local topology uses the pinned CLI and Docker Supabase:

```bash
pnpm local:up
pnpm local:reset
pnpm local:status
pnpm dev:local-live
# when finished
pnpm local:down
```

Local services are Supabase API/Auth/Storage at `http://127.0.0.1:58321`, Postgres at `postgresql://postgres:postgres@127.0.0.1:58322/postgres`, Studio at `http://127.0.0.1:58323`, and Inbucket at `http://127.0.0.1:58324`; the complete shadow, optional mail, analytics, pooler, and unchanged inspector port map is in [operations](docs/OPERATIONS.md). The bootstrap creates distinct `page2webmcp_app_local`, `page2webmcp_worker_local`, and `page2webmcp_maintenance_local` logins and writes their bounded credentials to the gitignored mode-0600 `.page2webmcp/local.env` file.

Select exactly one real worker adapter with `PAGE2WEBMCP_PROVIDER_MODE=openapi`, `website`, or `github`. The UI continues to offer all three paths even though one worker process claims only the selected source type. See [operations](docs/OPERATIONS.md) for the full control matrix and truthful stop conditions.

## Release identity

Production bundles are exact verified candidate bytes stored in the public Supabase Storage bucket `page2webmcp-releases` as `<sha256>.js`. The object URL, download URL, SHA-256, SHA-384 SRI, release record, verifier observation, and installation attestation must all agree. Loopback Storage artifacts are explicitly local-only.

Run one exclusive readiness profile:

```bash
pnpm exec tsx scripts/check-release-readiness.ts --hermetic
pnpm exec tsx scripts/check-release-readiness.ts --local-live
pnpm exec tsx scripts/check-release-readiness.ts --live
```

The live check requires an explicitly selected release hash and a normal, unintercepted native WebMCP installation observed by the exact HTTPS verifier. Configuring plausible environment strings alone cannot produce live success.

See [architecture](docs/architecture.md), [testing](docs/testing.md), [demo](docs/demo.md), [operations](docs/OPERATIONS.md), and [security reporting](SECURITY.md).

## WebMCP API alignment

Generated artifacts use `document.modelContext.registerTool()` and register automatically when the module loads on its reviewed origin. Tool registrations are bound to an `AbortSignal`; the bundle validates inputs and outputs, applies bounded network behavior, and fails closed when its runtime assumptions are absent.
