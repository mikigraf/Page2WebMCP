# Architecture

Page2WebMCP is a TypeScript pnpm workspace with two Next.js App Router applications and small shared packages.

- **Control plane** accepts a Website, OpenAPI, or GitHub source, presents evidence-backed capabilities, enforces owner approval, and publishes a fixture release.
- **Acme Support** is an independently runnable authenticated fixture with same-origin JSON endpoints and an immutable generated WebMCP artifact route.
- **Worker and packages** deterministically derive capabilities, apply status/security gates, compile artifacts, and simulate browser/source-control providers in local mode.

The local acceptance environment is intentionally in-process: Playwright starts both Next applications and installs a WebMCP shim. The separate `test:db:local` command creates a disposable PostgreSQL cluster for migration and RLS verification. Live Browser Use, GitHub App, Supabase, queue, and deployment providers remain opt-in behind environment configuration.
