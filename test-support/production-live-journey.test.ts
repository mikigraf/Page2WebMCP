import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildDeploymentIdentity } from "../apps/control-plane/src/deployment-identity.ts";
import {
  runProductionLiveJourneyCli,
  type ProductionLiveJourneyDependencies,
  type ProductionLiveSessionPort,
} from "../scripts/run-production-live-journey.ts";
import type { ProductionLiveReceiptV1 } from "../packages/operations/src/production-live.ts";

const HOSTED =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function deploymentIdentity(overrides: Partial<Parameters<typeof buildDeploymentIdentity>[0]> = {}) {
  return buildDeploymentIdentity({
    gitCommitSha: "c".repeat(40),
    applicationReleaseId: "page2webmcp-2026_09_01-rc1",
    controlPlaneOrigin: "https://control.widgets.dev",
    sourceTreeSha256: "d".repeat(64),
    ...overrides,
  });
}

function environment(provider: "openapi" | "website" = "openapi"): Record<string, string> {
  const common: Record<string, string> = {
    DATABASE_URL:
      "postgresql://page2webmcp_app:password@db.bimqgiedckdurqiywctl.supabase.co:5432/postgres?sslmode=require",
    PAGE2WEBMCP_MAINTENANCE_DATABASE_URL:
      "postgresql://page2webmcp_maintenance:password@db.bimqgiedckdurqiywctl.supabase.co:5432/postgres?sslmode=require",
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.widgets.dev",
    PAGE2WEBMCP_SUPABASE_URL: "https://bimqgiedckdurqiywctl.supabase.co",
    PAGE2WEBMCP_SUPABASE_SECRET_KEY: `sb_secret_${"s".repeat(32)}`,
    PAGE2WEBMCP_PUBLIC_ORIGIN: HOSTED,
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.widgets.dev",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: `verifier_${"v".repeat(32)}`,
    PAGE2WEBMCP_GIT_COMMIT_SHA: "c".repeat(40),
    PAGE2WEBMCP_APPLICATION_RELEASE_ID: "page2webmcp-2026_09_01-rc1",
    PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE: "/secure/operator.json",
    PAGE2WEBMCP_RECEIPT_SIGNING_KEY: `receipt_signing_${"k".repeat(32)}`,
    PAGE2WEBMCP_PROVIDER_MODE: provider,
    PAGE2WEBMCP_E2E_SOURCE_URL: provider === "openapi"
      ? "https://specs.widgets.dev/openapi.json"
      : "https://account.widgets.dev/",
    PAGE2WEBMCP_E2E_INSTALL_PAGE_URL: provider === "openapi"
      ? "https://staging.widgets.dev/install"
      : "https://account.widgets.dev/install",
    PAGE2WEBMCP_E2E_ENVIRONMENT: "production",
  };
  if (provider === "openapi") {
    common.PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN = "https://staging.widgets.dev";
    common.PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL = "https://staging.widgets.dev/webmcp-test";
  } else {
    const origins = [
      "AUTH_HANDOFF", "BROWSER_LEASE_STORE", "BROWSER_USE_API", "CDP_OBSERVER",
      "EGRESS_POLICY", "EGRESS_PROXY", "EVIDENCE_STORE", "OWNERSHIP_STORE", "SECRET_STORE",
    ];
    for (const name of origins) common[`PAGE2WEBMCP_${name}_ORIGIN`] = `https://${name.toLowerCase().replaceAll("_", "-")}.widgets.dev`;
    const tokens = [
      "AUTH_HANDOFF", "BROWSER_LEASE_STORE", "CDP_OBSERVER", "EGRESS_POLICY", "EGRESS_PROXY",
      "EVIDENCE_STORE", "OWNERSHIP_STORE", "SECRET_STORE",
    ];
    for (const name of tokens) common[`PAGE2WEBMCP_${name}_TOKEN`] = `${name.toLowerCase()}_${"t".repeat(32)}`;
    common.PAGE2WEBMCP_BROWSER_USE_API_KEY = `bu_${"k".repeat(32)}`;
    common.PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID = "alias/page2webmcp-production-live";
  }
  return common;
}

class FakeSession implements ProductionLiveSessionPort {
  readonly calls: Array<{ method: "login" | "get" | "post"; path?: string; body?: unknown; key?: string }> = [];
  readonly responses: unknown[];

  constructor(responses: unknown[]) { this.responses = [...responses]; }

  async login(): Promise<unknown> {
    this.calls.push({ method: "login" });
    return this.next();
  }

  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: "get", path });
    return this.next() as T;
  }

  async post<T>(path: string, body: unknown, key: string): Promise<T> {
    this.calls.push({ method: "post", path, body, key });
    return this.next() as T;
  }

  private next(): unknown {
    assert.ok(this.responses.length > 0, "unexpected control-plane call");
    return this.responses.shift();
  }
}

function dependencies(session: FakeSession, extra: Partial<ProductionLiveJourneyDependencies> = {}): ProductionLiveJourneyDependencies {
  return {
    createSession: () => session,
    loadBuildIdentity: () => deploymentIdentity(),
    readCredentials: async () => ({ email: "operator@widgets.dev", password: "strong-password" }),
    fetch: async (resource) => {
      const url = String(resource);
      const response = new Response("bundle", {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    },
    runReadiness: async () => ({
      output: { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false },
      exitCode: 2,
    }),
    inspectWorkTree: async () => ({ commit: "c".repeat(40), dirty: false }),
    delay: async () => undefined,
    maxPolls: 2,
    ...extra,
  };
}

test("dry-run validates and plans without credentials, HTTP, publication, or receipts", async () => {
  const session = new FakeSession([]);
  const result = await runProductionLiveJourneyCli(
    ["--provider", "openapi", "--dry-run"], environment(), dependencies(session),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.code, "PRODUCTION_LIVE_DRY_RUN_READY");
  assert.equal(result.output.liveSuccess, false);
  assert.deepEqual(session.calls, []);
  assert.equal(result.output.receiptLocation, undefined);
});


test("a live run refuses a dirty or diverged operator tree before any control-plane call", async () => {
  for (const [inspection, code] of [
    [{ commit: "c".repeat(40), dirty: true }, "DEPLOYMENT_BUILD_TREE_DIRTY"],
    [{ commit: "a".repeat(40), dirty: false }, "DEPLOYMENT_BUILD_COMMIT_MISMATCH"],
  ] as const) {
    const session = new FakeSession([]);
    const result = await runProductionLiveJourneyCli(
      ["--live", "--provider", "openapi"], environment(),
      dependencies(session, { inspectWorkTree: async () => inspection }),
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.code, code);
    assert.equal(result.output.liveSuccess, false);
    assert.deepEqual(session.calls, []);
  }

  const failing = new FakeSession([]);
  const failed = await runProductionLiveJourneyCli(
    ["--live", "--provider", "openapi"], environment(),
    dependencies(failing, { inspectWorkTree: async () => { throw new Error("DEPLOYMENT_BUILD_GIT_FAILED"); } }),
  );
  assert.equal(failed.output.code, "DEPLOYMENT_BUILD_GIT_FAILED");

  // A dry-run makes no live claim and never touches the operator tree.
  let inspected = false;
  const dryRun = await runProductionLiveJourneyCli(
    ["--dry-run", "--provider", "openapi"], environment(),
    dependencies(new FakeSession([]), {
      inspectWorkTree: async () => { inspected = true; return { commit: "c".repeat(40), dirty: true }; },
    }),
  );
  assert.equal(dryRun.output.code, "PRODUCTION_LIVE_DRY_RUN_READY");
  assert.equal(inspected, false);
});

test("live verifies the public deployment identity before opening operator credentials", async () => {
  const session = new FakeSession([
    deploymentIdentity(),
    { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "queued" },
    {
      run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{
        id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "proposed", version: 1,
      }],
    },
  ]);
  let credentialsOpened = false;
  const result = await runProductionLiveJourneyCli(
    ["--live", "--provider", "openapi"],
    environment(),
    dependencies(session, {
      readCredentials: async () => {
        assert.deepEqual(session.calls, [{ method: "get", path: "/api/deployment-identity" }]);
        credentialsOpened = true;
        return { email: "operator@widgets.dev", password: "strong-password" };
      },
    }),
  );
  assert.equal(credentialsOpened, true);
  assert.equal(result.output.code, "CAPABILITY_REVIEW_REQUIRED");
  assert.deepEqual(session.calls.slice(0, 2), [
    { method: "get", path: "/api/deployment-identity" },
    { method: "login" },
  ]);
});

test("live OpenAPI uses customer APIs and stops for explicit human capability review", async () => {
  const session = new FakeSession([
    deploymentIdentity(),
    { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "queued" },
    {
      run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{
        id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "proposed", version: 1,
      }],
    },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--live", "--provider", "openapi"], environment(), dependencies(session),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "CAPABILITY_REVIEW_REQUIRED");
  assert.equal(result.output.liveSuccess, false);
  assert.equal(session.calls.some((call) => call.path?.includes("/releases")), false);
  const createProject = session.calls.find((call) => call.path === "/api/projects");
  assert.deepEqual((createProject!.body as { sourceConfiguration: unknown }).sourceConfiguration, {
    kind: "openapi",
    targetOrigin: "https://staging.widgets.dev",
    testPageUrl: "https://staging.widgets.dev/webmcp-test",
    environment: "production",
  });
});

test("published exact bytes produce installation instructions and no verifier call until hash confirmation", async () => {
  const bytes = Buffer.from("bundle");
  const hash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex"));
  const sri = await import("node:crypto").then(({ createHash }) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`);
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const session = new FakeSession([
    deploymentIdentity(),
    { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
    {
      run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{
        id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2,
      }],
    },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: {
      id: "44444444-4444-4444-8444-444444444444", contentHash: hash, sri, url: artifactUrl,
      installation: {
        artifactUrl,
        downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash,
        integrity: sri,
        targetOrigin: "https://staging.widgets.dev",
        verificationPageUrl: "https://staging.widgets.dev/webmcp-test",
        localOnly: false,
      },
    } },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--live", "--provider", "openapi"], environment(), dependencies(session),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "INSTALLATION_ACTION_REQUIRED");
  assert.equal(result.output.selectedHash, hash);
  assert.equal(result.output.liveSuccess, false);
  assert.equal(session.calls.some((call) => call.path?.endsWith("/installation")), false);
});

test("website journey creates a real ownership challenge and stops before analysis", async () => {
  const session = new FakeSession([
    deploymentIdentity(),
    { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "website" },
    { ownership: { state: "missing", targetOrigin: "https://account.widgets.dev" }, canAnalyze: false },
    { ownership: {
      state: "pending", method: "well_known", targetOrigin: "https://account.widgets.dev",
      expiresAt: "2026-09-01T13:00:00.000Z",
      instructions: { url: "https://account.widgets.dev/.well-known/page2webmcp-verification.txt", content: "proof" },
    }, canAnalyze: false },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--live", "--provider", "website"], environment("website"), dependencies(session),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "WEBSITE_OWNERSHIP_ACTION_REQUIRED");
  assert.equal(result.output.liveSuccess, false);
  assert.equal(session.calls.some((call) => call.path === "/api/projects/analyze"), false);
});

test("website authentication handoff requires an explicit worker recycle boundary before acknowledgement", async () => {
  const session = new FakeSession([
    deploymentIdentity(),
    { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "website" },
    { ownership: { state: "verified", targetOrigin: "https://account.widgets.dev" }, canAnalyze: true },
    { runId: "22222222-2222-4222-8222-222222222222", status: "queued" },
    {
      run: { id: "22222222-2222-4222-8222-222222222222", status: "waiting" },
      capabilities: [],
      websiteUserHandoff: { authentication: {
        endpoint: "/api/workflow-runs/22222222-2222-4222-8222-222222222222/website-authentication",
        state: "waiting",
      } },
    },
    { authentication: { state: "ready", targetOrigin: "https://account.widgets.dev",
      expiresAt: "2026-09-01T13:00:00.000Z", canAct: true } },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--live", "--provider", "website"], environment("website"), dependencies(session),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "WEBSITE_WORKER_RESTART_AND_AUTHENTICATION_REQUIRED");
  assert.equal(result.output.liveSuccess, false);
  assert.equal(session.calls.some((call) => call.method === "post"
    && call.path?.endsWith("/website-authentication")), false);
});

test("website authentication acknowledgement uses the durable handoff API and then reloads analysis", async () => {
  const runId = "22222222-2222-4222-8222-222222222222";
  const endpoint = `/api/workflow-runs/${runId}/website-authentication`;
  const session = new FakeSession([
    deploymentIdentity(),
    { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "website" },
    { ownership: { state: "verified", targetOrigin: "https://account.widgets.dev" }, canAnalyze: true },
    { runId, status: "queued" },
    { run: { id: runId, status: "waiting" }, capabilities: [],
      websiteUserHandoff: { authentication: { endpoint, state: "waiting" } } },
    { authentication: { state: "ready", targetOrigin: "https://account.widgets.dev",
      expiresAt: "2026-09-01T13:00:00.000Z", canAct: true } },
    { authentication: { state: "resumed", targetOrigin: "https://account.widgets.dev",
      expiresAt: "2026-09-01T13:00:00.000Z", canAct: false } },
    { run: { id: runId, status: "succeeded" },
      result: { providerProvenance: { mode: "website", fixture: false } },
      capabilities: [{ id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "proposed", version: 1 }] },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--provider", "website", "--live", "--resume-authentication"],
    environment("website"),
    dependencies(session),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "CAPABILITY_REVIEW_REQUIRED");
  const acknowledgement = session.calls.find((call) => call.method === "post" && call.path === endpoint);
  assert.deepEqual(acknowledgement?.body, { action: "check" });
  assert.equal(result.output.liveSuccess, false);
});

test("live result stays false when installed verification exists but readiness lacks exact native evidence", async () => {
  const bytes = Buffer.from("bundle");
  const hash = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex"));
  const sri = await import("node:crypto").then(({ createHash }) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`);
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const session = new FakeSession([
    deploymentIdentity(),
    { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
    {
      run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{
        id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2,
      }],
    },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: {
      id: "44444444-4444-4444-8444-444444444444", contentHash: hash, sri, url: artifactUrl,
      installation: {
        artifactUrl, downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash, integrity: sri, targetOrigin: "https://staging.widgets.dev",
        verificationPageUrl: "https://staging.widgets.dev/webmcp-test", localOnly: false,
      },
    } },
    { installation: {
      status: "verified", artifactContentHash: hash, targetOrigin: "https://staging.widgets.dev",
      webMcpImplementation: "native", verifierIdentity: { mode: "live" },
      attestation: { executedContentHash: hash, normalPageLoad: true, routeInterception: false,
        injectedRegistration: false, syntheticHarness: false },
    } },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--provider", "openapi", "--live", "--confirm-installed", hash],
    environment(),
    dependencies(session),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "LIVE_INSTALLATION_EVIDENCE_REQUIRED");
  assert.equal(result.output.liveSuccess, false);
  assert.equal(result.output.receiptLocation, undefined);
});

test("each live execution requests a fresh append-only installation attestation", async () => {
  const bytes = Buffer.from("bundle");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const session = () => new FakeSession([
    deploymentIdentity(), { role: "owner" },
    { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
    { run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{ id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2 }] },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: { id: "44444444-4444-4444-8444-444444444444", contentHash: hash, sri, url: artifactUrl,
      installation: { artifactUrl, downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash, integrity: sri, targetOrigin: "https://staging.widgets.dev",
        verificationPageUrl: "https://staging.widgets.dev/webmcp-test", localOnly: false } } },
    { installation: { status: "verified", artifactContentHash: hash, targetOrigin: "https://staging.widgets.dev",
      webMcpImplementation: "native", verifierIdentity: { mode: "live" },
      attestation: { executedContentHash: hash, normalPageLoad: true, routeInterception: false,
        injectedRegistration: false, syntheticHarness: false } } },
  ]);
  const keys: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = session();
    const result = await runProductionLiveJourneyCli(
      ["--provider", "openapi", "--live", "--confirm-installed", hash],
      environment(),
      dependencies(current),
    );
    assert.equal(result.output.code, "LIVE_INSTALLATION_EVIDENCE_REQUIRED");
    const installation = current.calls.find((call) => call.path?.endsWith("/installation"));
    assert.ok(installation?.key);
    keys.push(installation.key);
  }
  assert.notEqual(keys[0], keys[1]);
});

test("live journey rejects a deployed identity mismatch before creating a project", async () => {
  const session = new FakeSession([
    deploymentIdentity({ gitCommitSha: "d".repeat(40) }),
    { role: "owner" },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--live", "--provider", "openapi"], environment(), dependencies(session),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.code, "DEPLOYMENT_IDENTITY_MISMATCH");
  assert.equal(result.output.liveSuccess, false);
  assert.equal(session.calls.some((call) => call.path === "/api/projects"), false);
});

test("live journey rejects a remote source tree that differs from the exact local build manifest", async () => {
  const session = new FakeSession([
    deploymentIdentity({ sourceTreeSha256: "e".repeat(64) }),
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--live", "--provider", "openapi"], environment(), dependencies(session),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.code, "DEPLOYMENT_IDENTITY_MISMATCH");
  assert.equal(result.output.liveSuccess, false);
  assert.deepEqual(session.calls, [{ method: "get", path: "/api/deployment-identity" }]);
});

test("live success is emitted only after the exact persisted v2 receipt projection is written", async () => {
  const bytes = Buffer.from("bundle");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const projectId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const releaseId = "44444444-4444-4444-8444-444444444444";
  const session = new FakeSession([
    deploymentIdentity(), { role: "owner" }, { id: projectId, sourceType: "openapi" },
    { runId, status: "succeeded" },
    { run: { id: runId, status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{ id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2 }] },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: { id: releaseId, contentHash: hash, sri, url: artifactUrl,
      installation: { artifactUrl, downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash, integrity: sri, targetOrigin: "https://staging.widgets.dev",
        verificationPageUrl: "https://staging.widgets.dev/webmcp-test", localOnly: false } } },
    { installation: { status: "verified", artifactContentHash: hash, targetOrigin: "https://staging.widgets.dev",
      webMcpImplementation: "native", verifierIdentity: { mode: "live" },
      attestation: { executedContentHash: hash, normalPageLoad: true, routeInterception: false,
        injectedRegistration: false, syntheticHarness: false } } },
  ]);
  const issued = new Date(Date.now() - 90_000);
  const candidateAttested = new Date(issued.getTime() + 30_000);
  const installationIssued = new Date(issued.getTime() + 40_000);
  const installationAttested = new Date(issued.getTime() + 70_000);
  let written: ProductionLiveReceiptV1 | undefined;
  let readinessDeploymentIdentityDigest: string | undefined;
  const result = await runProductionLiveJourneyCli(
    ["--provider", "openapi", "--live", "--confirm-installed", hash],
    environment(),
    dependencies(session, {
      fetch: async (resource) => {
        const url = String(resource);
        const response = new Response("bundle", {
          status: 200,
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
        Object.defineProperty(response, "url", { value: url });
        return response;
      },
      runReadiness: async (_args, _environment, binding) => {
        readinessDeploymentIdentityDigest = binding.deploymentIdentityDigest;
        return {
          output: { status: "passed", code: "LIVE_READINESS_PASSED", liveSuccess: true }, exitCode: 0,
        };
      },
      loadReceiptEvidence: async () => ({
        applicationRoleDigest: "1".repeat(64),
        maintenanceRoleDigest: "2".repeat(64),
        context: {
          selectedReleaseHash: hash,
          releaseIdDigest: digest(`release:${releaseId}`),
          organizationIdentityDigest: "3".repeat(64),
          projectIdentityDigest: digest(`project:${projectId}`),
          analysisRunIdentityDigest: digest(`analysis:${runId}`),
          sourceType: "openapi",
          sourceIdentityDigest: "4".repeat(64),
          sourceDocumentIdentityDigest: "5".repeat(64),
          sourceIdentityHash: "6".repeat(64),
          targetOrigin: "https://staging.widgets.dev",
          environment: "production",
          testPageIdentityDigest: "7".repeat(64),
          installPageIdentityDigest: "8".repeat(64),
          artifactUrl,
          downloadUrl,
          artifactSizeBytes: bytes.byteLength,
          artifactIntegrity: sri,
          hostedObjectIdentityDigest: "9".repeat(64),
          namedDownloadIdentityDigest: "a".repeat(64),
          installationIdentityDigest: "b".repeat(64),
          provider: { mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
          migrationRange: { from: "20260826000000", to: "20260901140000", digest: "c".repeat(64) },
          openapiCleanupDigest: "d".repeat(64),
          verifier: {
            identityDigest: "e".repeat(64), protocolVersion: 2,
            candidate: {
              attestationId: "55555555-5555-4555-8555-555555555555",
              requestId: "66666666-6666-4666-8666-666666666666", operation: "candidate",
              nonceDigest: "1".repeat(64), scopeDigest: "2".repeat(64), payloadDigest: "3".repeat(64),
              issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + 120_000).toISOString(),
              attestedAt: candidateAttested.toISOString(),
            },
            installation: {
              attestationId: "77777777-7777-4777-8777-777777777777",
              requestId: "88888888-8888-4888-8888-888888888888", operation: "installation",
              nonceDigest: "4".repeat(64), scopeDigest: "5".repeat(64), payloadDigest: "6".repeat(64),
              issuedAt: installationIssued.toISOString(),
              expiresAt: new Date(installationIssued.getTime() + 120_000).toISOString(),
              attestedAt: installationAttested.toISOString(),
            },
          },
          installationVerifiedAt: new Date(installationAttested.getTime() + 1_000).toISOString(),
        },
      }),
      writeReceipt: async ({ receipt }) => {
        written = receipt;
        return `/secure/receipts/${receipt.integrity.digest}.json`;
      },
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.code, "PRODUCTION_LIVE_JOURNEY_PASSED");
  assert.equal(result.output.liveSuccess, true);
  assert.equal(result.output.receiptDigest, written?.integrity.digest);
  assert.match(result.output.receiptLocation ?? "", /^\/secure\/receipts\/[0-9a-f]{64}\.json$/);
  assert.equal(written?.verifier.protocolVersion, 2);
  assert.equal(written?.release.selectedHash, hash);
  assert.equal(readinessDeploymentIdentityDigest, deploymentIdentity().identityDigest);
  assert.equal(written?.deployment.controlPlaneIdentityDigest, readinessDeploymentIdentityDigest);
  assert.ok(result.output.completedOperations.includes("write-immutable-receipt"));
  // The MIME type is the one observed on both published responses, not an assertion.
  assert.equal(written?.artifact.mimeType, "application/javascript");
  assert.equal(written?.hostedObject.mimeType, "application/javascript");
  assert.equal(written?.namedDownload.mimeType, "application/javascript");
  assert.equal(written?.deployment.sourceTreeSha256, "d".repeat(64));
  assert.match(written?.installation.verifiedAt ?? "", /^2\d{3}-/);
  assert.equal(written?.signature.algorithm, "hmac-sha256");
  assert.deepEqual([...result.output.completedOperations].sort(),
    [...result.output.plannedOperations].sort(),
    "a passed journey must complete every operation it planned");
});

function websiteEvidence(selectedHash: string, runId: string) {
  const expiresAt = "2026-09-01T12:09:00.000Z";
  const publicEvidenceReference = `urn:sha256:${"3".repeat(64)}`;
  const ttlSecretDigestEvidence = [
    { purpose: "browser_cdp_url" as const, referenceDigest: "9".repeat(64), expiresAt },
    { purpose: "browser_live_url" as const, referenceDigest: "0".repeat(64), expiresAt },
  ];
  return {
    selectedReleaseHash: selectedHash,
    analysisRunIdentityDigest: createHash("sha256").update(runId, "utf8").digest("hex"),
    sourceSnapshotIdentityDigest: "2".repeat(64),
    sourceIdentityHash: "6".repeat(64),
    targetOriginDigest: createHash("sha256").update("https://account.widgets.dev", "utf8").digest("hex"),
    ownershipDecisionDigest: "a".repeat(64),
    providerSessionIdentityDigest: "4".repeat(64),
    browserUseApiVersion: "v4" as const,
    browserUseModel: "browser-use-2.0" as const,
    browserUseAdapter: "browser-use-v4" as const,
    browserUseAdapterVersion: 4 as const,
    browserPolicyDigest: "6".repeat(64),
    browserLeaseIdentityDigest: "7".repeat(64),
    browserLeaseExpiresAt: expiresAt,
    egressPolicyReferenceDigest: "8".repeat(64),
    egressPolicyDigest: "5".repeat(64),
    cdpReferenceDigest: "9".repeat(64),
    publicEvidenceReference,
    ttlSecretDigestEvidence,
    checkpointIdentityDigest: "b".repeat(64),
    checkpointExpiresAt: expiresAt,
    suspendedWorkerIdentityDigest: "c".repeat(64),
    suspendedLeaseGeneration: 1,
    suspendedAt: "2026-09-01T12:00:00.000Z",
    authenticationEvidenceReferenceDigest: "d".repeat(64),
    authenticationConsumedAt: "2026-09-01T12:01:00.000Z",
    resumedWorkerIdentityDigest: "e".repeat(64),
    resumeLeaseGeneration: 2,
    resumeClaimedAt: "2026-09-01T12:02:00.000Z",
    resultCheckpointHash: "b".repeat(64),
    resultCheckpointOutputReference: `urn:sha256:${selectedHash}`,
    resultCheckpointWorkerIdentityDigest: "1".repeat(64),
    resultCheckpointLeaseGeneration: 3,
    resultCheckpointedAt: "2026-09-01T12:03:00.000Z",
    completionWorkerIdentityDigest: "f".repeat(64),
    completionLeaseGeneration: 4,
    resumeAcknowledgedAt: "2026-09-01T12:04:00.000Z",
    restartVerified: true,
    cleanupResources: [
      { resource: "browser_lease" as const, identityDigest: "7".repeat(64), disposition: "released" as const,
        timestamp: "2026-09-01T12:04:00.000Z" },
      { resource: "browser_session" as const, identityDigest: "4".repeat(64), disposition: "destroyed" as const,
        timestamp: "2026-09-01T12:04:00.000Z" },
    ],
  };
}

test("a passed website journey completes every planned operation and binds the egress policy reference", async () => {
  const bytes = Buffer.from("bundle");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const projectId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const releaseId = "44444444-4444-4444-8444-444444444444";
  const session = new FakeSession([
    deploymentIdentity(), { role: "owner" }, { id: projectId, sourceType: "website" },
    { ownership: { state: "verified", targetOrigin: "https://account.widgets.dev" }, canAnalyze: true },
    { runId, status: "succeeded" },
    { run: { id: runId, status: "succeeded" },
      result: { providerProvenance: { mode: "website", fixture: false } },
      capabilities: [{ id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2 }] },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: { id: releaseId, contentHash: hash, sri, url: artifactUrl,
      installation: { artifactUrl, downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash, integrity: sri, targetOrigin: "https://account.widgets.dev",
        verificationPageUrl: "https://account.widgets.dev/", localOnly: false } } },
    { installation: { status: "verified", artifactContentHash: hash, targetOrigin: "https://account.widgets.dev",
      webMcpImplementation: "native", verifierIdentity: { mode: "live" },
      attestation: { executedContentHash: hash, normalPageLoad: true, routeInterception: false,
        injectedRegistration: false, syntheticHarness: false } } },
  ]);
  const issued = new Date(Date.now() - 90_000);
  const installationIssued = new Date(issued.getTime() + 40_000);
  const installationAttested = new Date(issued.getTime() + 70_000);
  let written: ProductionLiveReceiptV1 | undefined;
  const result = await runProductionLiveJourneyCli(
    ["--provider", "website", "--live", "--confirm-installed", hash],
    environment("website"),
    dependencies(session, {
      runReadiness: async () => ({
        output: { status: "passed", code: "LIVE_READINESS_PASSED", liveSuccess: true }, exitCode: 0,
      }),
      loadReceiptEvidence: async () => ({
        applicationRoleDigest: "1".repeat(64),
        maintenanceRoleDigest: "2".repeat(64),
        website: websiteEvidence(hash, runId),
        context: {
          selectedReleaseHash: hash,
          releaseIdDigest: digest(`release:${releaseId}`),
          organizationIdentityDigest: "3".repeat(64),
          projectIdentityDigest: digest(`project:${projectId}`),
          analysisRunIdentityDigest: digest(`analysis:${runId}`),
          sourceType: "website",
          sourceIdentityDigest: "4".repeat(64),
          sourceDocumentIdentityDigest: "5".repeat(64),
          sourceIdentityHash: "6".repeat(64),
          targetOrigin: "https://account.widgets.dev",
          environment: "production",
          testPageIdentityDigest: "7".repeat(64),
          installPageIdentityDigest: "8".repeat(64),
          artifactUrl,
          downloadUrl,
          artifactSizeBytes: bytes.byteLength,
          artifactIntegrity: sri,
          hostedObjectIdentityDigest: "9".repeat(64),
          namedDownloadIdentityDigest: "a".repeat(64),
          installationIdentityDigest: "b".repeat(64),
          provider: { mode: "website", adapter: "browser-use-v4", adapterVersion: 4 },
          migrationRange: { from: "20260826000000", to: "20260901140000", digest: "c".repeat(64) },
          verifier: {
            identityDigest: "e".repeat(64), protocolVersion: 2,
            candidate: {
              attestationId: "55555555-5555-4555-8555-555555555555",
              requestId: "66666666-6666-4666-8666-666666666666", operation: "candidate",
              nonceDigest: "1".repeat(64), scopeDigest: "2".repeat(64), payloadDigest: "3".repeat(64),
              issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + 120_000).toISOString(),
              attestedAt: new Date(issued.getTime() + 30_000).toISOString(),
            },
            installation: {
              attestationId: "77777777-7777-4777-8777-777777777777",
              requestId: "88888888-8888-4888-8888-888888888888", operation: "installation",
              nonceDigest: "4".repeat(64), scopeDigest: "5".repeat(64), payloadDigest: "6".repeat(64),
              issuedAt: installationIssued.toISOString(),
              expiresAt: new Date(installationIssued.getTime() + 120_000).toISOString(),
              attestedAt: installationAttested.toISOString(),
            },
          },
          installationVerifiedAt: new Date(installationAttested.getTime() + 1_000).toISOString(),
        },
      }),
      writeReceipt: async ({ receipt }) => {
        written = receipt;
        return `/secure/receipts/${receipt.integrity.digest}.json`;
      },
    }),
  );
  assert.equal(result.output.code, "PRODUCTION_LIVE_JOURNEY_PASSED");
  assert.equal(result.output.liveSuccess, true);
  assert.deepEqual([...result.output.completedOperations].sort(),
    [...result.output.plannedOperations].sort(),
    "a passed website journey must complete every operation it planned");
  assert.equal(written?.schema, "WebsiteBrowserUseLiveJourneyReceiptV1");
  assert.equal(written?.schema === "WebsiteBrowserUseLiveJourneyReceiptV1"
    ? written.egress.referenceDigest : undefined, "8".repeat(64));
});


test("a published artifact served with a non-JavaScript media type fails the journey closed", async () => {
  const bytes = Buffer.from("bundle");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const session = new FakeSession([
    deploymentIdentity(), { role: "owner" }, { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
    { run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{ id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2 }] },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: { id: "44444444-4444-4444-8444-444444444444", contentHash: hash, sri, url: artifactUrl,
      installation: { artifactUrl, downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash, integrity: sri, targetOrigin: "https://staging.widgets.dev",
        verificationPageUrl: "https://staging.widgets.dev/webmcp-test", localOnly: false } } },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--provider", "openapi", "--live", "--confirm-installed", hash], environment(), dependencies(session, {
      fetch: async (resource) => {
        const url = String(resource);
        const response = new Response("bundle", {
          status: 200,
          headers: { "content-type": url.includes("download=") ? "text/javascript" : "application/javascript" },
        });
        Object.defineProperty(response, "url", { value: url });
        return response;
      },
    }),
  );
  assert.equal(result.output.code, "PUBLISHED_ARTIFACT_IDENTITY_INVALID");
  assert.equal(result.output.liveSuccess, false);
});

test("a mid-journey readiness control failure names every missing control exactly", async () => {
  const bytes = Buffer.from("bundle");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const session = new FakeSession([
    deploymentIdentity(), { role: "owner" }, { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
    { run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{ id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2 }] },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: { id: "44444444-4444-4444-8444-444444444444", contentHash: hash, sri, url: artifactUrl,
      installation: { artifactUrl, downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash, integrity: sri, targetOrigin: "https://staging.widgets.dev",
        verificationPageUrl: "https://staging.widgets.dev/webmcp-test", localOnly: false } } },
    { installation: { status: "verified", artifactContentHash: hash, targetOrigin: "https://staging.widgets.dev",
      webMcpImplementation: "native", verifierIdentity: { mode: "live" },
      attestation: { executedContentHash: hash, normalPageLoad: true, routeInterception: false,
        injectedRegistration: false, syntheticHarness: false } } },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--provider", "openapi", "--live", "--confirm-installed", hash], environment(), dependencies(session, {
      runReadiness: async () => ({
        output: {
          status: "skipped",
          code: "LIVE_CONTROLS_REQUIRED",
          liveSuccess: false,
          missingKeys: ["PAGE2WEBMCP_GIT_COMMIT_SHA", "PAGE2WEBMCP_SUPABASE_SECRET_KEY"],
        },
        exitCode: 2,
      }),
    }),
  );
  assert.equal(result.output.code, "LIVE_CONTROLS_REQUIRED");
  assert.deepEqual(result.output.missingControls, [
    "PAGE2WEBMCP_GIT_COMMIT_SHA",
    "PAGE2WEBMCP_SUPABASE_SECRET_KEY",
  ]);
  assert.equal(result.output.liveSuccess, false);
});

test("positive readiness without the persisted receipt projection remains false", async () => {
  const bytes = Buffer.from("bundle");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sri = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  const artifactUrl = `${HOSTED}/${hash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${hash}.js`;
  const session = new FakeSession([
    deploymentIdentity(), { role: "owner" }, { id: "11111111-1111-4111-8111-111111111111", sourceType: "openapi" },
    { runId: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
    { run: { id: "22222222-2222-4222-8222-222222222222", status: "succeeded" },
      result: { providerProvenance: { mode: "openapi", fixture: false } },
      capabilities: [{ id: "33333333-3333-4333-8333-333333333333", riskTier: "R1", status: "reviewed", version: 2 }] },
    { verification: { eligible: true, verificationMode: "live" } },
    { release: { id: "44444444-4444-4444-8444-444444444444", contentHash: hash, sri, url: artifactUrl,
      installation: { artifactUrl, downloadUrl,
        moduleScriptTag: `<script type="module" src="${artifactUrl}" integrity="${sri}" crossorigin="anonymous"></script>`,
        contentHash: hash, integrity: sri, targetOrigin: "https://staging.widgets.dev",
        verificationPageUrl: "https://staging.widgets.dev/webmcp-test", localOnly: false } } },
    { installation: { status: "verified", artifactContentHash: hash, targetOrigin: "https://staging.widgets.dev",
      webMcpImplementation: "native", verifierIdentity: { mode: "live" },
      attestation: { executedContentHash: hash, normalPageLoad: true, routeInterception: false,
        injectedRegistration: false, syntheticHarness: false } } },
  ]);
  const result = await runProductionLiveJourneyCli(
    ["--provider", "openapi", "--live", "--confirm-installed", hash], environment(), dependencies(session, {
      runReadiness: async () => ({
        output: { status: "passed", code: "LIVE_READINESS_PASSED", liveSuccess: true }, exitCode: 0,
      }),
      loadReceiptEvidence: async () => undefined,
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.code, "PRODUCTION_LIVE_RECEIPT_EVIDENCE_REQUIRED");
  assert.equal(result.output.liveSuccess, false);
  assert.equal(result.output.receiptLocation, undefined);
});
