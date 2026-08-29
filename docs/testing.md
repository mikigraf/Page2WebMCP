# Testing

Run the complete local release gate from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm test:all
```

The gate covers:

- ESLint and repository source-policy checks.
- TypeScript compilation for both Next.js applications, the worker, and shared packages.
- Unit and integration tests for authentication, bounded API parsing, compilation, security, provider behavior, observability, repository state transitions, worker leases/retries, and Acme execution. The same run enforces line, branch, and function coverage thresholds against loaded application and package production sources; test files and test-support code do not count toward coverage.
- A disposable PostgreSQL cluster with all migrations and seed data, standalone tenant-isolation and bounded-retention assertions, a least-privileged repository lifecycle test, and a real route-to-database lifecycle completed by a separately launched worker process.
- Production builds for both Next.js applications and the worker.
- Node end-to-end acceptance plus Chromium tests against production Next.js servers.

Useful focused commands:

```bash
pnpm lint
pnpm security:policy
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:db:local
pnpm build
pnpm test:e2e:production
```

`test:db:local` requires local PostgreSQL binaries discoverable through `pg_config`; it creates an isolated temporary cluster and removes it on exit. It does not use or modify a developer database.

Browser tests allocate their configured control-plane and Acme ports, disable server reuse, and set the explicit ephemeral-storage exception only for the fixture process. Production deployment must not set that exception.

`test:e2e:production` always creates fresh production builds before starting either Next.js server. The release gate uses the internal `test:e2e:production:built` command only after its own build step so the applications are built exactly once. Because the Acme fixture has mutable in-memory state, Playwright runs one worker. Traces, screenshots, videos, and an HTML report are retained on failure under `test-results/` and `playwright-report/`.

The CI workflow uses the pinned Ubuntu 24.04 image, pins third-party actions by commit, downloads Gitleaks 8.30.1 with a pinned SHA-256 checksum to scan the complete Git history, installs the pinned Node/pnpm toolchain from a frozen lockfile, audits production dependencies, installs only Chromium, and invokes the same `pnpm test:all` release gate. It smoke-tests the built control-plane server and uploads bounded-retention Playwright and server diagnostics after a failure. The local `security:policy` command enforces repository-specific runtime-source rules; it is not described as a substitute for the history-wide secret scanner.
