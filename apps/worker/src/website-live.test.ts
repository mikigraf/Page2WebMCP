import assert from "node:assert/strict";
import test from "node:test";
import { browserUseCloudV4PolicyDigest, type BrowserUseCloudV4Request } from "../../../packages/providers/src/browser-use-v4.ts";
import type { WebsiteProviderControls } from "../../../packages/providers/src/website.ts";
import {
  createConfiguredWebsiteAnalysisAdapter,
  WEBSITE_LIVE_CONTROL_PATHS,
  WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION,
  websiteMissingControls,
} from "./website-live.ts";

const now = new Date("2026-08-31T12:00:00.000Z");
const publicAddress = "93.184.216.34";
const ownershipToken = "ownership-token-abcdefghijklmnopqrstuvwxyz";

function environment(): Record<string, string> {
  return {
    PAGE2WEBMCP_PROVIDER_MODE: "website",
    PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN: "https://auth-handoff.example",
    PAGE2WEBMCP_AUTH_HANDOFF_TOKEN: "auth_handoff_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN: "https://browser-leases.example",
    PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN: "browser_lease_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_BROWSER_USE_API_KEY: "bu_test_cloud_key_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_BROWSER_USE_API_ORIGIN: "https://browser-gateway.example",
    PAGE2WEBMCP_CDP_OBSERVER_ORIGIN: "https://cdp-observer.example",
    PAGE2WEBMCP_CDP_OBSERVER_TOKEN: "cdp_observer_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_EGRESS_POLICY_ORIGIN: "https://egress-policy.example",
    PAGE2WEBMCP_EGRESS_POLICY_TOKEN: "egress_policy_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_EGRESS_PROXY_ORIGIN: "https://egress-proxy.example",
    PAGE2WEBMCP_EGRESS_PROXY_TOKEN: "egress_proxy_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN: "https://evidence-store.example",
    PAGE2WEBMCP_EVIDENCE_STORE_TOKEN: "evidence_store_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN: "https://ownership-store.example",
    PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN: "ownership_store_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_PUBLIC_ORIGIN: "https://storage.example/storage/v1/object/public/page2webmcp-releases",
    PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID: "kms://page2webmcp/browser-session-secrets",
    PAGE2WEBMCP_SECRET_STORE_ORIGIN: "https://secret-store.example",
    PAGE2WEBMCP_SECRET_STORE_TOKEN: "secret_store_control_token_abcdefghijklmnopqrstuvwxyz",
  };
}

function jsonResponse(url: string, value: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function websiteResponse(url: string, source = "<!doctype html><title>Widgets</title>") {
  return {
    status: 200,
    url,
    connectedAddress: publicAddress,
    tls: { authorized: true, servername: "widgets.example", protocol: "TLSv1.3" },
    headers: { "content-type": "text/html" },
    body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
  } as const;
}

function networkControls(expiresAt: () => string): Pick<WebsiteProviderControls, "resolver" | "transport"> {
  return {
    resolver: {
      resolve: async () => [publicAddress],
      resolveTxt: async () => [[
        `page2webmcp-verification=${ownershipToken};origin=https://widgets.example;expires=${expiresAt()}`,
      ]],
    },
    transport: { request: async (request) => websiteResponse(request.url) },
  };
}

type ControlCall = Readonly<{
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}>;

function controlHarness(input: Readonly<{
  badPolicyDigest?: boolean;
  badGatewayUrl?: boolean;
  badRoutePolicyDigest?: boolean;
  badIssueAttestation?: boolean;
  failApply?: boolean;
}> = {}) {
  const calls: ControlCall[] = [];
  let currentExpiry = new Date(now.getTime() + 9 * 60_000).toISOString();
  const fetcher: typeof fetch = async (rawUrl, init) => {
    const url = String(rawUrl);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, method, headers, body });
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(method, "POST");
    if (url.endsWith("/v1/website-egress-policies/issue")) {
      currentExpiry = String(body.expiresAt);
      return jsonResponse(url, {
        ...body,
        targetOrigin: input.badIssueAttestation ? "https://other.example" : body.targetOrigin,
        reference: `secretref:policy-${String((body.ownership as Record<string, unknown>).runId)}`,
      });
    }
    if (url.endsWith("/v1/website-egress-policies/apply")) {
      if (input.failApply) throw new Error("proxy upstream token=must-not-leak");
      return jsonResponse(url, { ...body, enforced: true });
    }
    if (url.endsWith("/v1/website-egress-policies/revoke")) {
      return jsonResponse(url, { ...body, revoked: true });
    }
    if (url.endsWith("/v1/website-ownership/challenges/load")) {
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        method: "dns_txt", targetOrigin: body.targetOrigin,
        token: ownershipToken, expiresAt: currentExpiry,
      });
    }
    if (url.endsWith("/v1/website-ownership/replays/consume")) {
      return jsonResponse(url, { ...body, consumed: true });
    }
    if (url.endsWith("/v1/browser-leases/claim")) {
      return jsonResponse(url, { ...body, leaseId: `lease-${String(body.runId)}` });
    }
    if (url.endsWith("/v1/browser-leases/release")) {
      return jsonResponse(url, { ...body, released: true });
    }
    if (url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserStart)) {
      assert.equal(headers.get("x-page2webmcp-browser-gateway-version"), String(WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION));
      assert.equal(headers.get("x-browser-use-api-key"), environment().PAGE2WEBMCP_BROWSER_USE_API_KEY);
      assert.equal(headers.has("authorization"), false);
      const request = body.request as BrowserUseCloudV4Request;
      return jsonResponse(url, {
        gatewayProtocolVersion: 1,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        apiVersion: "v4",
        model: "browser-use-2.0",
        providerSessionId: "provider-session-1",
        liveUrl: input.badGatewayUrl ? "not-an-https-url" : "https://browser-live.example/session/1",
        cdpUrl: "wss://browser-cdp.example/session/1",
        appliedPolicyDigest: input.badPolicyDigest ? "0".repeat(64) : browserUseCloudV4PolicyDigest(request),
      });
    }
    if (url.endsWith("/v1/browser-use-v4/sessions/stop")) {
      return jsonResponse(url, { ...body, stopped: true });
    }
    if (url.endsWith("/v1/browser-use-v4/sessions/reconcile")) {
      return jsonResponse(url, { ...body, reconciled: true });
    }
    if (url.endsWith("/v1/ttl-secrets/put")) {
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        purpose: body.purpose, expiresAt: body.expiresAt,
        kmsKeyId: body.kmsKeyId, reference: `secretref:${String(body.purpose)}-1`,
      });
    }
    if (url.endsWith("/v1/ttl-secrets/revoke")) {
      return jsonResponse(url, { ...body, revoked: true });
    }
    if (url.endsWith("/v1/website-observations/observe")) {
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        phase: body.phase, targetOrigin: body.targetOrigin, cdpReference: body.cdpReference,
        routePolicyDigest: input.badRoutePolicyDigest ? "0".repeat(64) : body.routePolicyDigest,
        enforced: true,
        requiresAuthentication: false,
        observations: {
          navigations: [], semanticTargets: [], network: [], forms: [], dom: [],
          authSignals: [], blockedMutations: [], stateTransitions: [],
        },
      });
    }
    if (url.endsWith("/v1/website-evidence/put")) {
      const record = body.record as Record<string, unknown>;
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        reference: record.reference,
        organizationId: record.organizationId,
        projectId: record.projectId,
        analysisRunId: record.analysisRunId,
      });
    }
    throw new Error(`UNEXPECTED_CONTROL_REQUEST:${url}`);
  };
  return { calls, fetch: fetcher, expiresAt: () => currentExpiry };
}

test("website control inventory is exact, sorted, validates values, and never returns secrets", () => {
  const allMissing = websiteMissingControls({ PAGE2WEBMCP_PROVIDER_MODE: "website" });
  assert.equal(allMissing.length, 20);
  assert.deepEqual(allMissing, [...allMissing].sort());
  assert.deepEqual(websiteMissingControls(environment()), []);
  const malformed = environment();
  malformed.PAGE2WEBMCP_AUTH_HANDOFF_TOKEN = "actual-secret-value";
  malformed.PAGE2WEBMCP_BROWSER_USE_API_ORIGIN = "https://browser-gateway.example/path";
  malformed.PAGE2WEBMCP_PUBLIC_ORIGIN = "https://storage.example";
  assert.deepEqual(websiteMissingControls(malformed), [
    "PAGE2WEBMCP_AUTH_HANDOFF_TOKEN",
    "PAGE2WEBMCP_BROWSER_USE_API_ORIGIN",
    "PAGE2WEBMCP_PUBLIC_ORIGIN",
  ]);
  assert.doesNotMatch(JSON.stringify(websiteMissingControls(malformed)), /actual-secret-value/);
  assert.deepEqual(websiteMissingControls({
    ...environment(),
    PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN: "https://127.0.0.1",
    PAGE2WEBMCP_PUBLIC_ORIGIN: "https://storage.example/storage/v1/object/public/other-bucket",
  }), ["PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN", "PAGE2WEBMCP_PUBLIC_ORIGIN"]);
  assert.deepEqual(websiteMissingControls({
    ...environment(),
    PAGE2WEBMCP_PUBLIC_ORIGIN: "https://127.0.0.1/storage/v1/object/public/page2webmcp-releases",
  }), ["PAGE2WEBMCP_PUBLIC_ORIGIN"]);
});

test("website adapter rejects noncanonical source configuration before issuing a policy", async () => {
  const harness = controlHarness();
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: harness.fetch, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-wrong-config", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app",
    sourceConfiguration: { kind: "website", extra: true } as unknown as { kind: "website" },
  }, new AbortController().signal), /^Error: WEBSITE_SOURCE_CONFIGURATION_REQUIRED$/);
  assert.equal(harness.calls.length, 0);
});

test("configured website adapter issues fresh target-bound policies and sends the exact v4 browser request", async () => {
  const harness = controlHarness();
  let clock = new Date(now);
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: harness.fetch,
    clock: () => clock,
    ...networkControls(harness.expiresAt),
  });
  for (const runId of ["analysis-run-1", "analysis-run-2"]) {
    await adapter({
      id: runId,
      organizationId: "organization-1",
      projectId: "project-1",
      sourceType: "website",
      sourceUrl: "https://widgets.example/app",
      sourceConfiguration: { kind: "website" },
    }, new AbortController().signal);
    clock = new Date(clock.getTime() + 60_000);
  }
  const issueCalls = harness.calls.filter(({ url }) => url.endsWith("/v1/website-egress-policies/issue"));
  assert.equal(issueCalls.length, 2);
  assert.notEqual(issueCalls[0]!.body.expiresAt, issueCalls[1]!.body.expiresAt);
  for (const [index, call] of issueCalls.entries()) {
    assert.deepEqual(call.body, {
      gatewayProtocolVersion: 1,
      idempotencyKey: `website:analysis-run-${index + 1}:policy-issue`,
      ownership: {
        organizationId: "organization-1",
        projectId: "project-1",
        runId: `analysis-run-${index + 1}`,
      },
      denyByDefault: true,
      expiresAt: new Date(now.getTime() + (index + 9) * 60_000).toISOString(),
      routes: [{ methods: ["GET", "HEAD"], origin: "https://widgets.example", pathPrefix: "/" }],
      targetOrigin: "https://widgets.example",
    });
  }
  const starts = harness.calls.filter(({ url }) => url.endsWith("/v1/browser-use-v4/sessions/start"));
  assert.equal(starts.length, 2);
  for (const start of starts) {
    const ownership = { organizationId: "organization-1", projectId: "project-1", runId: start.body.idempotencyKey === "website:analysis-run-1:browser-start" ? "analysis-run-1" : "analysis-run-2" };
    assert.deepEqual(start.body, {
      gatewayProtocolVersion: 1,
      idempotencyKey: `website:${ownership.runId}:browser-start`,
      ownership,
      request: {
      apiVersion: "v4",
      model: "browser-use-2.0",
      allowedDomains: ["widgets.example"],
      allowedOrigins: ["https://widgets.example"],
      proxy: {
        denyByDefault: true,
        policyReference: (start.body.request as Record<string, unknown>).proxy
          && ((start.body.request as Record<string, unknown>).proxy as Record<string, unknown>).policyReference,
      },
      session: {
        ephemeral: true, keepAlive: true, recording: false,
        profile: null, workspace: null, persistMemory: false,
      },
      features: { downloads: false, uploads: false, skills: false, agentmail: false },
      expiresAt: (start.body.request as Record<string, unknown>).expiresAt,
      },
    });
  }
  const cdpCalls = harness.calls.filter(({ url }) => url.endsWith("/v1/website-observations/observe"));
  assert.equal(cdpCalls.length, 2);
  for (const call of cdpCalls) {
    assert.deepEqual(call.body.routePolicy, {
      denyByDefault: true,
      routes: [{ methods: ["GET", "HEAD"], origin: "https://widgets.example", pathPrefix: "/" }],
    });
    assert.match(String(call.body.routePolicyDigest), /^[a-f0-9]{64}$/);
    assert.match(String(call.body.cdpReference), /^secretref:/);
    assert.doesNotMatch(JSON.stringify(call.body), /wss:\/\//);
  }
  const serializedBodies = JSON.stringify(harness.calls.map(({ body }) => body));
  for (const [name, value] of Object.entries(environment())) {
    if (name.endsWith("_TOKEN") || name.endsWith("_API_KEY")) assert.doesNotMatch(serializedBodies, new RegExp(value));
  }
  assert.equal(harness.calls.filter(({ url }) => url.endsWith("/v1/website-egress-policies/revoke")).length, 4);
});

test("website gateway policy drift fails closed and still stops, reconciles, releases, and revokes", async () => {
  const harness = controlHarness({ badPolicyDigest: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: harness.fetch,
    clock: () => now,
    ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-bad-attestation",
    organizationId: "organization-1",
    projectId: "project-1",
    sourceType: "website",
    sourceUrl: "https://widgets.example/app",
    sourceConfiguration: { kind: "website" },
  }, new AbortController().signal), /^Error: BROWSER_PROVIDER_CONTROL_ATTESTATION_FAILED$/);
  for (const endpoint of [
    "/v1/browser-use-v4/sessions/stop",
    "/v1/browser-use-v4/sessions/reconcile",
    "/v1/browser-leases/release",
  ]) assert.equal(harness.calls.filter(({ url }) => url.endsWith(endpoint)).length, 1);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith("/v1/website-egress-policies/revoke")).length, 2);
});

test("website cleans an issued policy when proxy apply fails without exposing upstream values", async () => {
  const harness = controlHarness({ failApply: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: harness.fetch, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-apply-failure", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" },
  }, new AbortController().signal), /^Error: WEBSITE_CONTROL_REQUEST_FAILED$/);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith("/v1/website-egress-policies/revoke")).length, 2);
});

test("website cleans a valid issued reference when the issue attestation is malformed", async () => {
  const harness = controlHarness({ badIssueAttestation: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: harness.fetch, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-issue-drift", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" },
  }, new AbortController().signal), /^Error: WEBSITE_EGRESS_POLICY_ATTESTATION_FAILED$/);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.policyRevoke)).length, 2);
});

test("website gateway cleans a created session when a later gateway field is malformed", async () => {
  const harness = controlHarness({ badGatewayUrl: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: harness.fetch, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-malformed-gateway", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" },
  }, new AbortController().signal), /^Error: BROWSER_PROVIDER_RESPONSE_INVALID$/);
  for (const endpoint of [WEBSITE_LIVE_CONTROL_PATHS.browserStop, WEBSITE_LIVE_CONTROL_PATHS.browserReconcile]) {
    assert.equal(harness.calls.filter(({ url }) => url.endsWith(endpoint)).length, 1);
  }
  const stopIndex = harness.calls.findIndex(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserStop));
  const reconcileIndex = harness.calls.findIndex(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserReconcile));
  assert.ok(stopIndex >= 0 && reconcileIndex > stopIndex);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.leaseRelease)).length, 1);
});

test("website rejects a CDP observer that does not attest the enforced route policy", async () => {
  const harness = controlHarness({ badRoutePolicyDigest: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: harness.fetch, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-observer-drift", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" },
  }, new AbortController().signal), /^Error: WEBSITE_CONTROL_RESPONSE_INVALID$/);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.evidencePut)).length, 0);
});
