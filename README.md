# Page2WebMCP

Page2WebMCP turns the repository's existing Acme website, OpenAPI, and GitHub fixture evidence into a constrained WebMCP artifact. The implemented product scope is deliberately narrow: it supports only the committed Acme fixture adapters and rejects unsupported live-provider mode.

## What works end to end

- Signed, expiring control-plane sessions for the fixture owner and editor.
- Idempotent project creation, durable analysis jobs, bounded worker leases/retries, and recovery after an expired lease.
- Deterministic website, OpenAPI, and GitHub fixture analysis.
- Tenant-scoped capability review with optimistic concurrency and fail-closed R3 handling.
- Verification derived from persisted evidence, release code, manifest, and the exact reviewed capability state.
- Idempotent publication of content-addressed JavaScript with SHA-256/SRI, immutable caching, ETags, and exact-run attribution.
- Generated tools with strict schemas, same-origin credentials, bounded request/response handling, confirmation for mutation, and deterministic registration cleanup.
- PostgreSQL row-level security, composite tenant constraints, separate application/worker roles, and a least-privileged integration test.
- Structured lifecycle logs plus optional, allowlisted Langfuse traces and PostHog server events.

The runtime is a deterministic queue and state machine. It does not use an LLM-agent swarm, so adding multi-agent orchestration would introduce failure modes without supporting an existing workflow.

## Verify the repository

Use Node.js 24 and the pnpm version pinned in `package.json`:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test:all
```

`test:all` runs static and source-policy checks, type checking, Node tests, a disposable PostgreSQL/RLS integration suite, production builds, and production-mode browser tests. CI additionally runs a pinned, checksum-verified Gitleaks scan over the complete Git history. Local PostgreSQL client/server binaries (`pg_config`, `initdb`, `pg_ctl`, and `psql`) are required for the database suite.

For local development:

```bash
cp .env.example .env.local
pnpm dev
```

Then open `http://127.0.0.1:3100`. `pnpm dev` starts the control plane and Acme Support fixture together; the in-memory adapter processes analysis through the same claim/lease/completion protocol used by the PostgreSQL worker.

See [operations](docs/OPERATIONS.md), [architecture](docs/architecture.md), [testing](docs/testing.md), [demo](docs/demo.md), and [security reporting](SECURITY.md).

## WebMCP API alignment

Generated artifacts use the current imperative `document.modelContext.registerTool()` API. They do not use the deprecated `navigator.modelContext` surface or opt into cross-origin exposure. Tool registrations are tied to an `AbortSignal` so route changes and replacement releases clean up deterministically.
