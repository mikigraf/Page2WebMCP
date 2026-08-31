# Addendum: three offered paths + Supabase Storage public origin

**Status:** Locked 2026-08-31 by Mickey via Chief of Staff

**Parent:** `2026-08-31-local-live-user-journey-design.md`

This addendum overrides two parent choices. Everything else in the parent still stands, including hermetic / local-live / live profiles, Acme as test-only, fail-closed credentials, no invented keys, and liveSuccess true only after native HTTPS install proof.

## 1. Offer all three source paths

The parent said OpenAPI is the first executable local-live reference path, and website/GitHub factories fail closed until their controls exist.

Product lock: the UI offers three source paths. A user can run any one of them.

| Path | What it is | Fail closed when |
| --- | --- | --- |
| OpenAPI | Bounded DNS/HTTPS OpenAPI fetch, per-project verification context | Missing OPENAPI_LIVE_CONFIGURATION_REQUIRED or OPENAPI_VERIFICATION_CONTEXT_REQUIRED |
| Website | Browser Use v4 on a real site. API v4, model browser-use-2.0, ephemeral sessions, no recording/profile/workspace/memory, exact allowlists | Missing Browser Use key, egress proxy, ownership, KMS/TTL secret store, leases, evidence, or CDP observer (WEBSITE_LIVE_CONFIGURATION_REQUIRED) |
| GitHub | GitHub App, immutable commit analysis, selected-repo bindings, sandbox. Idempotent draft PR only. Never merge. Never fabricate a PR | Missing App, bindings, or sandbox |

A worker process still runs exactly one adapter (PAGE2WEBMCP_PROVIDER_MODE=local|openapi|website|github). Missing controls are startup failures, not leased jobs. The UI still shows all three paths. A path whose controls are absent is blocked with the named missing env, not hidden and not stubbed with a fake run.

Do not shrink this week to OpenAPI-only. Codex Pro 20x / ultra is available for this slice. Quota is not a reason to drop website or GitHub.

## 2. Public artifact origin is this app's Supabase Storage

The parent said PAGE2WEBMCP_PUBLIC_ORIGIN may be the control plane, a CDN, or a reverse proxy.

Product lock: published bundles are uploaded to this app's Supabase Storage, public bucket, content-addressed <sha256>.js.

- PAGE2WEBMCP_PUBLIC_ORIGIN is that public HTTPS origin (the Storage public URL prefix).
- Upload the exact candidate bytes. Serving, download, and SRI/SHA-256 must match.
- Control-plane /api/releases/<sha256>.js may still exist for local hash checks. Production install uses the Storage public URL.
- Local-live uses Docker Storage. Live uses this app's hosted Supabase Storage.
- Do not put Page2WebMCP artifacts in the Fullbeam Supabase project.
- Loopback HTTP artifacts stay labeled local-only and cannot satisfy --live.
- Do not invent a third-party CDN.

## 3. Unchanged

- Work only in the url-to-script worktree. Do not rewrite Tasks 1-9. Do not push unless asked.
- Hermetic and local-live always liveSuccess false.
- Live mode requires native HTTPS install proof.
- Contest leftover: under-3-minute video plus a real Storage public URL.
- Docker local-live is not the contest submit.
