# Task 6 report: Supabase Auth SSR identity, organizations, projects, and authorization

## Outcome

Task 6 replaces the production fixture-session path with pinned Supabase Auth SSR clients and a database-authoritative identity/membership boundary. Every protected route now resolves a fresh verified Supabase identity and an active database session/membership before repository access. The fixture authenticator remains available only as an explicitly installed hermetic test adapter and cannot be selected by production configuration.

The implementation also adds the complete account lifecycle, convergent personal organizations, CSRF-bound mutations, the owner/editor/viewer authorization matrix, arbitrary normalized source entry, cursor-based project list/detail/resume APIs, actionable UI states, and an additive RLS/grant migration. Existing workflow, evidence, canonical-plan, release, and provider fail-closed contracts remain unchanged.

## Implementation

### Pinned Supabase SSR boundary

- `package.json` and `pnpm-lock.yaml` pin `@supabase/ssr` `0.12.5` and `@supabase/supabase-js` `2.112.4` exactly.
- `apps/control-plane/src/auth.ts` supplies cookie-backed server and public browser client factories. Server identity requires a successful fresh `getUser()`, confirmed email, exact subject agreement, a valid session identifier, verified claims, and a non-expired claim on every protected operation.
- Supabase cookies are serialized as HttpOnly, Secure on HTTPS/production, and SameSite-scoped. Expired/revoked sessions fail closed and return deletion cookies for all observed Supabase session cookies.
- `apps/control-plane/src/supabase-config.ts` rejects secret/service-role strings and decodes legacy JWT public keys to require the exact `anon` role. Production configuration requires an exact HTTPS Supabase URL, public key, strong session secret, exact HTTPS public control-plane origin, and durable PostgreSQL.
- `apps/control-plane/proxy.ts` performs only the official SSR claim/cookie-refresh seam. It is explicitly not an authorization boundary; protected routes still perform fresh identity and membership resolution.
- `apps/control-plane/src/auth-fixture.ts` contains the explicit hermetic fixture. It is never imported or selected by production source. Test auth overrides throw in production.

### Account lifecycle and CSRF

New App Router endpoints cover:

- signup with confirmed-session provisioning or actionable email-verification state;
- PKCE verification/recovery callback accepting only a bounded one-time `code` and rejecting bearer query tokens;
- login, logout, refresh, session inspection, recovery request, password update, and global revocation;
- server-issued HMAC CSRF challenges bound to an HttpOnly nonce, exact session, exact origin, and bounded expiry.

All anonymous auth mutations use anonymous CSRF challenges. All authenticated mutations first resolve fresh identity plus active database membership and then verify the session-bound CSRF token. Recovery, logout, revocation, and auth failures clear relevant session/CSRF cookies. Request bodies are strict and bounded, and account routes never accept role, organization, access token, refresh token, or user metadata as authorization input.

### Durable identity and authorization

- `ControlPlaneRepository` now exposes `provisionPersonalOrganization`, `resolveActor`, `listProjectsPage`, and latest-analysis/project-detail semantics in both in-memory and PostgreSQL implementations.
- Personal organization provisioning is convergent under concurrent retries through a unique owner identity and an upserted owner membership.
- PostgreSQL actor resolution requires the exact authenticated user, an active matching `auth.sessions` row, and a current organization membership. A missing, expired, deleted, or cross-user session returns `SESSION_REVOKED`/membership denial rather than an actor.
- All exposed project, analysis, capability-review, verification, and release routes now derive their `RepositoryActor` at request time. No route trusts a role cookie, UI state, `user_metadata`, caller-supplied organization membership, or a fixture credential.
- Owner/editor/viewer rules remain repository-authoritative: viewers are read-only; editors may create/analyze and review R0/R1; owner authority is required for R2 publication/approval; R3 remains blocked before persistence/publication.

### RLS, grants, and safe backfill

`supabase/migrations/20260830160000_supabase_auth_identity.sql` adds the personal-owner identity link and:

- safely backfills only a unique sole owner that also exists as a confirmed `auth.users` identity;
- enables and forces RLS on organizations and memberships;
- restores an owner update policy with both `USING` and `WITH CHECK` membership predicates;
- revokes direct Data API writes for organizations/memberships;
- exposes provisioning and membership resolution only to the non-inheriting application role through narrowly scoped `private`, `SECURITY DEFINER` functions with `pg_catalog` search paths and explicit identity/session checks.

The standalone SQL regression verifies function privilege isolation, Data API write revocation, RLS policy shape, concurrent/idempotent convergence, exact active-session resolution, and revocation failure. The existing tenant/retention and phased-workflow migration suites continue to run in the same fresh PostgreSQL cluster.

### Project entry and UI

- Website and OpenAPI sources accept arbitrary public HTTPS URLs inside the supported secret-free envelope; GitHub sources accept and normalize arbitrary `github.com/{owner}/{repository}` URLs. Literal private/local network targets, credentials, fragments, secret-bearing query strings, malformed shapes, and unsupported hosts fail with precise diagnostics.
- Projects are returned through a stable opaque cursor with a maximum page size of 100. Detail APIs include durable latest-analysis state so reload/new-tab and explicit resume do not depend on browser state.
- The control-plane UI now exposes signup, verification, login, recovery/reset, logout, revoke-all, project creation, pagination, and resume actions. It displays only freshly returned database roles, never reads authorization from local storage, does not silently truncate project lists, and uses generic source examples.

## Files

Primary implementation:

- `apps/control-plane/src/auth.ts`, `auth-fixture.ts`, `supabase-config.ts`, `api.ts`, `config.ts`, `projects.ts`
- `apps/control-plane/proxy.ts`
- `apps/control-plane/app/api/auth/{callback,csrf,login,logout,password,recovery,refresh,revoke,session,signup}/route.ts`
- protected project/analysis/capability/release routes under `apps/control-plane/app/api/`
- `apps/control-plane/app/page.tsx`, `project-entry.tsx`, and project detail UI
- `packages/database/src/control-plane.ts`, `postgres.ts`
- `supabase/migrations/20260830160000_supabase_auth_identity.sql`, `supabase/tests/auth_identity_standalone.sql`, and `supabase/seed.sql`
- `scripts/test-rls-local.sh`

Focused regressions:

- `apps/control-plane/tests/supabase-auth.test.ts`
- `apps/control-plane/tests/auth-lifecycle-routes.test.ts`
- `apps/control-plane/tests/auth-migration.test.ts`
- `apps/control-plane/tests/authorization.test.ts`
- `apps/control-plane/tests/csrf.test.ts`
- `apps/control-plane/tests/project-source-pagination.test.ts`
- `apps/control-plane/tests/fixtures/postgres-worker.ts`
- affected route, configuration, repository, PostgreSQL, topology, and structure tests

## Strict TDD evidence

The initial contract tests were added before their production exports, routes, repository methods, and migration existed. The focused RED command was split by contract while implementing:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test \
  apps/control-plane/tests/supabase-auth.test.ts \
  apps/control-plane/tests/auth-lifecycle-routes.test.ts \
  apps/control-plane/tests/authorization.test.ts \
  apps/control-plane/tests/csrf.test.ts \
  apps/control-plane/tests/project-source-pagination.test.ts \
  apps/control-plane/tests/auth-migration.test.ts
```

The RED runs failed on the intended missing behavior: no Supabase SSR service/lifecycle routes, production config accepted absent Supabase inputs, protected routes still used the old fixture actor, repository provisioning/membership/cursor ports were absent, CSRF was absent, and the auth/RLS migration did not exist.

Adversarial self-review regressions were also written and observed RED one at a time before the corresponding fix:

```text
unverified sign-in/callback provider results reached provisioning
recovery did not guarantee Max-Age=0 session-cookie deletion
an encoded service-role JWT was accepted as a browser key
PostgreSQL actor resolution accepted a missing auth session identifier
an auto-confirmed signup omitted the verified user needed for provisioning
legacy personal-owner backfill did not join a confirmed auth.users identity
```

The final focused GREEN command on the complete implementation tree:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test \
  apps/control-plane/tests/supabase-auth.test.ts \
  apps/control-plane/tests/auth-lifecycle-routes.test.ts \
  apps/control-plane/tests/authorization.test.ts \
  apps/control-plane/tests/csrf.test.ts \
  apps/control-plane/tests/project-source-pagination.test.ts \
  apps/control-plane/tests/auth-migration.test.ts
tests 18; pass 18; fail 0; skipped 0; duration 563 ms
```

The final affected control-plane/database GREEN run:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test \
  apps/control-plane/tests/*.test.ts \
  packages/database/src/control-plane.test.ts \
  packages/database/src/factory.test.ts \
  packages/database/src/postgres.integration.test.ts \
  packages/database/src/postgres.test.ts
tests 93; pass 86; fail 0; skipped 7; duration 2263 ms
```

## PostgreSQL and production-topology evidence

A fresh ephemeral PostgreSQL cluster applied every migration and ran the legacy RLS/retention tests, phased-workflow SQL guards, the new auth identity/provisioning/revocation SQL test, six PostgreSQL repository integrations, and the separately launched route/worker topology regression:

```text
PAGE2WEBMCP_NATIVE_TYPESCRIPT_TESTS=true PAGE2WEBMCP_NODE_BINARY=/usr/local/bin/node \
  bash scripts/test-rls-local.sh
PostgreSQL repository tests: 6 pass; 0 fail
separate route/worker topology: 1 pass; 0 fail
Standalone PostgreSQL RLS and production-topology integration tests passed.
```

The ordinary-suite PostgreSQL tests are intentionally environment-skipped without `PAGE2WEBMCP_TEST_DATABASE_URL`; the fresh-cluster command above executes them instead of treating the skips as coverage.

## Full verification

The freshly installed workspace `tsx` remains blocked by macOS provenance scanning for `packages/database/src/workflow.test.ts`. The required trusted TSX ran every other test, and Node's native TypeScript stripping ran that exact file without changing quarantine/provenance metadata:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs --test \
  $(rg --files -g '*.test.ts' -g '!node_modules' \
    | rg -v '^packages/database/src/workflow\\.test\\.ts$' | LC_ALL=C sort)
tests 292; pass 285; fail 0; skipped 7; duration 5204 ms

/usr/local/bin/node --experimental-transform-types --test packages/database/src/workflow.test.ts
tests 14; pass 14; fail 0; skipped 0; duration 836 ms
```

Combined repository result: 306 tests, 299 pass, 7 explicit environment skips, 0 failures.

Direct gates all exited zero on the same implementation tree:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
/usr/local/bin/node /opt/homebrew/Cellar/pnpm/10.14.0/bin/pnpm audit --prod --audit-level=high
No known vulnerabilities found
git diff --check
```

An additional Next production build was attempted with `/usr/local/bin/node ../../node_modules/next/dist/bin/next build`. It emitted only the Next/Turbopack banner and no progress for two bounded minutes, so the exact process was terminated (exit 137). TypeScript, lint, policy, dependency, route tests, and the production-like PostgreSQL topology all completed; no provenance metadata was changed to bypass the local tool scan.

## Self-review

- Confirmed every protected route awaits fresh server identity plus database actor resolution; mutations additionally require exact-origin, session-bound CSRF.
- Confirmed production code does not select fixture credentials or infer roles/organizations from cookies, source fields, metadata, query/body bearer tokens, or UI state.
- Confirmed public Supabase configuration rejects secret/service-role values, including encoded JWT roles, and no secret key is added to a public/client environment.
- Confirmed provisioning is convergent, identity-scoped, RLS-backed, and unavailable through public/Data API grants.
- Confirmed organization updates retain both `USING` and `WITH CHECK`; active Supabase session deletion immediately prevents subsequent database actor resolution.
- Confirmed project pagination is stable and bounded, supported sources are generic, provider live mode remains fail closed, and workflow/release/evidence contracts are untouched.
- Confirmed the final migration backfill cannot violate the new `auth.users` foreign key for legacy fixture/non-auth memberships.
- Production source/security scans and direct review found no new Acme/default fixture branch, no `user_metadata` authorization, no bearer query acceptance, and no stale browser role store.

## Concerns and deployment gates

- No managed Supabase project credentials were available. Auth lifecycle behavior is verified with hermetic SSR client fakes and fresh local PostgreSQL, not claimed as a live managed-Supabase success. Staging must exercise email delivery, PKCE redirect allowlists, cookie chunking, global revocation propagation, and the migration against a production-shaped snapshot.
- The local Next production build could not get past the existing provenance/tool scan and was bounded/terminated as described above. A trusted CI host must run the production bundle and browser flow before release.
- The supported source envelope deliberately rejects query-bearing source URLs so OAuth/API secrets cannot be persisted as project source data. Providers requiring query credentials remain unsupported until a separate secret-reference design exists.
- Live website/browser/model adapters remain fail closed without the Task 4 provider controls and credentials; this task makes no live-provider success claim.
- Task 1's trusted installation-loader dependency remains: installation must verify exact artifact bytes and mandatory integrity metadata before JavaScript evaluation.

Implementation and this report are committed together; the exact final HEAD is reported to the orchestrator after commit.
