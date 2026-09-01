# Task 11 report: alternate canonical local Supabase topology

## Status

Implemented and committed in `8e8b80a04817b16ce1d0f4b6eb177030031b5918` (`feat: move local Supabase to alternate topology`). The supported local topology is now API/Auth/Storage `58321`, PostgreSQL `58322`, Studio `58323`, Inbucket HTTP `58324`, shadow database `58320`, optional SMTP/POP3 `58325`/`58326`, analytics `58327`, and optional pooler `58329`. The edge-runtime inspector remains `8083`.

No Docker container or volume was touched and the full local stack was not started, as required by the task brief.

## Implementation

- Moved the declarative Supabase topology and all local lifecycle, runtime-role bootstrap, launcher, Auth/config, artifact publication, website, installed-verification, database-normalization, and readiness allowlists to the exact alternate ports.
- Kept HTTP local exceptions limited to the explicit local-stack flag plus exact IP-literal loopback endpoints. The old `54321`/`54322` endpoints are now negative test cases rather than accepted aliases.
- Added forward migration `20260901060852_alternate_canonical_local_supabase_topology.sql` without editing any historical migration.
- The migration drops and recreates the release and installation artifact constraints so new writes accept only the hosted prefix or `http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/`.
- Exact typed historical local identities are rewritten to the new local prefix while preserving `local_only=true`. Any previously verified matching installation becomes `failed`, loses `verified_at`, and has authenticated-read, confirmed-mutation, and final-state execution proof cleared, requiring a fresh installation verification.
- Replaced the active selected-provider context and selected-release readiness functions. Old implementations remain renamed and uncallable. The new readiness function recomputes local path facts against only `58321`, preserves the hosted-only native live proof, and requires the exact 23-migration ledger through `20260901060852`.
- Updated the local-live OpenAPI E2E topology contract and operator documentation. The documentation now records the complete port map and pinned Supabase CLI `2.116.0`.

## Files changed

- Topology/config/docs: `.env.example`, `README.md`, `docs/OPERATIONS.md`, `supabase/config.toml`
- Local operations: `scripts/local-supabase.mjs`, `scripts/local-runtime-roles.mjs`, `scripts/dev-local-live.mjs`, `scripts/check-release-readiness.ts`
- Runtime validation/identity: `apps/control-plane/src/artifact-storage.ts`, `apps/control-plane/src/auth.ts`, `apps/control-plane/src/config.ts`, `apps/control-plane/src/release-verification.ts`, `apps/worker/src/website-live.ts`, `packages/database/src/control-plane.ts`
- Migration: `supabase/migrations/20260901060852_alternate_canonical_local_supabase_topology.sql`
- Tests/contracts: `apps/control-plane/tests/artifact-storage.test.ts`, `apps/control-plane/tests/auth-session.test.ts`, `apps/control-plane/tests/config.test.ts`, `apps/control-plane/tests/release-route.test.ts`, `apps/control-plane/tests/release-verification.test.ts`, `apps/worker/src/website-live.test.ts`, `e2e/local-live-openapi.test.ts`, `packages/database/src/local-artifact-topology-migration.test.ts`, `test-support/documentation.test.ts`, `test-support/local-supabase.test.ts`, `test-support/readiness-cli.test.ts`

The unrelated untracked `docs/superpowers/.DS_Store` was not modified or committed.

## RED evidence

Tests were changed before implementation, then this focused command was run:

```text
/usr/local/bin/node --experimental-transform-types --test \
  apps/control-plane/tests/config.test.ts \
  apps/control-plane/tests/auth-session.test.ts \
  apps/control-plane/tests/artifact-storage.test.ts \
  apps/control-plane/tests/release-route.test.ts \
  apps/control-plane/tests/release-verification.test.ts \
  apps/worker/src/website-live.test.ts \
  test-support/local-supabase.test.ts \
  test-support/documentation.test.ts \
  packages/database/src/local-artifact-topology-migration.test.ts \
  e2e/local-live-openapi.test.ts
```

Expected failures were observed before implementation:

```text
not ok - marks only the exact Docker Storage topology local-only
  RELEASE_ARTIFACT_CONFIGURATION_REQUIRED
not ok - production Auth permits HTTP only for the explicit canonical IP-literal local stack
  SUPABASE_CONFIGURATION_REQUIRED
not ok - production permits HTTP Auth and control origins only for the explicit IP-literal local stack
  RELEASE_ARTIFACT_CONFIGURATION_REQUIRED
not ok - local artifact verification is hermetic-only and bound to the canonical Docker identity
  INSTALLED_VERIFICATION_INVALID
not ok - website control inventory is exact, sorted, validates values, and never returns secrets
  actual [PAGE2WEBMCP_PUBLIC_ORIGIN], expected []
not ok - alternate local topology migration advances the exact ledger and active readiness path
not ok - historical local-only identities move to the new prefix but lose installation verification
not ok - new writes accept only the alternate canonical local artifact prefix
  one forward-only topology migration must exist: 0 !== 1
not ok - operator documentation records the pinned local-live topology without fixture conflation
  must document http://127.0.0.1:58321
```

The E2E contract compiled and skipped for its documented missing external controls. The combined RED runner did not reach a final TAP summary because the host also stalled one pre-existing temp-shell child used by the local lifecycle test; only that test runner's exact child processes were terminated.

## GREEN evidence

Focused topology, runtime, migration, and documentation suite:

```text
/usr/local/bin/node --experimental-transform-types --test --test-reporter=dot \
  packages/database/src/local-artifact-topology-migration.test.ts \
  apps/control-plane/tests/config.test.ts \
  apps/control-plane/tests/auth-session.test.ts \
  apps/control-plane/tests/artifact-storage.test.ts \
  apps/control-plane/tests/release-route.test.ts \
  apps/control-plane/tests/release-verification.test.ts \
  apps/worker/src/website-live.test.ts \
  test-support/documentation.test.ts

149 tests passed; exit 0
```

Local topology and bootstrap behavior that does not invoke the host-blocked temp executable:

```text
/usr/local/bin/node --experimental-transform-types --test \
  --test-name-pattern='^(local Supabase lifecycle|runtime role bootstrap|owner bootstrap)' \
  test-support/local-supabase.test.ts

5 passed, 0 failed; exit 0
```

Local-live readiness truthfulness:

```text
/usr/local/bin/node --experimental-transform-types --test \
  --test-name-pattern='local-live runs its selected-provider topology diagnostics' \
  test-support/readiness-cli.test.ts

1 passed, 0 failed; exit 0
```

E2E contract load:

```text
/usr/local/bin/node --experimental-transform-types --test e2e/local-live-openapi.test.ts

0 failed, 1 skipped: LOCAL_LIVE_CONTROLS_REQUIRED
```

Static verification:

```text
/usr/local/bin/node node_modules/typescript/bin/tsc --project tsconfig.base.json --noEmit
/usr/local/bin/node node_modules/eslint/bin/eslint.js . --max-warnings=0
/usr/local/bin/node scripts/lint-source.mjs
/usr/local/bin/node scripts/check-source.mjs
git diff --check

all exit 0
```

## Pinned Supabase CLI evidence

`package.json` and the lockfile already pin the required CLI at `supabase@2.116.0`, and lifecycle execution remains behind `pnpm exec supabase`. After RED, the required real creation command was attempted once with an 8-second bound:

```text
/opt/homebrew/bin/gtimeout --signal=TERM --kill-after=2s 8s \
  env PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node /opt/homebrew/Cellar/pnpm/10.14.0/bin/pnpm \
  exec supabase migration new alternate_canonical_local_supabase_topology

exit 124; no output; no file created
```

The installed signed/ad-hoc Darwin CLI executable stalls on this host before producing output. The migration was therefore added with `apply_patch` using the UTC timestamp of the bounded attempt. This is reported as a limitation, not as successful CLI execution. Docker could run the pinned CLI, but the task explicitly prohibited touching Docker.

## Concerns

- The pinned `migration new` command was genuinely invoked but host-blocked and did not create the file. A later Docker-enabled verification task should run `pnpm exec supabase --version` and validate/apply migration `20260901060852`; this task does not claim the CLI creation itself succeeded.
- The Docker local-live OpenAPI journey remains deliberately unrun in Task 11. Its contract loads and skips with named controls; no live persistence claim is made here.
- Host Node 24 and newly installed Darwin executables stall in this environment. Focused TypeScript tests used `/usr/local/bin/node` 22.14.0 with native transform-types, while typecheck/lint used their JavaScript entry points directly. Repository engine policy remains Node 24 and was not changed.
- The full spawned local lifecycle test was not used as GREEN evidence because its temporary fake executable also stalls on this host. Its pure topology/bootstrap cases are green, and no result was fabricated.
