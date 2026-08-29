# Operations

## Supported envelope

This repository supports only the committed Acme fixture adapters: one website source, one OpenAPI document, and one GitHub repository. `PAGE2WEBMCP_PROVIDER_MODE=live` is rejected because no production live-provider implementation exists. Keep that boundary explicit; do not configure placeholder Browser Use, GitHub App, queue, Redis, or deployment credentials.

Acme Support is a deterministic fake target with in-memory sessions, confirmations, idempotency records, and tickets. It is intentionally single-process, disposable, and unsuitable for horizontal scaling or customer traffic. Run exactly one Acme process only when exercising the committed fixture workflows; do not treat it as a production service.

## Toolchain and local setup

- Node.js 24
- The pnpm version pinned in `package.json`
- PostgreSQL server/client binaries for the database integration suite

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm test:all
pnpm dev
```

The local demo uses explicit in-memory persistence. It is intentionally ephemeral and processes work through the same repository lease protocol in the request process. `pnpm dev` starts the control plane on port 3100 and Acme Support on port 3200.

## Fixture credentials

| Application | Email | Password | Role |
| --- | --- | --- | --- |
| Control plane | `owner@example.test` | `fixture-password` | owner |
| Control plane | `editor@example.test` | `fixture-password` | editor |
| Acme Support | `agent@example.test` | `fixture-password` | authenticated support user |

These are committed test fixtures, not deployable customer authentication. Sessions are signed, expire after one hour, and use HttpOnly, SameSite=Strict cookies (`Secure` in production).

## Production configuration

Production startup validates configuration before serving requests:

- `PAGE2WEBMCP_SESSION_SECRET`: at least 32 characters, supplied by a secret manager.
- `PAGE2WEBMCP_OWNER_PASSWORD` and `PAGE2WEBMCP_EDITOR_PASSWORD`: distinct deployment-managed values of at least 32 characters; committed fixture passwords are never accepted in production.
- `PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN`: the exact externally visible HTTPS control-plane origin, with no credentials, path, query, or fragment; mutation origin checks do not trust forwarding headers.
- `PAGE2WEBMCP_STORAGE_MODE=postgres` and `DATABASE_URL`: required durable storage.
- `PAGE2WEBMCP_PROVIDER_MODE=local`: the only supported provider mode.
- `PAGE2WEBMCP_FIXTURE_APP_URL`: exact HTTPS origin, with no credentials, query, or fragment.
- `PAGE2WEBMCP_FIXTURE_GITHUB_URL`: exact HTTPS GitHub fixture URL.
- `PAGE2WEBMCP_ACME_PUBLIC_ORIGIN`: the exact public origin used by Acme's fixture artifact; it is never derived from forwarding headers.

Never set `PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE=true` in a real deployment. It exists only so production-mode browser tests can exercise the fixture without an external database.

Use different PostgreSQL login credentials for each process:

- Control plane login: member of `page2webmcp_app` only.
- Worker login: member of `page2webmcp_worker` only.
- Retention scheduler login: member of `page2webmcp_maintenance` only.

All three role definitions are created without login, inheritance, superuser, or RLS bypass. Apply every migration in lexical order, load `supabase/seed.sql` for the current fixture identities, grant each membership to a separately managed login role, and then deploy. The migration owner credential must never be used as `DATABASE_URL` by either runtime or by the retention scheduler.

Each queue row stores the source type and URL captured when the application enqueues the run. Workers read that immutable snapshot from their claim and never assume the application role or read the tenant-scoped projects table. A login carrying both runtime roles is permitted only in the disposable repository contract test, where one repository instance deliberately exercises both sides of the interface.

Build and start the processes independently:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @page2webmcp/acme-support start -- --port 3200
pnpm --filter @page2webmcp/control-plane start -- --port 3100
pnpm worker
```

The supported deployment artifact is the complete repository at one immutable commit. Install and build from the monorepo root, retain the workspace packages and root dependencies, and invoke the filtered application start commands from that root. The current applications are not independently packaged for an app-directory-only or filtered deployment, and the worker output also depends on the root build layout.

The control plane and worker may receive different `DATABASE_URL` values through their process environments. Run at least one worker whenever PostgreSQL mode is enabled; otherwise jobs remain safely queued.

## Database retention

Expired verification evidence, audit events, idempotency records, and application sessions are removed by `private.purge_expired_data(max_rows)`. The function is the only delete capability granted to `page2webmcp_maintenance`; that role has no direct table mutation privileges. Application and worker roles cannot invoke it.

Run the function from an external database scheduler at least hourly. Do not put retention into the control-plane or worker processes, and do not use the migration-owner credential. Give the scheduler login only membership in `page2webmcp_maintenance`, then execute one short transaction per call:

```sql
begin;
set local role page2webmcp_maintenance;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
select * from private.purge_expired_data(1000);
commit;
```

`max_rows` must be between 4 and 1,000 and is a hard total deletion cap for one call. The function takes one expiry cutoff at call start, partitions the budget across the four data classes, deletes oldest rows first, and skips rows another cleanup call has locked. Publication also locks one current exact-run evidence row through release insertion, so retention either removes evidence before the publication gate or skips it until a later call; it cannot invalidate the gate between check and insert. The function never removes unexpired rows, and a revoked session remains until its `expires_at` boundary.

Record the five returned counts in scheduler logs. With the default limit, each class receives a 250-row share. A returned class count of 250 indicates that class may still have a backlog. Let the next scheduled invocation continue normally; for an initial backlog, run a separately bounded maintenance job with at most 20 calls, committing each call independently. Alert if any class repeatedly reaches its share, a call times out, or the scheduler misses two consecutive hourly runs. Increase scheduling frequency instead of raising the hard cap.

## Observability

Lifecycle logs are structured JSON and remain enabled independently of vendors. They contain generated request IDs and allowlisted low-cardinality properties only. Passwords, cookies, authorization headers, source URLs, evidence, release code, and user email are excluded.

Optional vendor export is enabled with:

```text
PAGE2WEBMCP_OBSERVABILITY_ENABLED=true
PAGE2WEBMCP_OBSERVABILITY_ENVIRONMENT=production
PAGE2WEBMCP_OBSERVABILITY_RELEASE=<immutable-release-label>
LANGFUSE_PUBLIC_KEY=<secret-manager-value>
LANGFUSE_SECRET_KEY=<secret-manager-value>
LANGFUSE_BASE_URL=<approved-langfuse-host>
POSTHOG_API_KEY=<secret-manager-value>
POSTHOG_HOST=<approved-posthog-host>
```

Langfuse receives sampled workflow traces (all failures/security denials and a deterministic 20% of successes). PostHog receives the five existing lifecycle events with person profiles, autocapture, and session replay disabled. Export has a 250 ms bound and fails open. Configure vendor-side retention, residency, and access controls before enabling it.

## Recovery and debugging

- Search logs by `request_id`; API responses return the same value in `x-request-id` and the JSON error envelope.
- A client retry must reuse its original idempotency key and identical body. Reusing a key with different input returns a conflict.
- A crashed worker's lease expires and another worker can claim the job. Three failed attempts make it terminal.
- `LEASE_LOST` means another worker owns recovery; do not force-complete that run.
- `CAPABILITIES_CHANGED` means review state changed after verification; repeat verification/publication from current persisted state.
- Migration `20260829094207_preserve_analysis_source_candidates.sql` fails closed for legacy unpublished runs that had already been verified, because their original worker artifact may have been overwritten by reviewed subset bytes. Those runs end with `MIGRATION_REANALYSIS_REQUIRED`; enqueue a new analysis before retrying verification or publication. Published artifacts remain immutable and available.
- `EVIDENCE_MISSING_OR_EXPIRED` means the exact analysis run no longer has current verification evidence; run a new analysis before verifying or publishing.
- Artifact responses are content-addressed and immutable. Validate their `ETag` or `integrity` value instead of mutating an existing release.
- If vendor telemetry is unavailable, diagnose the vendor separately; application results intentionally continue.

Before deployment, run `pnpm test:all` with the exact release commit and toolchain.
