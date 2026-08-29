# Page2WebMCP MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained Page2WebMCP hackathon product that derives, verifies, releases, and demonstrates safe WebMCP tools from a website, an OpenAPI document, and a Next.js source repository.

**Architecture:** A pnpm monorepo contains the control-plane dashboard, an Acme Support Console fixture, shared capability/compiler/security packages, and a worker. All external services sit behind provider ports. Docker-backed Supabase and a local provider simulator make the complete success and safety journeys reproducible without a human or cloud credentials; real Browser Use, GitHub, and deployment providers remain opt-in adapters with the same contracts.

**Tech Stack:** Node.js 22, pnpm workspaces, Turborepo, TypeScript, Next.js App Router, React, Zod, Drizzle, Supabase/Postgres, Playwright, Vitest, MSW, Docker Compose, OpenAPI 3.0–3.2 parsers, Playwright/CDP, and imperative WebMCP feature detection.

**Spec:** `Page2WebMCP — Product Requirements Document.md`

## Execution evidence (updated 2026-08-26)

This plan remains the full target. The following vertical-slice work is implemented and verified in the repository. The original unchecked recipes below are retained as an implementation history; the dated completion audit records which requirements have authoritative current evidence.

| Area | Current evidence |
| --- | --- |
| Fixture + imperative WebMCP | TypeScript Next.js fixture has authenticated order reads, ticket creation, an R3-blocked deletion action, strict schemas, same-origin defaults, and abort-driven registration cleanup. |
| CapabilityIR | Capability records have a strict Zod runtime schema that rejects unknown fields, and status tests preserve fail-closed R3 and deterministic production-ready transitions. |
| Control-plane entry | The Next.js control plane has a visible fixture sign-in form, creates safe Website/OpenAPI/GitHub projects, rejects private and mismatched GitHub URLs, and runs each local analysis path. `e2e/control-plane.spec.ts` signs in and covers all three flows in a browser. |
| Approval boundary | Control-plane fixture login issues an HttpOnly role cookie; review and publish endpoints derive authorization only from that server-side session, never a client-supplied role. The dashboard provides explicit approve/block controls; R1/R2 approval requires the owner role, viewers cannot approve, and R3 is unconditionally blocked. Route and browser tests cover these boundaries. |
| Generated release | `GET /api/releases/acme` serves compiler-generated JavaScript with an immutable cache policy, SHA-256 ETag/content-hash header, origin manifest, strict per-tool schemas, and no `exposedTo`. `e2e/next-webmcp.spec.ts` fetches and installs it, executes both R0 and R1 tools, asserts R1 confirmation metadata, and observes the persisted ticket in the reloaded fixture UI. |
| Publication + download | The dashboard calls the deterministic owner-only publish gate and, after success, presents the fixture’s immutable release download. Browser E2E covers approval, publication, and the download link. |
| Evidence paths | Local worker workflows exercise URL-fixture/OpenAPI/source-hardening paths and preserve R3 as blocked. The real Browser Use and GitHub adapters remain opt-in work. |
| Source hardening | The constrained source analyzer uses a TypeScript AST walk to require actual ticket-service, session-helper, and cookie-read evidence. Comments or string-like lookalikes cannot authorize generated changes. |
| OpenAPI import safety | `parseOpenApiDocument()` accepts JSON and YAML OpenAPI 3.0–3.2, validates the required document shape, and fail-closes external `$ref` URLs before operation compilation. |
| Security + tenancy | Unit tests cover SSRF/firewall/redaction/gates and revalidate every redirect destination. `pnpm test:db:local` applies the committed RLS migration in a disposable PostgreSQL cluster and verifies owner/viewer/anonymous isolation. The Docker Supabase pgTAP runner is retained for environments with a responsive Docker daemon. |
| End-to-end baseline | `pnpm test:all` passes unit, type, lint, Node e2e, and Playwright browser coverage without credentials or interactive steps. |

Latest verified commands:

```bash
pnpm test:all
pnpm test:db:local
pnpm exec playwright test e2e/next-webmcp.spec.ts
pnpm build
```

Operator documentation is in [`docs/OPERATIONS.md`](../../OPERATIONS.md), covering local prerequisites, fixture accounts, the three-path demo, supported envelope, and security model.

### Completion audit (updated 2026-08-28)

| Task | Current status | Evidence / remaining boundary |
| --- | --- | --- |
| 1. Reproducible workspace | **Verified local alternative** | Root scripts, TypeScript workspace, `infra:up/down/reset`, and the machine-readable `demo:seed` command exist. Default tests use in-process lifecycle rather than Docker Compose because no service needs to persist between test processes. |
| 2. Acme fixture | **Verified** | Next.js fixture routes, public JSON OpenAPI contract, authenticated reads, R1 ticket creation, blocked R3 deletion, and browser coverage are present. |
| 3. CapabilityIR | **Verified** | Strict schema, status transitions, evidence fusion, and tests live in `packages/capability-ir`. |
| 4. Security primitives | **Verified local envelope** | Target validation, redirect revalidation, discovery firewalling, redaction, and release gates are unit-tested. DNS resolution and remote-request limits remain a live-discovery adapter responsibility. |
| 5. Imperative compiler | **Verified** | Generated same-origin `document.modelContext` artifact, abort cleanup, strict schemas, immutable response metadata, and browser installation tests are present. |
| 6. Tenant persistence | **Verified local envelope** | The committed Supabase SQL migration and disposable PostgreSQL RLS integration test prove owner, cross-tenant, and anonymous boundaries. The planned Drizzle repository layer is not used by this compact MVP. |
| 7. Providers | **Verified simulation / live deferred** | Local browser, source-control, and artifact providers are tested. Real Browser Use and GitHub App adapters require dedicated provider accounts and remain opt-in. |
| 8. Website discovery | **Verified deterministic fixture path** | Worker workflow derives the safe fixture capabilities without discovery mutations; no arbitrary remote-browser crawling is claimed. |
| 9. OpenAPI | **Verified local contract path** | JSON/YAML OpenAPI 3.0–3.2 parsing and external-reference blocking are tested. Live API-key execution remains server-adapter work. |
| 10. Source hardening | **Verified local simulation** | TypeScript AST evidence checks and constrained local draft-PR simulation are tested; an installed GitHub App is required for a real PR. |
| 11. Control plane | **Verified** | Next.js dashboard supports safe project creation, owner-only R1 approval/publication, and R3 blocking with route and browser tests. |
| 12. Verification and release | **Verified local envelope** | Deterministic gate evaluation, immutable generated artifact delivery, and installed R1 ticket creation are covered by unit and browser tests. |
| 13. CI and operations | **Verified locally; CI pending first remote run** | GitHub Actions workflow, README, architecture, testing, demo, security policy, license, local demo command, and unattended E2E suite are repository-owned and checked locally. |

This audit does not treat live-provider acceptance as complete. It requires the external credentials, deployment endpoints, and Chrome/WebMCP availability listed in `docs/OPERATIONS.md` and the deferred acceptance section below.

## Global Constraints

- Keep every runnable application, fixture, simulator, migration, test, and test account in this repository.
- Support only the ruthless MVP envelope: one HTTPS-equivalent local fixture, same-origin JSON APIs and semantic forms, two R0 reads, one reversible R1 mutation, and one R3 blocked action.
- Never persist passwords, raw cookies, authorization headers, refresh tokens, browser storage, live-view URLs, or CDP URLs.
- Generated browser code contains no server credential, `eval`, Page2WebMCP backchannel, or `exposedTo` value.
- Reject non-public URL targets and revalidate every redirect before request execution.
- Enforce discovery as read-only at the network boundary; mutations run only after an approved exact request plan.
- Treat all website, OpenAPI, and repository text as untrusted input; derive descriptions only from typed/sanitized evidence.
- A capability reaches `production_ready` only through deterministic gates; R3 never produces executable output.
- All source and generated code must pass `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` from the repository root.
- `pnpm test:e2e` must start and clean up all required local infrastructure and must not require user clicks, personal accounts, externally provisioned services, or secrets.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `apps/control-plane` | Next.js product UI and route handlers for projects, reviews, jobs, verification, and releases. |
| `apps/acme-support` | Independently runnable authenticated fixture and install target used by URL, OpenAPI, source, and browser tests. |
| `apps/worker` | Queue consumer and deterministic implementations of all three compilation paths. |
| `packages/capability-ir` | Zod schemas, status transitions, evidence fusion, risk classification, and deterministic compiler inputs. |
| `packages/compiler` | WebMCP bundle templates, runtime helpers, manifest/SRI generation, and artifact security scan. |
| `packages/security` | SSRF policy, redaction, request firewall, origin lock, and release gate logic. |
| `packages/providers` | Browser, source-control, artifact-store, queue, and model provider ports plus real and local implementations. |
| `packages/database` | Drizzle schema, migrations, repositories, tenant assertions, and test seed helpers. |
| `packages/openapi` | Safe parse/reference resolution, typed operation extraction, grouping, and adapter planning. |
| `packages/source-analyzer` | Restricted static Next.js AST analysis and source evidence mapper. |
| `packages/evals` | Deterministic tool-selection evaluator and adversarial fixtures. |
| `test-support` | Docker lifecycle, local provider simulator, browser WebMCP shim, fixtures, and test-only API clients. |
| `e2e` | Black-box Playwright journeys covering all three paths, generated installation, browser execution, and safety gates. |
| `infra` | Docker Compose, Supabase configuration, local TLS/proxy, and CI workflow definitions. |

## Autonomous Test Topology

```text
Playwright e2e runner
  -> control-plane (Next.js) -> Postgres/Supabase -> worker
  -> local provider simulator -> browser session (Playwright CDP) -> Acme Support
                                                     -> generated WebMCP bundle
```

The simulator deliberately exposes the same typed ports as Browser Use and GitHub. It creates an ephemeral Playwright browser context, supplies a test live-view identifier, records draft-PR requests, and never exposes cookies or CDP endpoints to the database or browser. `test:integration:live` is a separate, skipped-by-default suite for real providers; it uses environment variables and can never make the default test run nondeterministic.

### Task 1: Bootstrap the reproducible monorepo and developer commands

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.env.example`, `.gitignore`, `docker-compose.yml`
- Create: `infra/scripts/wait-for-services.mjs`, `infra/scripts/reset-test-data.mjs`, `.github/workflows/ci.yml`
- Test: `test-support/workspace.test.ts`

**Interfaces:**
- Produces root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `test:all`, `infra:up`, `infra:down`, and `infra:reset`.

- [ ] **Step 1: Write the failing workspace contract test**

```ts
import root from "../package.json" with { type: "json" };

it("exposes a fully autonomous verification command", () => {
  expect(root.scripts["test:all"]).toBe(
    "pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e"
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest test-support/workspace.test.ts`

Expected: FAIL because the root package manifest does not exist.

- [ ] **Step 3: Add workspace manifests, Node engine, pinned package manager, and root scripts**

```json
{
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "test:all": "pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e",
    "test:e2e": "pnpm infra:up && pnpm infra:reset && pnpm --filter @page2webmcp/e2e test && pnpm infra:down"
  }
}
```

- [ ] **Step 4: Add Docker health checks and make the lifecycle scripts wait for Postgres, the simulator, and both apps before tests start**

```ts
await waitFor("http://127.0.0.1:3100/api/health");
await waitFor("http://127.0.0.1:3200/api/health");
await waitFor("http://127.0.0.1:3400/health");
```

- [ ] **Step 5: Run the workspace test and the infrastructure smoke command**

Run: `pnpm vitest test-support/workspace.test.ts && pnpm infra:up && pnpm infra:down`

Expected: PASS; Compose reports all declared services healthy and removes only its named test containers.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .env.example .gitignore docker-compose.yml infra test-support .github
git commit -m "chore: bootstrap reproducible Page2WebMCP workspace"
```

### Task 2: Build the Acme Support fixture and its public evidence sources

**Files:**
- Create: `apps/acme-support/app/(auth)/login/page.tsx`, `apps/acme-support/app/orders/page.tsx`, `apps/acme-support/app/orders/[id]/page.tsx`, `apps/acme-support/app/settings/page.tsx`
- Create: `apps/acme-support/app/api/auth/login/route.ts`, `apps/acme-support/app/api/orders/route.ts`, `apps/acme-support/app/api/orders/[id]/route.ts`, `apps/acme-support/app/api/tickets/route.ts`, `apps/acme-support/app/api/account/route.ts`
- Create: `apps/acme-support/public/openapi.yaml`, `apps/acme-support/fixtures/seed.ts`, `apps/acme-support/middleware.ts`
- Test: `apps/acme-support/tests/api.test.ts`, `apps/acme-support/tests/ui.spec.ts`

**Interfaces:**
- Produces authenticated same-origin fixture endpoints: `GET /api/orders?q=`, `GET /api/orders/:id`, `POST /api/tickets`, and `DELETE /api/account`.
- Produces fixture identity: user `agent@example.test`, password `fixture-password`, order `ORD-4812`.

- [ ] **Step 1: Write the API tests for authorized reads, ticket creation, and blocked account deletion classification**

```ts
expect(await api.asAgent().get("/api/orders?q=ORD-4812")).toMatchObject({ status: 200 });
expect(await api.asAgent().post("/api/tickets", { orderId: "ORD-4812", title: "TEST damaged", priority: "high" })).toMatchObject({ status: 201 });
expect(await api.asAgent().delete("/api/account")).toMatchObject({ status: 403, body: { code: "HIGH_RISK_ACTION" } });
```

- [ ] **Step 2: Run the API tests to verify they fail**

Run: `pnpm --filter @page2webmcp/acme-support test`

Expected: FAIL because the fixture app and routes do not exist.

- [ ] **Step 3: Implement cookie-backed fixture authentication, semantic order pages/forms, deterministic CSRF metadata, and only the required APIs**

```ts
export const POST = withFixtureSession(async (request, user) => {
  const input = CreateTicketSchema.parse(await request.json());
  const ticket = createTicket({ ...input, createdBy: user.id });
  return Response.json(projectTicket(ticket), { status: 201 });
});
```

- [ ] **Step 4: Publish a matching OpenAPI 3.1 document and add UI tests that verify search and the visible ticket state transition**

```ts
await page.getByLabel("Search orders").fill("ORD-4812");
await expect(page.getByRole("link", { name: "ORD-4812" })).toBeVisible();
await page.getByRole("button", { name: "Create ticket" }).click();
await expect(page.getByText("TEST damaged")).toBeVisible();
```

- [ ] **Step 5: Run the fixture unit and browser tests**

Run: `pnpm --filter @page2webmcp/acme-support test && pnpm --filter @page2webmcp/acme-support test:e2e`

Expected: PASS, including logged-out 401 and no payment or account data in order responses.

- [ ] **Step 6: Commit**

```bash
git add apps/acme-support
git commit -m "feat: add Acme Support WebMCP fixture"
```

### Task 3: Define CapabilityIR, evidence provenance, and fail-closed status transitions

**Files:**
- Create: `packages/capability-ir/src/schema.ts`, `packages/capability-ir/src/status.ts`, `packages/capability-ir/src/fusion.ts`, `packages/capability-ir/src/index.ts`
- Test: `packages/capability-ir/src/status.test.ts`, `packages/capability-ir/src/fusion.test.ts`

**Interfaces:**
- Produces `CapabilityIRSchema`, `CapabilityStatus`, `transitionCapability(capability, event)`, and `mergeEvidence(evidence)`.
- Consumes sanitized `RuntimeEvidence`, `OpenApiEvidence`, and `SourceEvidence` types.

- [ ] **Step 1: Write tests that reject unknown schema fields, block R3, and deny production status without every required gate**

```ts
expect(() => CapabilityIRSchema.parse({ ...validIr, extra: true })).toThrow();
expect(transitionCapability(r3Capability, { type: "review_approved" }).status).toBe("blocked");
expect(transitionCapability(validIr, { type: "publish_requested" }).status).toBe("verified");
```

- [ ] **Step 2: Run the IR tests to verify they fail**

Run: `pnpm --filter @page2webmcp/capability-ir test`

Expected: FAIL because the package exports are absent.

- [ ] **Step 3: Implement strict Zod schemas and an event reducer with explicit transition guards**

```ts
export function transitionCapability(ir: CapabilityIR, event: CapabilityEvent): CapabilityIR {
  if (ir.safety.riskTier === "R3") return { ...ir, status: "blocked" };
  if (event.type === "verification_passed" && hasRequiredVerification(event.report)) return { ...ir, status: "verified" };
  if (event.type === "publish_requested" && canPublish(ir)) return { ...ir, status: "production_ready" };
  return ir;
}
```

- [ ] **Step 4: Implement conflict detection that returns `blocked` when runtime, contract, or source disagree on effects, input fields, or auth**

```ts
return conflicts.length === 0
  ? { status: "consistent", evidence }
  : { status: "conflict", conflicts };
```

- [ ] **Step 5: Run the package tests and typecheck**

Run: `pnpm --filter @page2webmcp/capability-ir test && pnpm --filter @page2webmcp/capability-ir typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/capability-ir
git commit -m "feat: add capability intermediate representation"
```

### Task 4: Implement deterministic security primitives

**Files:**
- Create: `packages/security/src/ssrf.ts`, `packages/security/src/redact.ts`, `packages/security/src/firewall.ts`, `packages/security/src/origin-lock.ts`, `packages/security/src/release-gate.ts`
- Test: `packages/security/src/ssrf.test.ts`, `packages/security/src/redact.test.ts`, `packages/security/src/firewall.test.ts`, `packages/security/src/release-gate.test.ts`

**Interfaces:**
- Produces `validatePublicHttpsUrl`, `sanitizeEvidence`, `createDiscoveryFirewall`, `assertAllowedOrigin`, and `evaluateReleaseGate`.

- [ ] **Step 1: Write adversarial tests for private targets, redirect revalidation, token redaction, mutation blocking, and skipped gates**

```ts
expect(await validatePublicHttpsUrl("http://127.0.0.1")).toMatchObject({ ok: false, code: "HTTPS_REQUIRED" });
expect(sanitizeEvidence({ authorization: "Bearer canary" })).not.toContain("canary");
expect(firewall.decide({ method: "POST", url: fixtureUrl })).toMatchObject({ allow: false });
expect(evaluateReleaseGate(incompleteReport).eligible).toBe(false);
```

- [ ] **Step 2: Run the security package tests to verify they fail**

Run: `pnpm --filter @page2webmcp/security test`

Expected: FAIL because implementations are absent.

- [ ] **Step 3: Implement IP/DNS classification, size/redirect limits, recursive sensitive-key redaction, and a method/origin allowlist firewall**

```ts
const blockedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
if (mode === "discovery" && blockedMethods.has(request.method)) return deny("MUTATION_BLOCKED");
```

- [ ] **Step 4: Implement the production gate as a pure predicate requiring 3 replay passes, auth negative pass, zero leaks/findings, direct browser pass, eval threshold, origin verification, and immutable artifact**

```ts
return requirements.every((requirement) => report[requirement] === true)
  ? { eligible: true, failures: [] }
  : { eligible: false, failures: requirements.filter((key) => report[key] !== true) };
```

- [ ] **Step 5: Run all security tests**

Run: `pnpm --filter @page2webmcp/security test`

Expected: PASS with explicit denial codes for every unsafe case.

- [ ] **Step 6: Commit**

```bash
git add packages/security
git commit -m "feat: add Page2WebMCP security guards"
```

### Task 5: Generate imperative WebMCP bundles and a browser-test shim

**Files:**
- Create: `packages/compiler/src/compile.ts`, `packages/compiler/src/runtime/register.ts`, `packages/compiler/src/runtime/confirmation.ts`, `packages/compiler/src/runtime/errors.ts`, `packages/compiler/src/runtime/output-projection.ts`, `packages/compiler/src/manifest.ts`
- Create: `test-support/webmcp-shim.ts`
- Test: `packages/compiler/src/compile.test.ts`, `packages/compiler/src/runtime/register.test.ts`, `packages/compiler/src/browser-registration.spec.ts`

**Interfaces:**
- Produces `compileRelease(capabilities, options): CompiledRelease` with `files`, `manifest`, `contentHash`, and `sriHash`.
- Generated entrypoint exports `registerPage2WebMCPTools()` and `unregisterPage2WebMCPTool(name)`.

- [ ] **Step 1: Write tests that compile the three fixture capabilities and assert imperative registration, strict schemas, cancellation, origin lock, and absence of secrets/cross-origin exposure**

```ts
expect(release.files["index.js"]).toContain("document.modelContext.registerTool");
expect(release.files["index.js"]).not.toContain("exposedTo");
expect(release.files["index.js"]).not.toContain("fixture-password");
expect(release.manifest.capabilities).toEqual(["find_order", "get_order_status", "create_support_ticket"]);
```

- [ ] **Step 2: Run compiler tests to verify they fail**

Run: `pnpm --filter @page2webmcp/compiler test`

Expected: FAIL because the compiler is absent.

- [ ] **Step 3: Implement templates that validate inputs, use same-origin credentials, project outputs, require R1 confirmation, propagate AbortSignal, and map typed errors**

```ts
await document.modelContext.registerTool(definition, { signal: controller.signal });
return projectOutput(raw, capability.safety.outputProjection);
```

- [ ] **Step 4: Implement the browser shim and Playwright registration test using the generated artifact served by Acme Support**

```ts
await page.addInitScript(webMcpShim);
await page.goto(`${acmeUrl}/orders`);
await expect.poll(() => page.evaluate(() => document.modelContext.getTools().map((tool) => tool.name))).toContain("find_order");
```

- [ ] **Step 5: Run compiler unit and browser tests**

Run: `pnpm --filter @page2webmcp/compiler test && pnpm --filter @page2webmcp/compiler test:e2e`

Expected: PASS; generated R1 invocation displays a confirmation and the tool unregisters on abort.

- [ ] **Step 6: Commit**

```bash
git add packages/compiler test-support/webmcp-shim.ts
git commit -m "feat: compile secure imperative WebMCP bundles"
```

### Task 6: Persist tenant-scoped control-plane data and audit history

**Files:**
- Create: `packages/database/src/schema.ts`, `packages/database/src/repositories.ts`, `packages/database/src/rls.ts`, `packages/database/migrations/0001_initial.sql`, `packages/database/src/seed.ts`
- Modify: `docker-compose.yml`
- Test: `packages/database/src/repositories.test.ts`, `packages/database/src/tenant-isolation.test.ts`

**Interfaces:**
- Produces repositories for organizations, memberships, projects, sources, jobs, evidence, capabilities, versions, test runs, releases, and audit events.
- Every repository method accepts `{ organizationId, actorId }` and rejects cross-tenant access.

- [ ] **Step 1: Write tenant-isolation tests for every exposed resource and a test proving secret-bearing browser-session values cannot be inserted**

```ts
await expect(projects.get({ organizationId: orgB, actorId: userB }, projectA.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
await expect(browserSessions.create({ cdpUrl: "ws://secret" } as never)).rejects.toThrow("persisted CDP URLs are forbidden");
```

- [ ] **Step 2: Run the database tests to verify they fail**

Run: `pnpm --filter @page2webmcp/database test`

Expected: FAIL because no schema or migrations exist.

- [ ] **Step 3: Implement Drizzle schema, SQL RLS enablement/policies, reduced grants, and a repository API that always supplies tenant scope**

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_select ON projects FOR SELECT USING (organization_id = current_setting('app.organization_id')::uuid);
```

- [ ] **Step 4: Add immutable release/audit constraints and retention timestamps for sanitized evidence**

```ts
if (release.status === "published") throw new DomainError("IMMUTABLE_RELEASE");
```

- [ ] **Step 5: Run migrations and database tests against Compose Postgres**

Run: `pnpm infra:up && pnpm --filter @page2webmcp/database test && pnpm infra:down`

Expected: PASS, including negative tenant reads and writes.

- [ ] **Step 6: Commit**

```bash
git add packages/database docker-compose.yml
git commit -m "feat: add tenant-safe Page2WebMCP persistence"
```

### Task 7: Add provider ports and autonomous local simulations

**Files:**
- Create: `packages/providers/src/contracts.ts`, `packages/providers/src/local/browser-provider.ts`, `packages/providers/src/local/source-control-provider.ts`, `packages/providers/src/local/artifact-store.ts`, `packages/providers/src/live/browser-use-provider.ts`, `packages/providers/src/live/github-provider.ts`
- Create: `test-support/provider-simulator/server.ts`, `test-support/provider-simulator/state.ts`
- Test: `packages/providers/src/local/providers.test.ts`, `test-support/provider-simulator/simulator.spec.ts`

**Interfaces:**
- Produces `BrowserProvider`, `SourceControlProvider`, `ArtifactStore`, and `ProviderRegistry`.
- `LocalBrowserProvider.start()` returns an opaque `sessionId`; credential-bearing URLs remain only in process memory.
- `LocalSourceControlProvider.openDraftPullRequest()` records a PR with changed files and check result.

- [ ] **Step 1: Write contract tests shared by local and live adapters**

```ts
export function browserProviderContract(create: () => BrowserProvider) {
  it("destroys an ephemeral session", async () => {
    const provider = create();
    const session = await provider.start({ origin: acmeOrigin });
    await provider.destroy(session.id);
    await expect(provider.observe(session.id)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
}
```

- [ ] **Step 2: Run provider tests to verify they fail**

Run: `pnpm --filter @page2webmcp/providers test`

Expected: FAIL because provider contracts and implementations are absent.

- [ ] **Step 3: Implement the local browser provider with a fresh Playwright context, programmatic fixture login, CDP observation, and automatic teardown**

```ts
const context = await this.browser.newContext();
await context.addCookies([fixtureSessionCookie]);
this.sessions.set(id, { context, expiresAt: Date.now() + 10 * 60_000 });
return { id, expiresAt, liveView: { kind: "opaque", value: id } };
```

- [ ] **Step 4: Implement source-control and artifact simulators; keep real Browser Use/GitHub adapters env-gated and inject them only through the registry**

```ts
const sourceControl = process.env.PAGE2WEBMCP_LIVE_GITHUB === "true"
  ? new GitHubProvider(liveConfig)
  : new LocalSourceControlProvider(simulatorState);
```

- [ ] **Step 5: Run provider contracts and simulator browser test**

Run: `pnpm --filter @page2webmcp/providers test && pnpm --filter @page2webmcp/test-support test:e2e`

Expected: PASS; no test output contains `fixture-password`, cookie values, or a CDP URL.

- [ ] **Step 6: Commit**

```bash
git add packages/providers test-support/provider-simulator
git commit -m "feat: add autonomous provider simulations"
```

### Task 8: Implement the safe Website URL discovery pipeline

**Files:**
- Create: `apps/worker/src/website/preflight.ts`, `apps/worker/src/website/explorer.ts`, `apps/worker/src/website/observer.ts`, `apps/worker/src/website/synthesize.ts`, `apps/worker/src/website/workflow.ts`
- Test: `apps/worker/src/website/preflight.test.ts`, `apps/worker/src/website/workflow.test.ts`, `e2e/website-path.spec.ts`

**Interfaces:**
- Produces `runWebsiteWorkflow(input): WebsiteWorkflowResult` with sanitized evidence and proposed `CapabilityIR[]`.
- Consumes a `BrowserProvider`, `SecurityPolicy`, and configured fixture origin.

- [ ] **Step 1: Write a workflow test that discovers `find_order`, `get_order_status`, `create_support_ticket`, and a blocked `delete_account` without executing POST or DELETE during discovery**

```ts
expect(result.capabilities.map((capability) => [capability.identity.name, capability.status])).toEqual([
  ["find_order", "proposed"], ["get_order_status", "proposed"], ["create_support_ticket", "proposed"], ["delete_account", "blocked"]
]);
expect(result.observedRequests.some((request) => request.method === "POST" && request.executed)).toBe(false);
```

- [ ] **Step 2: Run the workflow test to verify it fails**

Run: `pnpm --filter @page2webmcp/worker test -- website/workflow.test.ts`

Expected: FAIL because the website workflow is absent.

- [ ] **Step 3: Implement preflight, semantic bounded exploration, CDP request interception, DOM/network/state sanitization, and deterministic capability synthesis**

```ts
await page.route("**/*", async (route) => {
  const decision = firewall.decide(route.request());
  return decision.allow ? route.continue() : route.abort("blockedbyclient");
});
```

- [ ] **Step 4: Add the black-box e2e journey that creates a project, uses the local authenticated session, starts discovery, and renders source evidence on the capability page**

```ts
await page.getByRole("button", { name: "Start autonomous discovery" }).click();
await expect(page.getByText("4 capabilities discovered")).toBeVisible();
await expect(page.getByRole("row", { name: /delete_account.*Blocked/ })).toBeVisible();
```

- [ ] **Step 5: Run worker unit tests and website e2e**

Run: `pnpm --filter @page2webmcp/worker test && pnpm --filter @page2webmcp/e2e test -- website-path.spec.ts`

Expected: PASS; the captured evidence contains shape metadata but no sensitive values.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/website e2e/website-path.spec.ts
git commit -m "feat: discover safe capabilities from website evidence"
```

### Task 9: Implement safe OpenAPI compilation and adapter selection

**Files:**
- Create: `packages/openapi/src/parse.ts`, `packages/openapi/src/resolve.ts`, `packages/openapi/src/extract.ts`, `packages/openapi/src/group.ts`, `packages/openapi/src/auth.ts`
- Create: `apps/worker/src/openapi/workflow.ts`
- Test: `packages/openapi/src/parse.test.ts`, `packages/openapi/src/group.test.ts`, `apps/worker/src/openapi/workflow.test.ts`, `e2e/openapi-path.spec.ts`

**Interfaces:**
- Produces `compileOpenApi(document, options): OpenApiCompilation`, including `capabilities`, `diagnostics`, and `adapterPlans`.

- [ ] **Step 1: Write tests for OpenAPI 3.0/3.1/3.2 parsing, blocked external refs, operation grouping, and API-key server-adapter selection**

```ts
expect(compilation.capabilities.map((c) => c.identity.name)).toContain("get_order_status");
expect(compilation.diagnostics).toContainEqual(expect.objectContaining({ code: "EXTERNAL_REF_BLOCKED" }));
expect(compilation.adapterPlans.find((p) => p.auth === "api_key")?.kind).toBe("server_adapter");
```

- [ ] **Step 2: Run OpenAPI tests to verify they fail**

Run: `pnpm --filter @page2webmcp/openapi test`

Expected: FAIL because the parser package is absent.

- [ ] **Step 3: Implement safe JSON/YAML parsing, local reference-depth/cycle checks, typed extraction, auth classification, and deterministic grouping rules for the Acme contract**

```ts
if (reference.startsWith("http:" ) || reference.startsWith("https:")) {
  diagnostics.push({ code: "EXTERNAL_REF_BLOCKED", reference });
  return;
}
```

- [ ] **Step 4: Implement the worker path and e2e journey that imports Acme's `openapi.yaml`, produces the same capabilities, and executes generated `find_order` against the fixture**

```ts
await page.getByLabel("Website or OpenAPI URL").fill(`${acmeUrl}/openapi.yaml`);
await page.getByRole("button", { name: "Analyze" }).click();
await expect(page.getByText("OpenAPI contract confirmed")).toBeVisible();
```

- [ ] **Step 5: Run OpenAPI tests and the e2e spec**

Run: `pnpm --filter @page2webmcp/openapi test && pnpm --filter @page2webmcp/e2e test -- openapi-path.spec.ts`

Expected: PASS; neither the browser artifact nor persisted IR includes API-key values.

- [ ] **Step 6: Commit**

```bash
git add packages/openapi apps/worker/src/openapi e2e/openapi-path.spec.ts
git commit -m "feat: compile safe WebMCP capabilities from OpenAPI"
```

### Task 10: Implement restricted Next.js source hardening and draft-PR generation

**Files:**
- Create: `packages/source-analyzer/src/analyze.ts`, `packages/source-analyzer/src/nextjs.ts`, `packages/source-analyzer/src/evidence.ts`, `packages/source-analyzer/src/generate.ts`
- Create: `apps/worker/src/github/workflow.ts`
- Test: `packages/source-analyzer/src/analyze.test.ts`, `apps/worker/src/github/workflow.test.ts`, `e2e/github-path.spec.ts`

**Interfaces:**
- Produces `analyzeNextjsSource(root): SourceAnalysis` and `generateHardeningChange(analysis, capabilities): GeneratedChange`.
- `GeneratedChange` only writes under `app/_page2webmcp`, `app/api/page2webmcp`, `tests/page2webmcp`, and `docs/page2webmcp-security.md`.

- [ ] **Step 1: Write AST tests that identify Acme route handlers, Zod inputs, auth/authorization helpers, ticket service, and reject a source tree with no authorization evidence**

```ts
expect(analysis.capabilities.find((item) => item.name === "create_support_ticket")).toMatchObject({
  authorization: { status: "source_confirmed" }, service: "createTicket"
});
expect(() => generateHardeningChange(unsecuredAnalysis, capabilities)).toThrow("AUTHORIZATION_UNCONFIRMED");
```

- [ ] **Step 2: Run the source analyzer tests to verify they fail**

Run: `pnpm --filter @page2webmcp/source-analyzer test`

Expected: FAIL because source analysis is absent.

- [ ] **Step 3: Implement static TypeScript AST traversal only; do not run dependency install or source scripts, and generate narrow wrappers that preserve the discovered authorization helper**

```ts
const allowedOutputPaths = ["app/_page2webmcp/", "app/api/page2webmcp/", "tests/page2webmcp/", "docs/page2webmcp-security.md"];
if (!allowedOutputPaths.some((path) => file.path.startsWith(path))) throw new DomainError("GENERATED_PATH_FORBIDDEN");
```

- [ ] **Step 4: Implement the local draft PR flow and e2e assertion that the PR description names reused service/auth evidence and the generated fixture branch passes typecheck/tests**

```ts
await expect(page.getByText("Draft PR #1 created")).toBeVisible();
await expect(page.getByText("Existing order authorization preserved")).toBeVisible();
```

- [ ] **Step 5: Run analyzer and GitHub-path tests**

Run: `pnpm --filter @page2webmcp/source-analyzer test && pnpm --filter @page2webmcp/e2e test -- github-path.spec.ts`

Expected: PASS, with no token persisted and no generated direct database access.

- [ ] **Step 6: Commit**

```bash
git add packages/source-analyzer apps/worker/src/github e2e/github-path.spec.ts
git commit -m "feat: harden Next.js sources through draft PRs"
```

### Task 11: Build the control-plane dashboard and approval boundaries

**Files:**
- Create: `apps/control-plane/app/page.tsx`, `apps/control-plane/app/projects/[id]/page.tsx`, `apps/control-plane/app/projects/[id]/capabilities/[capabilityId]/page.tsx`, `apps/control-plane/app/projects/[id]/verification/page.tsx`, `apps/control-plane/app/projects/[id]/releases/page.tsx`
- Create: `apps/control-plane/app/api/projects/route.ts`, `apps/control-plane/app/api/projects/[id]/jobs/route.ts`, `apps/control-plane/app/api/capabilities/[id]/approve/route.ts`, `apps/control-plane/app/api/capabilities/[id]/verify/route.ts`, `apps/control-plane/app/api/releases/[id]/publish/route.ts`
- Test: `apps/control-plane/tests/routes.test.ts`, `e2e/dashboard.spec.ts`

**Interfaces:**
- Produces a URL/OpenAPI input, project state view, evidence-backed capability review, explicit R1 validation approval, verification display, and publish action.

- [ ] **Step 1: Write route tests proving an owner may approve/publish, an editor cannot publish, and mutation verification cannot start before explicit approval**

```ts
expect(await postAs(editor, `/api/releases/${releaseId}/publish`)).toMatchObject({ status: 403 });
expect(await postAs(owner, `/api/capabilities/${r1Id}/verify`)).toMatchObject({ status: 409, body: { code: "MUTATION_APPROVAL_REQUIRED" } });
```

- [ ] **Step 2: Run control-plane tests to verify they fail**

Run: `pnpm --filter @page2webmcp/control-plane test`

Expected: FAIL because the app and API handlers are absent.

- [ ] **Step 3: Implement authenticated project routes and UI cards using server-side repositories; render structured evidence rather than unsanitized page content**

```tsx
<CapabilityCard capability={capability} evidenceCount={capability.evidence.length} />
{capability.safety.riskTier === "R1" && <MutationApprovalButton capabilityId={capability.id} />}
```

- [ ] **Step 4: Add browser tests covering URL type detection, blocked R3 display, edit/approve lifecycle, and owner-only publish control**

```ts
await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
await page.getByRole("button", { name: "Approve test plan" }).click();
await expect(page.getByText("Mutation validation approved")).toBeVisible();
```

- [ ] **Step 5: Run app tests and dashboard e2e spec**

Run: `pnpm --filter @page2webmcp/control-plane test && pnpm --filter @page2webmcp/e2e test -- dashboard.spec.ts`

Expected: PASS; all privileged actions are denied to non-owners.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane e2e/dashboard.spec.ts
git commit -m "feat: add Page2WebMCP project dashboard"
```

### Task 12: Orchestrate verification, evals, immutable artifacts, and installation

**Files:**
- Create: `apps/worker/src/verification/runner.ts`, `apps/worker/src/verification/replay.ts`, `apps/worker/src/verification/security.ts`, `packages/evals/src/evaluate.ts`, `packages/evals/src/fixtures.ts`, `apps/worker/src/release/publish.ts`
- Create: `e2e/release-and-installation.spec.ts`, `e2e/security-gates.spec.ts`
- Test: `apps/worker/src/verification/runner.test.ts`, `packages/evals/src/evaluate.test.ts`, `apps/worker/src/release/publish.test.ts`

**Interfaces:**
- Produces `runVerification(capabilityVersionId): VerificationReport` and `publishRelease(releaseId): PublishedRelease`.
- Verification result includes contract, auth-negative, three replay, direct browser, secret scan, risk, and tool-selection results.

- [ ] **Step 1: Write tests that accept only a complete 3/3-safe report, reject a secret canary or an eval below 18/20, and preserve published release bytes/hash**

```ts
expect(await publishRelease(releaseWithMissingReplay)).toMatchObject({ ok: false, code: "RELEASE_GATE_FAILED" });
expect(await verify(secretCanaryCapability)).toMatchObject({ secretLeakage: false });
expect(await publishRelease(verifiedRelease)).toMatchObject({ ok: true, immutable: true });
```

- [ ] **Step 2: Run verification and release tests to verify they fail**

Run: `pnpm --filter @page2webmcp/worker test -- verification release && pnpm --filter @page2webmcp/evals test`

Expected: FAIL because verification/evaluation implementations are absent.

- [ ] **Step 3: Implement exact R1 request-plan authorization, three isolated replays, logged-out/forbidden runs, direct shim execution, artifact scans, and deterministic fixture prompt selection**

```ts
const selection = selectTool("Find order ORD-4812", availableCapabilities);
expect(selection).toEqual({ name: "find_order", arguments: { query: "ORD-4812" } });
```

- [ ] **Step 4: Generate immutable content-addressed artifacts, self-hosted install instructions, manifest/SRI, and Acme installation route; verify the installed bundle affects the real fixture UI**

```ts
await page.evaluate(() => document.modelContext.executeTool("create_support_ticket", {
  orderId: "ORD-4812", title: "TEST browser invocation", priority: "high"
}));
await expect(page.getByText("TEST browser invocation")).toBeVisible();
```

- [ ] **Step 5: Run verification, security, and installation e2e specs**

Run: `pnpm --filter @page2webmcp/e2e test -- release-and-installation.spec.ts security-gates.spec.ts`

Expected: PASS; published bundle is immutable, origin-locked, secret-free, and performs a confirmed visible mutation.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/verification apps/worker/src/release packages/evals e2e/release-and-installation.spec.ts e2e/security-gates.spec.ts
git commit -m "feat: verify and publish immutable WebMCP releases"
```

### Task 13: Complete end-to-end orchestration, CI, and operator documentation

**Files:**
- Create: `e2e/full-demo.spec.ts`, `e2e/fixtures.ts`, `scripts/run-e2e.mjs`, `README.md`, `SECURITY.md`, `LICENSE`, `docs/architecture.md`, `docs/testing.md`, `docs/demo.md`
- Modify: `.github/workflows/ci.yml`, `package.json`
- Test: `e2e/full-demo.spec.ts`

**Interfaces:**
- `pnpm test:e2e` performs clean setup, seed, all paths, approval, verification, publish, installation, browser invocation, and cleanup.
- `pnpm demo:seed` returns the local control-plane and fixture URLs plus the seeded owner credentials only for local demo use.

- [ ] **Step 1: Write the single happy-path e2e test with no manual browser interaction**

```ts
test("URL-to-installed-WebMCP demonstration", async ({ page }) => {
  await createFixtureProject(page);
  await runWebsiteDiscovery(page);
  await approveR1Validation(page, "create_support_ticket");
  await verifyAndPublish(page);
  await installAndInvokeGeneratedTool(page);
});
```

- [ ] **Step 2: Run the full-demo spec to verify it fails**

Run: `pnpm --filter @page2webmcp/e2e test -- full-demo.spec.ts`

Expected: FAIL until the complete stack is wired.

- [ ] **Step 3: Create shared e2e fixtures that start services, reset the database, seed Acme, attach the WebMCP shim, and collect only redacted diagnostics on failure**

```ts
test.afterAll(async () => {
  await resetTestData();
  await assertNoSecretCanaryInArtifacts();
});
```

- [ ] **Step 4: Configure CI to run unit/type/lint, build both applications, Compose-based e2e, and an artifact scan; document local setup, supported scope, security model, and three-minute demo steps**

```yaml
- run: corepack enable && pnpm install --frozen-lockfile
- run: pnpm test:all
```

- [ ] **Step 5: Run the exact repository acceptance command from a clean infrastructure state**

Run: `pnpm infra:down && pnpm test:all`

Expected: PASS with no skipped default e2e test, no external credential prompt, and a generated Playwright report.

- [ ] **Step 6: Commit**

```bash
git add e2e scripts README.md SECURITY.md LICENSE docs .github package.json
git commit -m "docs: complete autonomous end-to-end verification"
```

## Final Acceptance Run

- [x] Run `pnpm infra:down && pnpm test:all` from the repository root (passed 2026-08-28; lint, typecheck, Node tests, and Playwright E2E).
- [x] Confirm all three path specs pass independently: `e2e/website-path.spec.ts`, `e2e/openapi-path.spec.ts`, and `e2e/github-path.spec.ts` passed together on 2026-08-28.
- [x] Confirm the autonomous full demo creates a ticket through the generated tool path, while `e2e/next-webmcp.spec.ts` installs the served generated bundle and observes the ticket in Acme Support (passed 2026-08-28).
- [x] Confirm security-gate tests reject secret leakage, a cross-tenant access attempt, R3 generation, unapproved mutation validation, and incomplete release gates (`pnpm test:all` plus `pnpm test:db:local`, passed 2026-08-28).
- [x] Confirm `git status --short` contains only intended audit, CI/docs, demo-helper, and browser-acceptance work before the final integration commit (2026-08-28).

## Deferred Live-Provider Acceptance

The default suite is the product's required autonomous test. After it is stable, CI may run `pnpm test:integration:live` only in a protected environment with dedicated disposable credentials. That suite verifies Browser Use, GitHub App, Chrome WebMCP, and a preview deployment through the same provider contracts. It must never gate local development or claim successful execution when credentials are absent.
