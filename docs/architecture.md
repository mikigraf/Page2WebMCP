# Architecture

Page2WebMCP is a TypeScript pnpm workspace with two Next.js applications, one worker entry point, and focused shared packages.

## Runtime boundaries

- **Control plane** authenticates fixture users, validates mutation origins and bounded JSON, creates tenant-scoped projects, enqueues analysis, records reviews, verifies persisted output, and publishes immutable artifacts.
- **Worker** claims one durable job at a time with `FOR UPDATE SKIP LOCKED`, a bounded lease, heartbeat, at most three attempts, and stable failure codes. It owns analysis completion; a worker that loses its lease cannot overwrite the successor's result.
- **Acme Support** is the independent authenticated target fixture. Its read tools and confirmed ticket mutation are the executable acceptance surface; account deletion remains blocked.
- **PostgreSQL** is the production source of truth. The in-memory repository exists only for tests and the local fixture demo and follows the same repository contract.
- **Shared packages** contain capability fusion/status rules, OpenAPI compilation, artifact compilation, verification primitives, security validation, providers, persistence, and observability.

## Existing workflow

```text
authenticated project POST (idempotency key)
  -> persisted project
  -> analysis queue row (idempotency key, one active run/project)
  -> leased worker attempt + heartbeat
  -> exact-run evidence, capabilities, manifest, and candidate code
  -> versioned capability review
  -> verification over candidate + capability-state digest
  -> transactional digest recheck and idempotent publication
  -> public content-addressed artifact (ETag + SRI)
  -> same-origin WebMCP registration and bounded tool execution
```

All state-changing HTTP endpoints require an exact same-origin `Origin` header. Browser inputs identify resources; they do not supply roles, risk tiers, verification results, release code, or publication eligibility. Those values come from the signed session and persisted state.

## Persistence and concurrency

Tenant identity is carried on every durable domain record and reinforced by composite foreign keys. Transaction-local application context drives forced RLS policies. Project creation, analysis enqueue, and publication use organization/actor/operation-scoped idempotency records with a 24-hour lifetime. An analysis job snapshots its source type and URL at enqueue time, so retries remain bound to the same input and workers do not need tenant application access. The worker-produced source artifact is immutable after completion; every reviewed candidate is stored on its exact verification revision, so later capability changes can re-derive from the full source without overwriting it. Capability reviews use expected versions. Publication locks and rechecks the exact analysis-run capability digest so a concurrent review invalidates stale verification, and holds a current exact-run evidence lock through release insertion so retention cannot invalidate the gate mid-transaction.

The application, worker, and external retention scheduler use separate deployment login credentials. The application login receives only `page2webmcp_app`; the worker login receives only `page2webmcp_worker`; the scheduler login receives only `page2webmcp_maintenance`. The role definitions are `NOLOGIN`, `NOINHERIT`, and `NOBYPASSRLS`; each login receives only the membership needed by its process. Retention runs through one security-definer function with a fixed search path and a 1,000-row hard cap, so the scheduler has no direct table mutation privileges.

## Failure and recovery model

- Request bodies, generated artifacts, evidence collections, database queries, leases, vendor exports, and tool HTTP responses are bounded.
- Retriable analysis failures return to the queue with bounded backoff; non-retriable or exhausted work becomes terminal.
- Idempotent retries return the original resource and reject reuse with a different input hash.
- A process crash leaves durable queue state recoverable after lease expiry.
- Observability failures are fail-open and cannot mutate workflow outcomes.
- Production startup is fail-closed when its session secret or durable database configuration is absent.

## Orchestration choice

The existing workflow is deterministic and does not require multiple autonomous agents. A single durable state machine with explicit ownership is simpler and more reliable than agent handoffs here. Parallelism comes from database-backed work claiming; ownership, retries, and recovery remain explicit in persisted state.
