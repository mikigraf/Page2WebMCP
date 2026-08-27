# Page2WebMCP

Page2WebMCP compiles existing web and OpenAPI evidence into a constrained, imperative WebMCP tool layer.

## Implemented vertical slice

- TypeScript Acme Support fixture app with authenticated order search/status, ticket creation, and an intentionally blocked account deletion action.
- OpenAPI 3.1 evidence for the fixture.
- Shared `CapabilityIR` status model that blocks R3 and gates production publication on deterministic verification.
- Security primitives for HTTPS/public-target checks, read-only discovery firewalling, origin allowlisting, and recursive credential redaction.
- Imperative WebMCP artifact compiler using current `document.modelContext.registerTool()` registration, strict schemas, same-origin defaults, annotations, and abort-driven unregistration.
- Worker workflow that derives the fixture’s three executable tools and preserves the high-risk capability as blocked evidence.
- Fully automated TypeScript end-to-end acceptance test, with no interactive login or external service requirement.

## Run verification

```bash
corepack enable
pnpm install
pnpm test:all
pnpm test:db:local
```

`test:db:local` starts a disposable local PostgreSQL cluster, applies the committed Supabase migration, and verifies tenant RLS as an owner, a viewer in a second organization, and an anonymous caller. It is intentionally separate from `test:all` because it needs local PostgreSQL binaries; `supabase test db` remains the equivalent pgTAP suite when the Docker-based Supabase stack is available.

The fixture HTTP server is exercised by the test suite. Its public API contract is available from `AcmeSupport#openApiDocument()` and at `/openapi.json` when started through `startAcmeServer()`.

See [the local operation guide](docs/OPERATIONS.md) for fixture accounts, the three-path demo, supported scope, and the security model.

## Current WebMCP API alignment

Generated artifacts use `document.modelContext`, which Chrome documents as the current imperative API; they do not use the deprecated `navigator.modelContext` surface. Tool registrations use an `AbortSignal` for lifecycle cleanup, and generated code does not opt into cross-origin exposure. See Chrome’s [imperative API guide](https://developer.chrome.com/docs/ai/webmcp/imperative-api) and [tool security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools).
