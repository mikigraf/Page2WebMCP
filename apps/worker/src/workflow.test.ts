import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createOpenApiAnalysisAdapter, createWebsiteAnalysisAdapter } from "./workflow.ts";
import { browserUseCloudV4PolicyDigest } from "../../../packages/providers/src/browser-use-v4.ts";
import type { WebsiteObservationInput } from "../../../packages/providers/src/website-evidence.ts";

test("OpenAPI worker adapter binds exact source bytes to generic canonical plans without leaking examples", async () => {
  const secret = "sk-live-never-persist";
  const source = JSON.stringify({ openapi: "3.1.0", info: { title: "Widgets", version: "1" }, paths: { "/widgets/{id}": { get: {
    operationId: "LookupWidget",
    parameters: [{ in: "path", name: "id", required: true, example: secret, schema: { type: "string", maxLength: 32 } }],
    responses: { "200": { description: secret, content: { "application/json": {
      example: { token: secret },
      schema: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 32 } } },
    } } } },
  } } } });
  const adapter = createOpenApiAnalysisAdapter({
    provider: {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async ({ url }) => ({
        status: 200,
        url,
        connectedAddress: "93.184.216.34",
        tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
        headers: { "content-type": "application/json" },
        body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
      }) },
    },
  });
  const result = await adapter({
    sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi", targetOrigin: "https://widgets.example",
      testPageUrl: "https://widgets.example/review/openapi", environment: "test",
    },
  }, new AbortController().signal);
  assert.equal(result.capabilities.length, 1);
  assert.equal(result.capabilities[0]!.plan.targetOrigin, "https://widgets.example");
  assert.ok(result.release);
  assert.equal(result.release.manifest && typeof result.release.manifest === "object", true);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.capabilities[0]!.plan.evidence[0]!.reference, result.evidence[0]!.reference);
  assert.deepEqual(JSON.parse(String(result.evidence[0]!.content)), {
    adapter: "bounded-openapi",
    adapterVersion: 1,
    environment: "test",
    openApiVersion: "3.1.0",
    sourceDigest: `urn:sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review/openapi",
  });
  assert.doesNotMatch(JSON.stringify(result), /sk-live|never-persist/i);
});

test("OpenAPI worker adapter fails closed for other source types and returns exact diagnostics without an invented release", async () => {
  const source = JSON.stringify({ openapi: "3.1.0", info: { title: "Widgets", version: "1" }, paths: { "/admin": { delete: {
    responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
  } } } });
  const adapter = createOpenApiAnalysisAdapter({
    provider: {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async ({ url }) => ({
        status: 200,
        url,
        connectedAddress: "93.184.216.34",
        tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
        headers: { "content-type": "application/json" },
        body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
      }) },
    },
  });
  const configuration = {
    kind: "openapi" as const, targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review/openapi", environment: "test" as const,
  };
  await assert.rejects(() => adapter({ sourceType: "website", sourceUrl: "https://widgets.example", sourceConfiguration: { kind: "website" } }, new AbortController().signal), /SOURCE_TYPE_UNSUPPORTED/);
  const result = await adapter(
    { sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json", sourceConfiguration: configuration },
    new AbortController().signal,
  );
  assert.deepEqual(result.capabilities, []);
  assert.deepEqual(result.diagnostics, [{ code: "UNSUPPORTED_HTTP_METHOD", operationKey: "DELETE /admin" }]);
  assert.equal(result.release, undefined);
  assert.equal(result.evidence.length, 1);

});

test("OpenAPI worker copies distinct per-run verification contexts and rejects legacy context before transport", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0", info: { title: "Widgets", version: "1" },
    paths: { "/widgets": { get: {
      operationId: "listWidgets",
      responses: { "200": { description: "ok", content: { "application/json": {
        schema: { type: "array", items: { type: "string", maxLength: 32 } },
      } } } },
    } } },
  });
  let resolverCalls = 0;
  let releaseFetch!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const adapter = createOpenApiAnalysisAdapter({
    provider: {
      resolver: { resolve: async () => { resolverCalls += 1; await gate; return ["93.184.216.34"]; } },
      transport: { request: async ({ url }) => ({
        status: 200, url, connectedAddress: "93.184.216.34",
        tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
        headers: { "content-type": "application/json" },
        body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
      }) },
    },
  });
  const firstConfiguration = {
    kind: "openapi" as const, targetOrigin: "https://one.example",
    testPageUrl: "https://one.example/review", environment: "staging" as const,
  };
  const first = adapter({
    sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json",
    sourceConfiguration: firstConfiguration,
  }, new AbortController().signal);
  const second = adapter({
    sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi", targetOrigin: "https://two.example",
      testPageUrl: "https://two.example/test", environment: "production",
    },
  }, new AbortController().signal);
  (firstConfiguration as { targetOrigin: string }).targetOrigin = "https://mutated.example";
  releaseFetch();
  const [one, two] = await Promise.all([first, second]);
  assert.deepEqual([one.release?.allowedOrigin, two.release?.allowedOrigin], ["https://one.example", "https://two.example"]);
  assert.deepEqual([one, two].map((result) => {
    const evidence = JSON.parse(result.evidence[0]!.content);
    return [evidence.targetOrigin, evidence.testPageUrl, evidence.environment];
  }), [
    ["https://one.example", "https://one.example/review", "staging"],
    ["https://two.example", "https://two.example/test", "production"],
  ]);

  for (const sourceConfiguration of [
    undefined,
    { kind: "legacy_unconfigured" },
    { kind: "website" },
    { kind: "openapi", targetOrigin: "http://one.example", testPageUrl: "https://one.example/review", environment: "test" },
    { kind: "openapi", targetOrigin: "https://one.example", testPageUrl: "https://other.example/review", environment: "test" },
  ]) {
    await assert.rejects(adapter({
      sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json",
      sourceConfiguration: sourceConfiguration as never,
    }, new AbortController().signal), /^RepositoryError: OPENAPI_VERIFICATION_CONTEXT_REQUIRED$/);
  }
  assert.equal(resolverCalls, 2);
});

const websiteOrigin = "https://widgets.example";
const publicAddress = "93.184.216.34";
const websiteNow = new Date("2026-08-30T12:00:00.000Z");
const ownershipToken = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const ownershipExpiry = "2026-08-30T12:05:00.000Z";
const browserExpiry = "2026-08-30T12:10:00.000Z";

function bytes(value: string): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(value); } };
}

function websiteObservations(): WebsiteObservationInput {
  return {
    navigations: [{ sequence: 1, url: `${websiteOrigin}/catalog`, origin: websiteOrigin }],
    semanticTargets: [],
    network: [{
      logicalAction: "list_widgets", title: "List widgets", description: "List public widgets.",
      method: "GET", pathTemplate: "/api/widgets", status: 200, contentType: "application/json",
      authentication: "public", effect: "read", inputs: [],
      outputs: [{ field: "label", path: "label", maxLength: 200 }],
    }],
    forms: [], dom: [], authSignals: [], blockedMutations: [],
    stateTransitions: [{ sequence: 1, from: "preflight", to: "public_observation" }],
  };
}

function websiteConfiguration(events: string[], observe: (phase: "public" | "authenticated", signal: AbortSignal) => Promise<{ observations: WebsiteObservationInput; requiresAuthentication: boolean }>) {
  const resolver = {
    resolve: async () => [publicAddress],
    resolveTxt: async () => [[`page2webmcp-verification=${ownershipToken};origin=${websiteOrigin};expires=${ownershipExpiry}`]],
  };
  const transport = {
    request: async ({ url }: { url: string }) => ({
      status: 200, url, connectedAddress: publicAddress,
      tls: { authorized: true as const, servername: "widgets.example", protocol: "TLSv1.3" as const },
      headers: { "content-type": "text/html", "content-security-policy": "script-src https://scripts.page2webmcp.example" },
      body: bytes("<!doctype html><title>Widgets</title>"),
    }),
  };
  return {
    clock: () => websiteNow,
    hostedScriptOrigin: "https://scripts.page2webmcp.example",
    provider: { hostedScriptOrigin: "https://scripts.page2webmcp.example", resolver, transport, timeoutMs: 1_000 },
    ownership: {
      attestations: { consume: async (input: {
        organizationId: string; projectId: string; runId: string; sourceIdentityHash: string;
        sourceUrl: string; targetOrigin: string;
      }) => {
        assert.equal(input.targetOrigin, websiteOrigin);
        return {
          bound: true as const,
          challengeDigest: createHash("sha256").update(ownershipToken, "utf8").digest("hex"),
        };
      } },
      challenges: { load: async (input: {
        organizationId: string; projectId: string; runId: string; targetOrigin: string;
      }) => {
        assert.equal(input.targetOrigin, websiteOrigin);
        return { method: "dns_txt" as const, targetOrigin: websiteOrigin, token: ownershipToken, expiresAt: ownershipExpiry };
      } },
      replayStore: { consume: async () => true },
    },
    browser: {
      expiresAt: browserExpiry,
      proxyPolicyReference: { reference: "secretref:deny-proxy", expiresAt: browserExpiry },
      controls: {
        clock: () => websiteNow,
        leases: { claim: async () => ({ leaseId: "lease-worker" }), release: async () => { events.push("release"); } },
        secretReferences: {
          put: async ({ purpose, expiresAt }: { purpose: string; expiresAt: string }) => ({ reference: `secretref:${purpose}`, expiresAt }),
          revoke: async () => undefined,
        },
        transport: {
          start: async (request: Parameters<typeof browserUseCloudV4PolicyDigest>[0]) => ({
            providerSessionId: "provider-worker", liveUrl: "https://live.invalid/secret", cdpUrl: "wss://cdp.invalid/secret",
            appliedPolicyDigest: browserUseCloudV4PolicyDigest(request),
          }),
          stop: async (_id: string, reason: string) => { events.push(`stop:${reason}`); },
          reconcile: async () => { events.push("reconcile"); },
        },
      },
    },
    authentication: {
      store: {
        open: async () => ({ handoffId: "handoff-worker" }),
        wait: async () => ({ authenticatedOrigin: websiteOrigin, observedAt: "2026-08-30T12:01:00.000Z", signals: ["account_control"] }),
        close: async (_id: string, outcome: string) => { events.push(`auth:${outcome}`); },
      },
    },
    explorer: { observe: async ({ phase, firewall, signal }: { phase: "public" | "authenticated"; firewall: ReturnType<typeof import("../../../packages/security/src/security.ts")["createDiscoveryFirewall"]>; signal: AbortSignal }) => {
      assert.deepEqual(firewall.decide({ method: "POST", url: `${websiteOrigin}/api/widgets`, kind: "subresource" }), { allow: false, code: "MUTATION_BLOCKED" });
      return observe(phase, signal);
    } },
    evidenceStore: { put: async ({ reference }: { reference: string }) => ({ reference }) },
  };
}

test("website worker runs hermetic preflight/ownership/browser/evidence proposal and compiles exact plans", async () => {
  const events: string[] = [];
  let attestationInput: unknown;
  let challengeInput: unknown;
  const configuration = websiteConfiguration(events, async () => ({ observations: websiteObservations(), requiresAuthentication: false }));
  const consume = configuration.ownership.attestations.consume;
  configuration.ownership.attestations.consume = async (input) => {
    attestationInput = input;
    return consume(input);
  };
  const challenge = configuration.ownership.challenges.load;
  configuration.ownership.challenges.load = async (input) => {
    challengeInput = input;
    return challenge(input);
  };
  const adapter = createWebsiteAnalysisAdapter(configuration);
  const result = await adapter({
    sourceType: "website", sourceUrl: `${websiteOrigin}/`,
    organizationId: "org-1", projectId: "project-1", id: "run-1",
    sourceConfiguration: { kind: "website" }, sourceIdentityHash: "f".repeat(64),
  }, new AbortController().signal);
  assert.deepEqual(result.capabilities.map(({ plan }) => [plan.tool.name, plan.request.adapter]), [["list_widgets", "json_api"]]);
  assert.ok(result.release);
  assert.equal(result.release?.allowedOrigin, websiteOrigin);
  assert.deepEqual(result.evidence.map(({ source }) => source), ["owner_review", "runtime", "source"]);
  assert.equal(result.evidence[0]!.expiresAt, undefined);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(JSON.stringify(result).includes(ownershipToken), false);
  assert.equal(JSON.stringify(result).includes("live.invalid"), false);
  assert.deepEqual(attestationInput, {
    organizationId: "org-1",
    projectId: "project-1",
    runId: "run-1",
    sourceIdentityHash: "f".repeat(64),
    sourceUrl: `${websiteOrigin}/`,
    targetOrigin: websiteOrigin,
  });
  assert.deepEqual(challengeInput, {
    organizationId: "org-1",
    projectId: "project-1",
    runId: "run-1",
    targetOrigin: websiteOrigin,
  });
  assert.deepEqual(events, ["stop:completed", "reconcile", "release"]);
});

test("website worker fails closed at authentication until a durable human wait phase exists", async () => {
  const events: string[] = [];
  const phases: string[] = [];
  const adapter = createWebsiteAnalysisAdapter(websiteConfiguration(events, async (phase) => {
    phases.push(phase);
    return { observations: { ...websiteObservations(), network: [] }, requiresAuthentication: true };
  }));
  await assert.rejects(adapter({
    sourceType: "website", sourceUrl: `${websiteOrigin}/`,
    organizationId: "org-1", projectId: "project-1", id: "run-auth",
    sourceConfiguration: { kind: "website" }, sourceIdentityHash: "f".repeat(64),
  }, new AbortController().signal), /WEBSITE_DURABLE_AUTHENTICATION_HANDOFF_REQUIRED/);
  assert.deepEqual(phases, ["public"]);
  assert.deepEqual(events, ["stop:failed", "reconcile", "release"]);

  const failedEvents: string[] = [];
  const failed = createWebsiteAnalysisAdapter(websiteConfiguration(failedEvents, async () => { throw new Error("EXPLORER_CRASHED"); }));
  await assert.rejects(failed({
    sourceType: "website", sourceUrl: `${websiteOrigin}/`,
    organizationId: "org-1", projectId: "project-1", id: "run-failed",
    sourceConfiguration: { kind: "website" }, sourceIdentityHash: "f".repeat(64),
  }, new AbortController().signal), /EXPLORER_CRASHED/);
  assert.deepEqual(failedEvents, ["stop:failed", "reconcile", "release"]);
});

test("website worker construction and source ownership fail closed without every external control", async () => {
  assert.throws(() => createWebsiteAnalysisAdapter({} as ReturnType<typeof websiteConfiguration>), /WEBSITE_ANALYSIS_CONTROLS_REQUIRED/);
  const adapter = createWebsiteAnalysisAdapter(websiteConfiguration([], async () => ({ observations: websiteObservations(), requiresAuthentication: false })));
  await assert.rejects(adapter({ sourceType: "openapi", sourceUrl: `${websiteOrigin}/` }, new AbortController().signal), /SOURCE_TYPE_UNSUPPORTED/);
  await assert.rejects(adapter({ sourceType: "website", sourceUrl: `${websiteOrigin}/` }, new AbortController().signal), /WEBSITE_SOURCE_OWNERSHIP_REQUIRED/);
});

test("website worker binds the additive source attestation to the unchanged per-run challenge", async () => {
  const configuration = websiteConfiguration([], async () => ({
    observations: websiteObservations(),
    requiresAuthentication: false,
  }));
  configuration.ownership.attestations.consume = async () => ({
    bound: true,
    challengeDigest: "0".repeat(64),
  });
  const adapter = createWebsiteAnalysisAdapter(configuration);
  await assert.rejects(adapter({
    sourceType: "website",
    sourceUrl: `${websiteOrigin}/`,
    organizationId: "org-1",
    projectId: "project-1",
    id: "run-mismatched-attestation",
    sourceConfiguration: { kind: "website" },
    sourceIdentityHash: "f".repeat(64),
  }, new AbortController().signal), /WEBSITE_SOURCE_ATTESTATION_MISMATCH/);
});

test("website worker locally expires a stalled explorer and still reconciles the browser", async () => {
  const events: string[] = [];
  let observationCompleted = false;
  const configuration = websiteConfiguration(events, async (_phase, signal) => {
    assert.equal(signal.aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    observationCompleted = true;
    return { observations: websiteObservations(), requiresAuthentication: false };
  });
  configuration.browser.expiresAt = "2026-08-30T12:00:00.040Z";
  const adapter = createWebsiteAnalysisAdapter(configuration);
  await assert.rejects(adapter({
    sourceType: "website", sourceUrl: `${websiteOrigin}/`,
    organizationId: "org-1", projectId: "project-1", id: "run-expired-explorer",
    sourceConfiguration: { kind: "website" }, sourceIdentityHash: "f".repeat(64),
  }, new AbortController().signal), /BROWSER_SESSION_EXPIRED/);
  assert.equal(observationCompleted, false);
  assert.deepEqual(events, ["stop:cancelled", "reconcile", "release"]);
});
