# Page2WebMCP local operation guide

## Prerequisites

- Node.js 22 or later
- Corepack and pnpm
- PostgreSQL binaries only when running `pnpm test:db:local`

Install and verify the repository:

```bash
corepack enable
pnpm install
pnpm build
pnpm test:all
pnpm test:db:local
```

`test:all` starts both Next.js applications and performs all browser setup itself. It does not need cloud credentials, Docker, clicks, or personal accounts. The separate database command creates and removes a disposable local PostgreSQL cluster.

## Environment configuration

`.env.example` documents every local and future live-integration setting. A safe local `.env` is already present but ignored by Git; it contains only fixture values and empty placeholders. To reset it, copy the tracked template:

```bash
cp .env.example .env
```

Keep `PAGE2WEBMCP_PROVIDER_MODE=local` for all built-in checks. Set it to `live` only after provisioning dedicated disposable credentials and public deployment URLs. Add the following values only in your local `.env` or the relevant deployment platform’s secret manager—never in Git, browser-visible code, screenshots, or test evidence:

- Supabase URL/keys and server-side database URL
- GitHub App ID, installation ID, private key, and webhook secret
- Browser Use (or equivalent) API key and project endpoint
- optional worker queue URL

`NEXT_PUBLIC_*` keys are intentionally public browser configuration; all other credentials must remain server-only. Deployment-provider access tokens are not represented in `.env`: store them in Vercel, Render, or your chosen CI secret manager rather than the application runtime environment.

## Fixture accounts

| Application | Email | Password | Role |
| --- | --- | --- | --- |
| Control plane | `owner@example.test` | `fixture-password` | owner |
| Control plane | `editor@example.test` | `fixture-password` | editor |
| Acme Support | `agent@example.test` | `fixture-password` | authenticated support user |

These credentials are test fixtures only. The applications do not write any password, raw cookie, authorization header, refresh token, live browser URL, or CDP URL to application evidence.

## Three-path local demo

1. Run `pnpm exec playwright test e2e/control-plane.spec.ts`; the test starts the control plane on port 3100 and Acme Support on port 3200 automatically.
2. Sign in to the control plane as the fixture owner.
3. Create and analyze a Website URL project (`https://acme.example`), OpenAPI project (`https://acme.example/openapi.json`), and GitHub project (`https://github.com/acme/support`).
4. Review the proposed capabilities. R3 `delete_account` remains blocked. Approve the R1 support-ticket capability as owner.
5. Publish the release. The download points to the target-origin immutable release artifact.
6. The generated artifact test installs that release into Acme Support, performs an authenticated R1 ticket creation, and confirms the reloaded page displays the persisted ticket.

## Security model in this MVP

- Target URLs and every redirect destination must be HTTPS, public, and free of embedded credentials. Private/loopback ranges are rejected.
- Discovery firewall permits only same-origin `GET` and `HEAD`; mutation requests are blocked during discovery.
- Evidence sanitization removes sensitive-keyed values recursively.
- Capability status is fail-closed: R3 is blocked and publication requires schema/authentication/replay/no-leak/browser/eval gates.
- Generated WebMCP uses `document.modelContext`, strict JSON schemas, same-origin requests, an abort lifecycle, and does not opt into `exposedTo`.
- Control-plane review and publication authorize from an HttpOnly session cookie, not a browser-supplied role.
- Tenant tables use RLS and are exercised by `pnpm test:db:local` as owner, cross-tenant viewer, and anonymous callers.

## Supported local envelope

This repository demonstrates one Next.js fixture with same-origin JSON APIs, two authenticated reads, one reversible R1 mutation, and one blocked R3 action. OpenAPI parsing supports JSON/YAML 3.0–3.2 and blocks external references. The GitHub and Browser Use implementations are local provider simulations; live providers remain deliberately opt-in and require dedicated disposable credentials.
