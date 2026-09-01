# Task 13 report: durable Browser Use authentication handoff

## Status

Implemented and committed in `f914903` (`feat(worker): resume durable website authentication`). A website analysis can now persist sanitized public evidence, suspend the exact Browser Use v4 session behind a gateway-owned checkpoint, atomically enter Task 12's database wait state, and later resume the same checkpointed session in a fresh worker/runtime process. The worker does not retain a lease while a human authenticates.

No prior migration or Tasks 1–9 text was changed. The unrelated untracked `docs/superpowers/.DS_Store` was neither modified nor committed.

## Protocol and API decisions

- The analysis adapter now returns a discriminated outcome: a completed `AnalysisResult` or `waiting_for_authentication`. The waiting branch exposes only the Task 12 checkpoint reference, immutable source/snapshot/origin digests, expiry, and empty result collections.
- Browser Use suspension is a distinct, attested disposition. The gateway attestation must use protocol version 1 and exactly bind the lowercase SHA-256 checkpoint URN, organization/project/run, source snapshot and identity, target-origin digest, public-evidence reference, provider-session digest, live/CDP secret references, browser lease, egress reference/digest, browser-policy digest, and expiry.
- If checkpoint creation is malformed, mismatched, throws after an ambiguous external effect, or cannot reach the runner, the wrapper calls the gateway abort/reconciliation operation. Gateway ownership determines whether local cleanup would double-clean; otherwise local cleanup revokes references, stops/reconciles the session, releases the lease, and revokes egress.
- `processNextAnalysis` stops and awaits its heartbeat before Task 12's atomic wait transition. A successful wait returns without completing or failing the analysis. A failed or ambiguous database wait invokes checkpoint reconciliation before the existing failure/lease-loss handling.
- Resumed claims validate the exact persisted organization/project/run, snapshot, source identity hash, target-origin digest, public evidence reference, and TTL before any gateway operation. Resume uses the checkpoint's CDP secret reference and never creates another egress policy or Browser Use session.
- The evidence store now supports a bounded content-addressed read which verifies ownership, byte size, canonical reference, and SHA-256 integrity before deterministic public/authenticated evidence merging.
- Authentication evidence is restricted to the reviewed target origin and bounded semantic signals; credential-, cookie-, token-, OTP-, authorization-, and CSRF-shaped fields fail closed.
- Gateway operations are explicit bounded endpoints for checkpoint `create`, `status`, `resume`, `finalize`, and `reconcile`, plus evidence `get`. Stable checkpoint idempotency envelopes exclude worker lease generation; pre-checkpoint provider effects remain delivery-generation scoped.
- Website startup attestation must report `authenticationCheckpointProtocolVersion: 1`. Missing, malformed, or older protocol claims fail before repository construction with `WEBSITE_HANDOFF_PROTOCOL_UNSUPPORTED`.
- Finalize and reconciliation execute from a terminal `finally` path after resumed work. Normal completion, failure, cancellation, and expiry retain exact-once cleanup semantics.

## Files changed

- Browser suspension protocol and fault tests: `packages/providers/src/browser-use-v4.ts`, `packages/providers/src/browser-use-v4.test.ts`
- Evidence integrity read and tests: `packages/providers/src/website-evidence.ts`, `packages/providers/src/website-evidence.test.ts`
- Durable website analysis/resume protocol and tests: `apps/worker/src/workflow.ts`, `apps/worker/src/workflow.test.ts`
- Production gateway construction, startup attestation, and tests: `apps/worker/src/website-live.ts`, `apps/worker/src/website-live.test.ts`
- Runner wait/reconciliation behavior and tests: `apps/worker/src/runner.ts`, `apps/worker/src/runner.test.ts`
- Production provenance wrapper: `apps/worker/src/production-runtime.ts`
- Safe claimed source-snapshot metadata in both repository implementations: `packages/database/src/control-plane.ts`, `packages/database/src/postgres.ts`

## RED evidence

Tests were written before the implementation and run in the task-owned Node 24 Docker environment:

```text
docker run --rm \
  -v "$PWD":/workspace \
  -v page2webmcp-auth-node-modules:/workspace/node_modules \
  -w /workspace node:24.20.0-bookworm-slim \
  node --experimental-transform-types --test \
  packages/providers/src/browser-use-v4.test.ts \
  packages/providers/src/website-evidence.test.ts \
  apps/worker/src/workflow.test.ts \
  apps/worker/src/runner.test.ts

23 passed, 5 failed; exit 1
```

The expected failures proved the missing surface: `session.suspend` did not exist, website analysis still threw `WEBSITE_DURABLE_AUTHENTICATION_HANDOFF_REQUIRED`, the evidence store had no integrity read, and the runner treated a waiting outcome as a completed analysis.

## GREEN evidence

Focused Task 13 behavior suite, expanded to include the production gateway and startup protocol:

```text
docker run --rm \
  -v "$PWD":/workspace \
  -v page2webmcp-auth-node-modules:/workspace/node_modules \
  -w /workspace node:24.20.0-bookworm-slim \
  node --experimental-transform-types --test \
  packages/providers/src/browser-use-v4.test.ts \
  packages/providers/src/website-evidence.test.ts \
  apps/worker/src/workflow.test.ts \
  apps/worker/src/runner.test.ts \
  apps/worker/src/website-live.test.ts

58 passed, 0 failed; exit 0
```

This includes attested suspension, malformed/mismatched/ambiguous suspension with gateway abort, local fallback cleanup only when the gateway does not own termination, evidence integrity, safe waiting metadata, atomic wait behavior, fresh-worker resume, exact same-session observation, stable idempotency, protocol downgrade denial, credential denial, and failure/reconciliation coverage at each resume boundary.

Full Node 24 typecheck:

```text
docker run --rm \
  -v "$PWD":/workspace \
  -v page2webmcp-auth-node-modules:/workspace/node_modules \
  -w /workspace node:24.20.0-bookworm-slim \
  node node_modules/typescript/bin/tsc \
  --project tsconfig.base.json --noEmit --pretty false

exit 0; no output
```

Focused ESLint over all 13 implementation/test files:

```text
docker run --rm \
  -v "$PWD":/workspace \
  -v page2webmcp-auth-node-modules:/workspace/node_modules \
  -w /workspace node:24.20.0-bookworm-slim \
  node node_modules/eslint/bin/eslint.js \
  apps/worker/src/production-runtime.ts \
  apps/worker/src/runner.ts apps/worker/src/runner.test.ts \
  apps/worker/src/workflow.ts apps/worker/src/workflow.test.ts \
  apps/worker/src/website-live.ts apps/worker/src/website-live.test.ts \
  packages/database/src/control-plane.ts packages/database/src/postgres.ts \
  packages/providers/src/browser-use-v4.ts packages/providers/src/browser-use-v4.test.ts \
  packages/providers/src/website-evidence.ts packages/providers/src/website-evidence.test.ts

exit 0; no output
```

Repository source-policy and diff checks:

```text
docker run --rm -v "$PWD":/workspace \
  -v page2webmcp-auth-node-modules:/workspace/node_modules \
  -w /workspace node:24.20.0-bookworm-slim node scripts/lint-source.mjs
docker run --rm -v "$PWD":/workspace \
  -v page2webmcp-auth-node-modules:/workspace/node_modules \
  -w /workspace node:24.20.0-bookworm-slim node scripts/check-source.mjs
git diff --check

all exit 0; no output
```

## Concerns

- No real Browser Use or authentication-gateway credentials were available or used. The exact bounded external protocol was exercised through deterministic transport fixtures; this report does not claim a production native installation or production live success.
- Task 13 changes no database schema. It consumes the already accepted Task 12 wait/resume contract and does not replay or reset a Supabase stack.
- Verification was the focused Task 13 behavior suite plus full typecheck and source/static checks, not the exhaustive repository suite.
- Production correctness still depends on the configured gateway actually honoring protocol v1 ownership, durable checkpoint storage, secret-reference resolution, and exact-once termination. Startup attestation and every runtime response fail closed when those bindings are absent or inconsistent.
