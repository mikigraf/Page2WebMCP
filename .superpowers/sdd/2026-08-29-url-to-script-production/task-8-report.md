# Task 8 report: exact release verification, publication, and installation

Date: 2026-08-30

Implementation commit: `8bf8570d5f3a1a4443fbe4d56042baa342e9048d`

## Result

Task 8 now has one common, fail-closed website/OpenAPI release boundary.

- Candidate authorization no longer treats deterministic compiler replay as browser execution. The control plane sends the exact reviewed candidate code, SHA-256, SHA-384 SRI, canonical manifest release identity, exact target origin, and exact tool set to a trusted verification port before eligibility can become true.
- The verifier requires a pre-evaluation trusted-loader attestation and a complete, unique set of typed checks for authentication, cancellation, confirmation, final state, absence of control-plane/model calls, origin, read behavior, replay/idempotency, reversible mutation, schema, secret leakage, tool selection, and trusted loading. Typed target failures survive persistence instead of collapsing to a generic browser flag.
- Live verification is an exact-origin, bounded, redirect-rejecting HTTP port with a 120-second local cancellation deadline and an explicit bearer control. Missing origin/token controls fail before verification. The compatibility port is injectable only outside production and is used explicitly by hermetic tests.
- Verification records now persist the normalized typed checks, CSP result, and live/hermetic mode. PostgreSQL validates the exact check set and CSP shape; historical rows are made ineligible and require trusted reverification.
- Publication remains owner-only, review-version/evidence/capability-digest bound, immutable, idempotent, SHA-256 content addressed, and SHA-384 protected. Its response contains the exact hosted URL, byte-identical download URL, module script tag, manifest, SRI, target origin, native WebMCP requirement, CSP/self-host guidance, previous immutable release, and truthful `installed: false` state.
- Artifact delivery re-hashes stored bytes and fails closed on corruption. Responses use exact-origin CORS, `Cross-Origin-Resource-Policy: cross-origin`, JavaScript content type, immutable caching, hash ETag, SRI/content-hash headers, no cookies, and optional content disposition without altering bytes.
- Installed-target verification requires the exact served and executed hash, exact origin/tool set, a normal page load, no route interception, no injected registration, no synthetic harness, harmless duplicate loading, and native WebMCP for live verification. Hosted CSP blockage records `pending_self_host`; a same-origin, query/fragment-free self-hosted URL must then be observed with the same hash before `verified` can be recorded.
- In-memory and PostgreSQL repositories persist one exact installation reference per immutable release with owner-only access, tenant/release/hash/SRI/origin/tool binding, bounded attestation metadata, deterministic idempotency, and no duplicated code or plan IR.
- The Acme fixture no longer compiles or serves `/api/releases/acme`, fetches mutable bytes, imports a blob, or calls manual register/unregister hooks. It consumes only configured immutable common-boundary URL/hash/SRI/origin metadata and renders a normal anonymous-CORS module script; missing or malformed metadata renders an explicit unconfigured marker and loads no code.

No live target, browser, provider, or CDN success is claimed.

## Main files

- `apps/control-plane/src/release-verification.ts` — exact candidate and installed-target contracts, normalization, deadlines, test-only injection, and live fail-closed HTTP adapter.
- `apps/control-plane/src/releases.ts` — trusted verification gating, install guide, previous release, and installed-target orchestration.
- `apps/control-plane/app/api/releases/[artifact]/route.ts` — immutable hosted/download artifact response.
- `apps/control-plane/app/api/projects/[projectId]/releases/[releaseId]/installation/route.ts` — owner/CSRF/idempotency protected installed verification.
- `packages/database/src/control-plane.ts` and `postgres.ts` — typed checks, release lookup/history, exact installation persistence, and repository parity.
- `supabase/migrations/20260830094622_trusted_release_installations.sql` — generated via `supabase migration new trusted_release_installations`; verification columns/constraints plus release-installation FK/index/RLS/grants.
- `apps/acme-support/app/webmcp-release-script.tsx` and `layout.tsx` — common immutable module tag. The former manual component and Acme compile route were deleted.
- Focused tests: `apps/control-plane/tests/release-verification.test.ts`, `release-route.test.ts`, `packages/database/src/task8-migration.test.ts`, database tests, and rewritten Acme release/registration tests.
- Task brief and execution plan: `docs/superpowers/plans/2026-08-30-task-8-brief.md` and `2026-08-30-task-8-implementation.md`.

## Strict RED evidence

Trusted candidate boundary:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs \
  --test apps/control-plane/tests/release-verification.test.ts

ERR_MODULE_NOT_FOUND: apps/control-plane/src/release-verification.ts
tests 1; pass 0; fail 1
```

Exact route integration after the contract existed:

```text
... --test apps/control-plane/tests/release-route.test.ts

tests 14; pass 13; fail 1
exactBytes: expected candidate code, actual ""
```

This reproduced the previous false positive: the compiler replay marked browser execution eligible without ever giving exact bytes to a trusted loader.

Installed/artifact contract:

```text
... --test apps/control-plane/tests/release-verification.test.ts apps/control-plane/tests/release-route.test.ts

release-verification: missing export attestReleaseInstallation
release-route: x-page2webmcp-content-hash expected exact hash, actual null
```

Persistence, guide, route, and Acme slices were separately RED:

```text
Task 8 migration static test: generated migration was empty; 0/1
in-memory exact installation: repository.saveReleaseInstallation is not a function; 0/1
publication guide: release.installation expected exact guide, actual undefined; 0/1
installed route: ERR_MODULE_NOT_FOUND .../[releaseId]/installation/route.ts; 0/1
Acme boundary: old mutable route still existed and webmcp-release-script.tsx was missing; 0/2
```

## GREEN evidence

Focused trusted candidate + route after exact attestation integration:

```text
... --test apps/control-plane/tests/release-route.test.ts apps/control-plane/tests/release-verification.test.ts

tests 24; pass 24; fail 0
```

Installed verifier:

```text
... --test apps/control-plane/tests/release-verification.test.ts

tests 20; pass 20; fail 0
```

Database/migration and common Acme boundary:

```text
... --test packages/database/src/control-plane.test.ts packages/database/src/task8-migration.test.ts
tests 17; pass 17; fail 0

... --test apps/acme-support/tests/release-route.test.ts apps/acme-support/tests/webmcp-registration.test.ts
tests 4; pass 4; fail 0
```

Affected compiler/runtime/control-plane/database/Acme suite:

```text
/usr/local/bin/node .../tsx/dist/cli.mjs --test \
  apps/acme-support/tests/*.test.ts \
  apps/control-plane/tests/release-route.test.ts \
  apps/control-plane/tests/release-verification.test.ts \
  packages/database/src/control-plane.test.ts \
  packages/database/src/postgres.integration.test.ts \
  packages/database/src/task8-migration.test.ts \
  packages/compiler/src/compiler.test.ts \
  packages/compiler/src/compiler.contract.test.ts \
  packages/compiler/src/compiler.adapters.test.ts

tests 134; pass 126; fail 0; skipped 8; duration 8.49s
```

The eight skips are the existing explicit PostgreSQL environment skips.

Full trusted suite:

```text
/usr/local/bin/node /Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs \
  --test test-support/**/*.test.ts apps/**/*.test.ts packages/**/*.test.ts

tests 372; pass 363; fail 0; skipped 9; duration 61.9s
```

Final post-self-review hardening rerun (query/fragment rejection, SQL idempotency precheck, bounded exact CSP validation, and release-manifest tool-set RLS binding):

```text
... --test apps/control-plane/tests/release-verification.test.ts \
  apps/control-plane/tests/release-route.test.ts \
  packages/database/src/control-plane.test.ts \
  packages/database/src/task8-migration.test.ts \
  apps/acme-support/tests/release-route.test.ts \
  apps/acme-support/tests/webmcp-registration.test.ts

tests 56; pass 56; fail 0; skipped 0; duration 2.18s
git diff --check: exit 0
```

`packages/database/src/postgres.integration.test.ts` also transpiled and enumerated successfully: eight explicit skips because `PAGE2WEBMCP_TEST_DATABASE_URL`/admin URL were absent.

## Direct gates and environment limitations

- `git diff --check` passed before both commits.
- Direct scans found no Task 8 production Acme/fixture branch, mutable Acme release URL, blob loader, manual registration, TODO/FIXME, `as any`, or TypeScript suppression in changed production files.
- The full suite exercises TypeScript transpilation for every changed TypeScript module and passed.
- Full-project `tsc`, targeted ESLint, `scripts/check-source.mjs`, and `scripts/lint-source.mjs` were each attempted with bounded waits. On this host they produced no output and did not terminate within 60–150 seconds; they were stopped rather than allowed to stall indefinitely. The host was concurrently saturated by macOS provenance scanning/virtualization and unrelated processes. No passing result is claimed for these direct gates.
- `supabase status` reported `No such container: supabase_db_Page2WebMCP`. PostgreSQL/RLS execution could not run locally; the migration static contract passed and the repository integration file transpiled, but no live migration success is claimed.
- Live verifier origin/token, target browser, and CDN credentials were unavailable. Production remains unavailable without exact controls, and only explicit hermetic ports were exercised.

## Self-review and concerns

- Re-read the Task 8 brief and Task 1–7 reports/invariants after implementation. Canonical plans/evidence/candidate bytes remain the only authorization unit; installation state references the immutable release and does not introduce a second IR.
- Checked that exact hash/SRI/origin/tool binding exists in all three layers: trusted report normalization, repository validation, and PostgreSQL FK/RLS/constraints.
- Checked that generated-tool execution receives no control-plane/model client and that the trusted report rejects any observed control-plane/model request.
- Checked cancellation flows from the incoming route signal through the local deadline into candidate and installed verification.
- Checked corrupt stored code/SRI, malformed artifact names, typed candidate failures, wrong installed hashes/origin/tools, interception, injection, synthetic harnesses, live compatibility shims, harmful duplicate loads, CSP blockage, self-host origin drift, tenant drift, and idempotency conflicts fail closed.
- PostgreSQL syntax and live RLS behavior remain the primary unexecuted risk because the local Supabase container was absent. Task 8 should receive the normal ephemeral PostgreSQL migration/RLS gate when that environment is available.
- The external trusted loader is a deployment dependency. JavaScript cannot prove its already-evaluating bytes by itself; production eligibility therefore requires the configured verifier to enforce integrity before module evaluation and attest the evaluated content hash. Missing controls cannot publish or install.
