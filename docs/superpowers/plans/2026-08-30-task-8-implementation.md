# Task 8 Exact Release Verification and Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify exact reviewed candidate bytes through a trusted loader, publish one immutable hosted/downloadable artifact, and record installation only after a normal target page serves and natively registers those exact bytes.

**Architecture:** Add one release-verification port with candidate and installed-target operations; hermetic tests inject an explicit compatibility implementation while production uses a bounded exact-origin verifier and fails closed without controls. Persist typed candidate checks and exact installation attestations that reference the existing immutable release, then make the Acme fixture consume the same SRI module-script installation contract.

**Tech Stack:** TypeScript, Node test runner, Next.js 16 App Router route handlers, PostgreSQL/Supabase RLS, generated ES modules and native WebMCP.

**Spec:** `docs/superpowers/plans/2026-08-30-task-8-brief.md`

## Global Constraints

- Strict RED→GREEN for every production behavior.
- Exact reviewed canonical plans/evidence/candidate bytes remain the only authorization unit.
- No compiler replay may count as browser execution or trusted-loader enforcement.
- No control-plane/model request during generated-tool execution; no alternate release IR or customer initialization API.
- Live verification controls absent means fail closed; hermetic compatibility shims must be explicit test-only ports.
- No live target/browser success claim.

---

### Task 1: Trusted Candidate Verification Port

**Files:**
- Create: `apps/control-plane/src/release-verification.ts`
- Create: `apps/control-plane/tests/release-verification.test.ts`
- Modify: `apps/control-plane/src/releases.ts`
- Modify: `apps/control-plane/tests/release-route.test.ts`

**Interfaces:**
- Produces: `ReleaseVerificationPort`, `ReleaseVerificationCheck`, `setReleaseVerificationPortForTest`, and exact normalized candidate/installed reports.
- Consumes: immutable `CandidateRelease`, manifest, target origin, expected tool names, deadline signal.

- [ ] Write RED tests proving exact bytes/hash/SRI and trusted-loader evidence are mandatory; each required typed failure rejects eligibility.
- [ ] Run focused RED and capture compiler-replay false positive plus missing API errors.
- [ ] Implement bounded report schemas, exact set equality, locale-independent ordering, deadline/cancellation, test-only injection, and fail-closed production HTTP controls.
- [ ] Change verification/publication to await the port and persist only normalized exact checks.
- [ ] Run focused GREEN.

### Task 2: Typed Verification and Installation Persistence

**Files:**
- Create: `supabase/migrations/<generated>_exact_release_installation.sql`
- Modify: `packages/database/src/control-plane.ts`
- Modify: `packages/database/src/postgres.ts`
- Modify: `packages/database/src/control-plane.test.ts`
- Modify: `packages/database/src/postgres.integration.test.ts`

**Interfaces:**
- Produces: typed `VerificationCheckRecord`, `ReleaseInstallationRecord`, `getRelease`, `getPreviousRelease`, and `saveReleaseInstallation` repository methods.
- Consumes: existing release/candidate/evidence/review digests; installation rows store references and attestations, never duplicate artifact bytes/plans.

- [ ] Write RED in-memory/PostgreSQL tests for missing/duplicate/failed checks, cross-tenant releases, mismatched install hash/SRI/tool set, and idempotent exact installation.
- [ ] Generate the migration with the installed Supabase CLI; add checks, foreign keys, indexes, forced RLS, minimal app grants, and direct-role isolation tests.
- [ ] Implement in-memory/PostgreSQL parity and race-safe installation insert/replay.
- [ ] Run focused and ephemeral PostgreSQL GREEN.

### Task 3: Immutable Artifact and Installation APIs

**Files:**
- Modify: `apps/control-plane/app/api/releases/[artifact]/route.ts`
- Modify: `apps/control-plane/app/api/projects/[projectId]/releases/route.ts`
- Create: `apps/control-plane/app/api/projects/[projectId]/releases/[releaseId]/installation/route.ts`
- Modify: `apps/control-plane/tests/release-route.test.ts`
- Modify: `apps/control-plane/tests/postgres-topology.integration.test.ts`

**Interfaces:**
- Produces: identical hosted/download bytes and exact install metadata: module tag, manifest, SRI, origin, compatibility, CSP/self-host result, previous release, installed status.
- Consumes: release repository and installed-target verification port.

- [ ] Write RED route tests for byte identity, content disposition, immutable/CORS/CORP/ETag/no-cookie headers, corrupt records, CSP self-host guidance, and installed verification fail-closed cases.
- [ ] Implement deterministic artifact response headers and install response builders.
- [ ] Implement owner/CSRF-protected installed-target verification with no route interception/injection/synthetic harness and exact native tool discovery.
- [ ] Run focused GREEN and publication-race tests.

### Task 4: Common Acme Installation Boundary

**Files:**
- Delete: `apps/acme-support/app/api/releases/acme/route.ts`
- Delete: `apps/acme-support/app/webmcp-registration.tsx`
- Create: `apps/acme-support/app/webmcp-release-script.tsx`
- Modify: `apps/acme-support/app/layout.tsx`
- Modify: `apps/acme-support/tests/release-route.test.ts`
- Modify: `apps/acme-support/tests/webmcp-registration.test.ts`

**Interfaces:**
- Produces: a normal module `<script>` with immutable content-addressed URL, SHA-384 SRI, anonymous CORS, and automatic module evaluation.
- Consumes: the same control-plane artifact/install metadata as website/OpenAPI projects.

- [ ] Write RED structural/behavior tests proving no Acme compile route, blob import, manual register/unregister, injected registration, or mutable artifact URL remains.
- [ ] Implement fail-closed exact script metadata parsing with no fallback and render the common module tag.
- [ ] Run Acme and compiler-runtime GREEN including duplicate module-load behavior.

### Task 5: Verification, Report, and Commit

**Files:**
- Create: `.superpowers/sdd/2026-08-29-url-to-script-production/task-8-report.md`

- [ ] Run affected and full trusted suites.
- [ ] Run typecheck, ESLint, source/security, dependency, and diff gates.
- [ ] Run ephemeral PostgreSQL/RLS/topology tests and record explicit live skips.
- [ ] Self-review exact byte/data flow, races, RLS, CSP/self-host status, and no alternate/manual registration path.
- [ ] Append the complete report, commit the verified tree, and leave it clean.
