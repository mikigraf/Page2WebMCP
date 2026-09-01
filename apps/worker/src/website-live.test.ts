import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { browserUseCloudV4PolicyDigest, type BrowserUseCloudV4Request } from "../../../packages/providers/src/browser-use-v4.ts";
import type { WebsiteProviderControls } from "../../../packages/providers/src/website.ts";
import type { NodePinnedJsonTransport } from "./node-network.ts";
import {
  createConfiguredWebsiteAnalysisAdapter,
  probeConfiguredWebsiteControlStartup,
  probeConfiguredWebsiteControls,
  WEBSITE_LIVE_CONTROL_PATHS,
  WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION,
  WEBSITE_LIVE_READINESS_PATH,
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
    PAGE2WEBMCP_PUBLIC_ORIGIN: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
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
  requiresAuthentication?: boolean;
  badAuthAttestation?: boolean;
  badSecretDigest?: boolean;
  issueStatus?: number;
  ambiguousBrowserStartOnce?: boolean;
  rejectedReadinessControl?: string;
  legacyReadinessControl?: "ownership-store";
}> = {}) {
  const calls: ControlCall[] = [];
  let currentExpiry = new Date(now.getTime() + 9 * 60_000).toISOString();
  const issuedPolicies = new Map<string, { active: boolean; expiresAt: string; reference: string }>();
  const issuedLeases = new Map<string, string>();
  const issuedBrowserSessions = new Map<string, string>();
  const activeLeaseByRun = new Map<string, string>();
  let browserStartAttempts = 0;
  let observationCount = 0;
  const fetcher: typeof fetch = async (rawUrl, init) => {
    const url = String(rawUrl);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url, method, headers, body });
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    if (url.endsWith(WEBSITE_LIVE_READINESS_PATH)) {
      assert.equal(method, "GET");
      assert.equal(init?.body, undefined);
      const control = headers.get("x-page2webmcp-control");
      if (control === input.rejectedReadinessControl) return jsonResponse(url, { rejected: true }, 401);
      return jsonResponse(url, {
        gatewayProtocolVersion: WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION,
        status: "ready",
        readOnly: true,
        control,
        selectedReleaseHash: headers.get("x-page2webmcp-release-hash"),
        nonce: headers.get("x-page2webmcp-readiness-nonce"),
        ...(control === "ttl-secret-store"
          ? { kmsKeyIdDigest: headers.get("x-page2webmcp-kms-key-id-digest") }
          : {}),
        ...(control === "ownership-store" && input.legacyReadinessControl !== control
          ? { sourceAttestationProtocolVersion: 1 }
          : {}),
        ...(control === "browser-use-v4"
          ? {
            gateway: "page2webmcp-browser-use-v4",
            upstream: { apiVersion: "v4", authenticated: true, model: "browser-use-2.0" },
          }
          : {}),
      });
    }
    assert.equal(method, "POST");
    if (url.endsWith("/v1/website-egress-policies/issue")) {
      if (input.issueStatus !== undefined) return jsonResponse(url, { rejected: true }, input.issueStatus);
      const idempotencyKey = String(body.idempotencyKey);
      const issued = issuedPolicies.get(idempotencyKey) ?? {
        active: true,
        expiresAt: new Date(now.getTime() + 9 * 60_000).toISOString(),
        reference: `secretref:policy-${String((body.ownership as Record<string, unknown>).runId)}-${issuedPolicies.size + 1}`,
      };
      issuedPolicies.set(idempotencyKey, issued);
      currentExpiry = issued.expiresAt;
      return jsonResponse(url, {
        ...body,
        targetOrigin: input.badIssueAttestation ? "https://other.example" : body.targetOrigin,
        expiresAt: issued.expiresAt,
        reference: issued.reference,
      });
    }
    if (url.endsWith("/v1/website-egress-policies/apply")) {
      if (input.failApply) throw new Error("proxy upstream token=must-not-leak");
      const issued = [...issuedPolicies.values()].find(({ reference }) => reference === body.reference);
      if (!issued?.active) return jsonResponse(url, { rejected: true }, 409);
      return jsonResponse(url, { ...body, enforced: true });
    }
    if (url.endsWith("/v1/website-egress-policies/revoke")) {
      const issued = [...issuedPolicies.values()].find(({ reference }) => reference === body.reference);
      if (issued) issued.active = false;
      return jsonResponse(url, { ...body, revoked: true });
    }
    if (url.endsWith("/v1/website-ownership/source-attestations/consume")) {
      return jsonResponse(url, {
        ...body,
        bound: true,
        challengeDigest: createHash("sha256").update(ownershipToken, "utf8").digest("hex"),
      });
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
      const key = String(body.idempotencyKey);
      const runId = String((body.ownership as Record<string, unknown>).runId);
      if (activeLeaseByRun.has(runId) && !issuedLeases.has(key)) {
        return jsonResponse(url, { rejected: true }, 409);
      }
      const leaseId = issuedLeases.get(key) ?? `lease-${String(body.runId)}-${issuedLeases.size + 1}`;
      issuedLeases.set(key, leaseId);
      activeLeaseByRun.set(runId, leaseId);
      return jsonResponse(url, { ...body, leaseId });
    }
    if (url.endsWith("/v1/browser-leases/release")) {
      for (const [runId, leaseId] of activeLeaseByRun) {
        if (leaseId === body.leaseId) activeLeaseByRun.delete(runId);
      }
      return jsonResponse(url, { ...body, released: true });
    }
    if (url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserStart)) {
      browserStartAttempts += 1;
      if (input.ambiguousBrowserStartOnce && browserStartAttempts === 1) {
        throw new Error("browser gateway response lost");
      }
      assert.equal(headers.get("x-page2webmcp-browser-gateway-version"), String(WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION));
      assert.equal(headers.get("x-browser-use-api-key"), environment().PAGE2WEBMCP_BROWSER_USE_API_KEY);
      assert.equal(headers.has("authorization"), false);
      const request = body.request as BrowserUseCloudV4Request;
      const key = String(body.idempotencyKey);
      const providerSessionId = issuedBrowserSessions.get(key) ?? `provider-session-${issuedBrowserSessions.size + 1}`;
      issuedBrowserSessions.set(key, providerSessionId);
      return jsonResponse(url, {
        gatewayProtocolVersion: 1,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        apiVersion: "v4",
        model: "browser-use-2.0",
        providerSessionId,
        liveUrl: input.badGatewayUrl ? "not-an-https-url" : "https://browser-live.example/session/1",
        cdpUrl: "wss://browser-cdp.example/session/1",
        appliedPolicyDigest: input.badPolicyDigest ? "0".repeat(64) : browserUseCloudV4PolicyDigest(request),
      });
    }
    if (url.endsWith("/v1/browser-use-v4/sessions/stop")) {
      return jsonResponse(url, { ...body, stopped: true });
    }
    if (url.endsWith("/v1/browser-use-v4/sessions/reconcile")) {
      return jsonResponse(url, { ...body, reconciled: true, terminated: true });
    }
    if (url.endsWith("/v1/ttl-secrets/put")) {
      const valueDigest = createHash("sha256").update(String(body.value), "utf8").digest("hex");
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        purpose: body.purpose, expiresAt: body.expiresAt,
        kmsKeyId: body.kmsKeyId, valueDigest: input.badSecretDigest ? "0".repeat(64) : valueDigest,
        reference: `secretref:${String(body.purpose)}-1`,
      });
    }
    if (url.endsWith("/v1/ttl-secrets/revoke")) {
      return jsonResponse(url, { ...body, revoked: true });
    }
    if (url.endsWith("/v1/website-observations/observe")) {
      observationCount += 1;
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        phase: body.phase, targetOrigin: body.targetOrigin, cdpReference: body.cdpReference,
        routePolicyDigest: input.badRoutePolicyDigest ? "0".repeat(64) : body.routePolicyDigest,
        enforced: true,
        requiresAuthentication: input.requiresAuthentication === true && observationCount === 1,
        observations: {
          navigations: [], semanticTargets: [], network: [], forms: [], dom: [],
          authSignals: [], blockedMutations: [], stateTransitions: [],
        },
      });
    }
    if (url.endsWith("/v1/auth-handoffs/open")) {
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        handoffId: "handoff-1",
        targetOrigin: input.badAuthAttestation ? "https://other.example" : body.targetOrigin,
        liveReference: body.liveReference,
        expiresAt: body.expiresAt,
      });
    }
    if (url.endsWith("/v1/auth-handoffs/wait")) {
      return jsonResponse(url, {
        gatewayProtocolVersion: body.gatewayProtocolVersion,
        idempotencyKey: body.idempotencyKey,
        ownership: body.ownership,
        handoffId: body.handoffId,
        completion: {
          authenticatedOrigin: "https://widgets.example",
          observedAt: "2026-08-31T12:01:00.000Z",
          signals: ["account_control"],
        },
      });
    }
    if (url.endsWith("/v1/auth-handoffs/close")) {
      return jsonResponse(url, { ...body, closed: true });
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
  const transport: NodePinnedJsonTransport = {
    request: async ({ url, method, headers, body, signal }) => {
      const response = await fetcher(url, { method, headers, body, signal, redirect: "error" });
      return {
        status: response.status,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
  return {
    calls, fetch: fetcher, transport, expiresAt: () => currentExpiry,
    policyReferences: () => [...issuedPolicies.values()].map(({ reference }) => reference),
    leaseIds: () => [...issuedLeases.values()],
    providerSessionIds: () => [...issuedBrowserSessions.values()],
  };
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
  assert.deepEqual(websiteMissingControls({
    ...environment(),
    PAGE2WEBMCP_PUBLIC_ORIGIN: "https://another-project.supabase.co/storage/v1/object/public/page2webmcp-releases",
  }), ["PAGE2WEBMCP_PUBLIC_ORIGIN"]);
  assert.deepEqual(websiteMissingControls({
    ...environment(),
    PAGE2WEBMCP_LOCAL_STACK: "true",
    PAGE2WEBMCP_PUBLIC_ORIGIN: "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases",
  }), []);
  assert.deepEqual(websiteMissingControls({
    ...environment(),
    PAGE2WEBMCP_PUBLIC_ORIGIN: "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases",
  }), ["PAGE2WEBMCP_PUBLIC_ORIGIN"]);
});

test("website readiness freshly checks every authenticated control without creating a browser session or policy", async () => {
  const harness = controlHarness();
  const network = networkControls(harness.expiresAt);
  let targetRequestUrl: string | undefined;
  await probeConfiguredWebsiteControls(environment(), {
    controlTransport: harness.transport,
    resolver: network.resolver,
    transport: { request: async (request) => {
      targetRequestUrl = request.url;
      return network.transport.request(request);
    } },
  }, {
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: environment().PAGE2WEBMCP_PUBLIC_ORIGIN,
    context: {
      sourceType: "website", sourceUrl: "https://widgets.example/app",
      sourceIdentityHash: "b".repeat(64), sourceConfiguration: { kind: "website" },
    },
    signal: new AbortController().signal,
  });
  const probes = harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_READINESS_PATH));
  assert.equal(targetRequestUrl, "https://widgets.example/app");
  assert.deepEqual(probes.map(({ headers }) => headers.get("x-page2webmcp-control")).sort(), [
    "authentication-handoff",
    "browser-lease-store",
    "browser-use-v4",
    "cdp-observer",
    "egress-policy-store",
    "egress-proxy",
    "evidence-store",
    "ownership-store",
    "ttl-secret-store",
  ]);
  assert.equal(probes.length, 9);
  assert.ok(probes.every(({ method, body }) => method === "GET" && Object.keys(body).length === 0));
  assert.ok(probes.every(({ headers }) => headers.get("x-page2webmcp-release-hash") === "a".repeat(64)));
  assert.ok(probes.every(({ headers }) => /^[a-f0-9]{64}$/.test(headers.get("x-page2webmcp-readiness-nonce") ?? "")));
  assert.equal(harness.calls.some(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.policyIssue)), false);
  assert.equal(harness.calls.some(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserStart)), false);
});

test("website readiness rejects one revoked control with a stable non-secret error", async () => {
  const harness = controlHarness({ rejectedReadinessControl: "evidence-store" });
  await assert.rejects(probeConfiguredWebsiteControls(environment(), {
    controlTransport: harness.transport, ...networkControls(harness.expiresAt),
  }, {
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: environment().PAGE2WEBMCP_PUBLIC_ORIGIN,
    context: {
      sourceType: "website", sourceUrl: "https://widgets.example/app",
      sourceIdentityHash: "b".repeat(64), sourceConfiguration: { kind: "website" },
    },
    signal: new AbortController().signal,
  }), /^Error: WEBSITE_PROVIDER_PROBE_FAILED$/);
});

test("website startup rejects an ownership store without the additive source-attestation protocol", async () => {
  const harness = controlHarness({ legacyReadinessControl: "ownership-store" });
  await assert.rejects(probeConfiguredWebsiteControlStartup(environment(), {
    controlTransport: harness.transport,
  }, new AbortController().signal), /^Error: WEBSITE_HANDOFF_PROTOCOL_UNSUPPORTED$/);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_READINESS_PATH)).length, 9);
  assert.equal(harness.calls.some(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.policyIssue)), false);
  assert.equal(harness.calls.some(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserStart)), false);
});

test("website readiness aborts and settles all target/control siblings after the first failure", async () => {
  let abortedSiblings = 0;
  const waitForAbort = async (signal: AbortSignal): Promise<never> => await new Promise((_resolve, reject) => {
    const abort = () => { abortedSiblings += 1; reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const controlTransport: NodePinnedJsonTransport = {
    request: async ({ url, headers, signal }) => {
      if (headers["x-page2webmcp-control"] === "evidence-store") {
        return { status: 401, url, headers: { "content-type": "application/json" }, body: new Uint8Array() };
      }
      return await waitForAbort(signal);
    },
  };
  const probe = probeConfiguredWebsiteControls(environment(), {
    controlTransport,
    resolver: { resolve: async () => [publicAddress], resolveTxt: async () => [] },
    transport: { request: async ({ signal }) => await waitForAbort(signal) },
  }, {
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: environment().PAGE2WEBMCP_PUBLIC_ORIGIN,
    context: {
      sourceType: "website", sourceUrl: "https://widgets.example/app",
      sourceIdentityHash: "b".repeat(64), sourceConfiguration: { kind: "website" },
    },
    signal: new AbortController().signal,
  });
  await assert.rejects(Promise.race([
    probe,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TEST_TIMEOUT")), 500)),
  ]), /^Error: WEBSITE_PROVIDER_PROBE_FAILED$/);
  assert.equal(abortedSiblings, 9);
});

test("website adapter rejects noncanonical source configuration before issuing a policy", async () => {
  const harness = controlHarness();
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-wrong-config", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app",
    leaseGeneration: 1,
    sourceConfiguration: { kind: "website", extra: true } as unknown as { kind: "website" },
  }, new AbortController().signal), /^Error: WEBSITE_SOURCE_CONFIGURATION_REQUIRED$/);
  assert.equal(harness.calls.length, 0);
});

test("configured website adapter issues fresh target-bound policies and sends the exact v4 browser request", async () => {
  const harness = controlHarness();
  let clock = new Date(now);
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport,
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
      leaseGeneration: 1,
      sourceConfiguration: { kind: "website" },
    }, new AbortController().signal);
    clock = new Date(clock.getTime() + 60_000);
  }
  const issueCalls = harness.calls.filter(({ url }) => url.endsWith("/v1/website-egress-policies/issue"));
  assert.equal(issueCalls.length, 2);
  for (const [index, call] of issueCalls.entries()) {
    assert.deepEqual(call.body, {
      gatewayProtocolVersion: 1,
      idempotencyKey: call.body.idempotencyKey,
      ownership: {
        organizationId: "organization-1",
        projectId: "project-1",
        runId: `analysis-run-${index + 1}`,
      },
      denyByDefault: true,
      ttlSeconds: 540,
      routes: [{ methods: ["GET", "HEAD"], origin: "https://widgets.example", pathPrefix: "/" }],
      targetOrigin: "https://widgets.example",
    });
    assert.match(String(call.body.idempotencyKey), new RegExp(`^website:analysis-run-${index + 1}:1:policy-issue:[a-f0-9]{64}$`));
  }
  const starts = harness.calls.filter(({ url }) => url.endsWith("/v1/browser-use-v4/sessions/start"));
  assert.equal(starts.length, 2);
  for (const start of starts) {
    const runId = String(start.body.idempotencyKey).startsWith("website:analysis-run-1:1:") ? "analysis-run-1" : "analysis-run-2";
    const ownership = { organizationId: "organization-1", projectId: "project-1", runId };
    assert.deepEqual(start.body, {
      gatewayProtocolVersion: 1,
      idempotencyKey: start.body.idempotencyKey,
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
    assert.match(String(start.body.idempotencyKey), new RegExp(`^website:${ownership.runId}:1:browser-start:[a-f0-9]{64}$`));
  }
  const sourceAttestations = harness.calls.filter(({ url }) =>
    url.endsWith("/v1/website-ownership/source-attestations/consume"));
  assert.equal(sourceAttestations.length, 2);
  for (const [index, call] of sourceAttestations.entries()) {
    assert.deepEqual(call.body.ownership, {
      organizationId: "organization-1",
      projectId: "project-1",
      runId: `analysis-run-${index + 1}`,
    });
    assert.match(String(call.body.sourceIdentityHash), /^[0-9a-f]{64}$/);
    assert.equal(call.body.sourceUrl, "https://widgets.example/app");
    assert.equal(call.body.targetOrigin, "https://widgets.example");
  }
  const legacyChallenges = harness.calls.filter(({ url }) =>
    url.endsWith("/v1/website-ownership/challenges/load"));
  assert.equal(legacyChallenges.length, 2);
  for (const call of legacyChallenges) {
    assert.deepEqual(Object.keys(call.body).sort(), [
      "gatewayProtocolVersion", "idempotencyKey", "organizationId", "ownership",
      "projectId", "runId", "targetOrigin",
    ]);
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

test("website delivery generation rotates cleaned resources without changing same-delivery requests", async () => {
  const harness = controlHarness();
  let clock = new Date(now);
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport, clock: () => clock, ...networkControls(harness.expiresAt),
  });
  const source = {
    id: "analysis-run-retry", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website" as const, sourceUrl: "https://widgets.example/app",
    sourceConfiguration: { kind: "website" as const }, leaseGeneration: 1,
  };
  await adapter(source, new AbortController().signal);
  clock = new Date(clock.getTime() + 30_000);
  await assert.rejects(adapter(source, new AbortController().signal), /^Error: WEBSITE_CONTROL_REJECTED$/);
  clock = new Date(clock.getTime() + 30_000);
  await adapter({ ...source, leaseGeneration: 2 }, new AbortController().signal);
  const byKey = new Map<string, string>();
  for (const { body } of harness.calls) {
    const key = String(body.idempotencyKey);
    const serialized = JSON.stringify(body);
    if (byKey.has(key)) assert.equal(serialized, byKey.get(key));
    else byKey.set(key, serialized);
  }
  const issues = harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.policyIssue));
  assert.equal(issues.length, 3);
  assert.deepEqual(issues[0]!.body, issues[1]!.body);
  assert.notEqual(issues[2]!.body.idempotencyKey, issues[0]!.body.idempotencyKey);
  assert.equal(String(issues[2]!.body.idempotencyKey).split(":").at(-1),
    String(issues[0]!.body.idempotencyKey).split(":").at(-1));
  assert.equal(issues[0]!.body.ttlSeconds, 540);
  assert.equal("expiresAt" in issues[0]!.body, false);
  assert.deepEqual(harness.policyReferences(), [
    "secretref:policy-analysis-run-retry-1",
    "secretref:policy-analysis-run-retry-2",
  ]);
  assert.deepEqual(harness.leaseIds(), [
    "lease-analysis-run-retry-1",
    "lease-analysis-run-retry-2",
  ]);
  assert.deepEqual(harness.providerSessionIds(), ["provider-session-1", "provider-session-2"]);
});

test("website live input requires a positive claimed delivery generation before controls", async () => {
  for (const leaseGeneration of [undefined, 0, -1, 1.5]) {
    const harness = controlHarness();
    const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
      controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
    });
    await assert.rejects(adapter({
      id: "analysis-run-generation", organizationId: "organization-1", projectId: "project-1",
      sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" },
      ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
    }, new AbortController().signal), /^Error: WEBSITE_SOURCE_DELIVERY_REQUIRED$/);
    assert.equal(harness.calls.length, 0);
  }
});

test("a new website delivery cannot bypass an ambiguous prior delivery lease", async () => {
  const harness = controlHarness({ ambiguousBrowserStartOnce: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
  });
  const source = {
    id: "analysis-run-ambiguous-delivery", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website" as const, sourceUrl: "https://widgets.example/app",
    sourceConfiguration: { kind: "website" as const }, leaseGeneration: 1,
  };
  await assert.rejects(adapter(source, new AbortController().signal), /^Error: WEBSITE_CONTROL_RETRYABLE$/);
  await assert.rejects(adapter({ ...source, leaseGeneration: 2 }, new AbortController().signal),
    /^Error: WEBSITE_CONTROL_REJECTED$/);
  const claims = harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.leaseClaim));
  assert.equal(claims.length, 2);
  assert.notEqual(claims[0]!.body.idempotencyKey, claims[1]!.body.idempotencyKey);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.leaseRelease)).length, 0);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserStart)).length, 1);
});

test("website control aborts redact arbitrary caller reasons", async () => {
  const secret = "Bearer should-never-escape";
  const controller = new AbortController();
  controller.abort(new Error(secret));
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: { request: async ({ signal }) => { throw signal.reason; } },
    clock: () => now,
    ...networkControls(() => new Date(now.getTime() + 9 * 60_000).toISOString()),
  });
  const error = await adapter({
    id: "analysis-run-abort", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, controller.signal).catch((reason: unknown) => reason);
  assert.equal(error instanceof Error && error.message, "WEBSITE_CONTROL_ABORTED");
  assert.doesNotMatch(String(error), /should-never-escape/);
});

test("website default controls never fall back to the injected loose fetch function", async () => {
  let looseFetchCalls = 0;
  const controller = new AbortController();
  controller.abort(new Error("Bearer loose-fetch-secret"));
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    fetch: async () => { looseFetchCalls += 1; throw new Error("LOOSE_FETCH_USED"); },
    clock: () => now,
    ...networkControls(() => new Date(now.getTime() + 9 * 60_000).toISOString()),
  });
  await assert.rejects(adapter({
    id: "analysis-run-default-transport", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, controller.signal), /^Error: WEBSITE_CONTROL_ABORTED$/);
  assert.equal(looseFetchCalls, 0);
});

test("website TTL secrets stay exact and authenticated sites fail before opening a non-durable handoff", async () => {
  const harness = controlHarness({ requiresAuthentication: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-auth", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, new AbortController().signal), /^Error: WEBSITE_DURABLE_AUTHENTICATION_HANDOFF_REQUIRED$/);
  for (const call of harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.secretPut))) {
    assert.equal(call.body.valueDigest, createHash("sha256").update(String(call.body.value), "utf8").digest("hex"));
  }
  const open = harness.calls.find(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.authOpen));
  assert.equal(open, undefined);

  const malformedSecret = controlHarness({ badSecretDigest: true });
  const malformedSecretAdapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: malformedSecret.transport, clock: () => now, ...networkControls(malformedSecret.expiresAt),
  });
  await assert.rejects(malformedSecretAdapter({
    id: "analysis-run-secret-drift", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, new AbortController().signal), /^Error: WEBSITE_CONTROL_RESPONSE_INVALID$/);
});

test("website control status classification retries only 429 and 5xx", async () => {
  for (const [status, code] of [[429, "WEBSITE_CONTROL_RETRYABLE"], [503, "WEBSITE_CONTROL_RETRYABLE"], [401, "WEBSITE_CONTROL_REJECTED"], [422, "WEBSITE_CONTROL_REJECTED"]] as const) {
    const harness = controlHarness({ issueStatus: status });
    const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
      controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
    });
    await assert.rejects(adapter({
      id: `analysis-run-status-${status}`, organizationId: "organization-1", projectId: "project-1",
      sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
    }, new AbortController().signal), new RegExp(`^Error: ${code}$`));
  }
});

test("website gateway policy drift fails closed and still stops, reconciles, releases, and revokes", async () => {
  const harness = controlHarness({ badPolicyDigest: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport,
    clock: () => now,
    ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-bad-attestation",
    organizationId: "organization-1",
    projectId: "project-1",
    sourceType: "website",
    sourceUrl: "https://widgets.example/app",
    leaseGeneration: 1,
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
    controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-apply-failure", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, new AbortController().signal), /^Error: WEBSITE_CONTROL_RETRYABLE$/);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith("/v1/website-egress-policies/revoke")).length, 2);
});

test("website cleans a valid issued reference when the issue attestation is malformed", async () => {
  const harness = controlHarness({ badIssueAttestation: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-issue-drift", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, new AbortController().signal), /^Error: WEBSITE_EGRESS_POLICY_ATTESTATION_FAILED$/);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.policyRevoke)).length, 2);
});

test("website gateway cleans a created session when a later gateway field is malformed", async () => {
  const harness = controlHarness({ badGatewayUrl: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-malformed-gateway", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, new AbortController().signal), /^Error: BROWSER_PROVIDER_RESPONSE_INVALID$/);
  for (const endpoint of [WEBSITE_LIVE_CONTROL_PATHS.browserStop, WEBSITE_LIVE_CONTROL_PATHS.browserReconcile]) {
    assert.equal(harness.calls.filter(({ url }) => url.endsWith(endpoint)).length, 1);
  }
  const stopIndex = harness.calls.findIndex(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserStop));
  const reconcileIndex = harness.calls.findIndex(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.browserReconcile));
  assert.ok(stopIndex >= 0 && reconcileIndex > stopIndex);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.leaseRelease)).length, 0);
});

test("website rejects a CDP observer that does not attest the enforced route policy", async () => {
  const harness = controlHarness({ badRoutePolicyDigest: true });
  const adapter = createConfiguredWebsiteAnalysisAdapter(environment(), {
    controlTransport: harness.transport, clock: () => now, ...networkControls(harness.expiresAt),
  });
  await assert.rejects(adapter({
    id: "analysis-run-observer-drift", organizationId: "organization-1", projectId: "project-1",
    sourceType: "website", sourceUrl: "https://widgets.example/app", sourceConfiguration: { kind: "website" }, leaseGeneration: 1,
  }, new AbortController().signal), /^Error: WEBSITE_CONTROL_RESPONSE_INVALID$/);
  assert.equal(harness.calls.filter(({ url }) => url.endsWith(WEBSITE_LIVE_CONTROL_PATHS.evidencePut)).length, 0);
});
