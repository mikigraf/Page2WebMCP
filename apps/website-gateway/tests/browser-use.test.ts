import assert from "node:assert/strict";
import test from "node:test";
import {
  browserUseCloudV4PolicyDigest,
  type BrowserUseCloudV4Request,
} from "../../../packages/providers/src/browser-use-v4.ts";
import { startGateway, testEnvironment, envelope, TEST_BROWSER_USE_KEY } from "./harness.ts";

const expiresAt = new Date("2026-08-31T12:09:00.000Z").toISOString();

function pinnedRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: "v4",
    model: "browser-use-2.0",
    allowedDomains: ["widgets.example"],
    allowedOrigins: ["https://widgets.example"],
    proxy: { denyByDefault: true, policyReference: "secretref:policy-run-1" },
    session: {
      ephemeral: true, keepAlive: true, recording: false,
      profile: null, workspace: null, persistMemory: false,
    },
    features: { downloads: false, uploads: false, skills: false, agentmail: false },
    expiresAt,
    ...overrides,
  };
}

function upstreamStub(calls: Record<string, unknown>[]) {
  return {
    verifyCredentials: async () => ({ apiVersion: "v4" as const, authenticated: true as const, model: "browser-use-2.0" as const }),
    startSession: async (request: BrowserUseCloudV4Request) => {
      calls.push(request as unknown as Record<string, unknown>);
      return {
        providerSessionId: "provider-session-1",
        liveUrl: "https://live.browser-use.com/session/1",
        cdpUrl: "wss://cdp.browser-use.com/session/1",
      };
    },
    stopSession: async () => undefined,
    reconcileSession: async () => ({ terminated: true as const }),
  };
}

test("a pinned Browser Use session starts, echoes the worker envelope, and returns a computed policy digest", async () => {
  const calls: Record<string, unknown>[] = [];
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, browserUseUpstream: upstreamStub(calls) });
  try {
    const request = pinnedRequest();
    const body = envelope("browser-start", { request });
    const started = await gateway.json("/v1/browser-use-v4/sessions/start", body, { apiKey: TEST_BROWSER_USE_KEY });
    assert.equal(started.status, 200);
    assert.equal(started.body?.apiVersion, "v4");
    assert.equal(started.body?.model, "browser-use-2.0");
    assert.equal(started.body?.providerSessionId, "provider-session-1");
    assert.equal(started.body?.idempotencyKey, body.idempotencyKey);
    assert.match(String(started.body?.liveUrl), /^https:\/\//);
    assert.match(String(started.body?.cdpUrl), /^wss:\/\//);
    assert.equal(started.body?.appliedPolicyDigest,
      browserUseCloudV4PolicyDigest(request as unknown as BrowserUseCloudV4Request));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], request);
  } finally { await gateway.close(); }
});

test("the applied policy digest is computed from what was sent, never echoed from the caller", async () => {
  const calls: Record<string, unknown>[] = [];
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, browserUseUpstream: upstreamStub(calls) });
  try {
    const request = pinnedRequest();
    const started = await gateway.json("/v1/browser-use-v4/sessions/start",
      { ...envelope("browser-start", { request }), appliedPolicyDigest: "f".repeat(64) },
      { apiKey: TEST_BROWSER_USE_KEY });
    assert.equal(started.status, 200);
    assert.notEqual(started.body?.appliedPolicyDigest, "f".repeat(64));
    assert.equal(started.body?.appliedPolicyDigest,
      browserUseCloudV4PolicyDigest(request as unknown as BrowserUseCloudV4Request));
  } finally { await gateway.close(); }
});

test("a session whose pinned safety settings differ from the required ones is refused before any upstream call", async () => {
  const mutations: Array<Record<string, unknown>> = [
    { session: { ephemeral: true, keepAlive: true, recording: true, profile: null, workspace: null, persistMemory: false } },
    { session: { ephemeral: false, keepAlive: true, recording: false, profile: null, workspace: null, persistMemory: false } },
    { session: { ephemeral: true, keepAlive: true, recording: false, profile: "saved", workspace: null, persistMemory: false } },
    { session: { ephemeral: true, keepAlive: true, recording: false, profile: null, workspace: "team", persistMemory: false } },
    { session: { ephemeral: true, keepAlive: true, recording: false, profile: null, workspace: null, persistMemory: true } },
    { features: { downloads: true, uploads: false, skills: false, agentmail: false } },
    { features: { downloads: false, uploads: true, skills: false, agentmail: false } },
    { features: { downloads: false, uploads: false, skills: true, agentmail: false } },
    { features: { downloads: false, uploads: false, skills: false, agentmail: true } },
    { proxy: { denyByDefault: false, policyReference: "secretref:policy-run-1" } },
    { apiVersion: "v3" },
    { model: "some-other-model" },
    { allowedOrigins: ["https://widgets.example", "https://tracker.example"] },
  ];
  const calls: Record<string, unknown>[] = [];
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, browserUseUpstream: upstreamStub(calls) });
  try {
    for (const mutation of mutations) {
      const response = await gateway.json("/v1/browser-use-v4/sessions/start",
        envelope("browser-start", { request: pinnedRequest(mutation) }), { apiKey: TEST_BROWSER_USE_KEY });
      assert.equal(response.status, 400, JSON.stringify(mutation));
    }
    assert.equal(calls.length, 0);
  } finally { await gateway.close(); }
});

test("stop and reconcile attest only what the upstream actually confirmed", async () => {
  const calls: Record<string, unknown>[] = [];
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, browserUseUpstream: upstreamStub(calls) });
  try {
    await gateway.json("/v1/browser-use-v4/sessions/start",
      envelope("browser-start", { request: pinnedRequest() }), { apiKey: TEST_BROWSER_USE_KEY });
    const stopped = await gateway.json("/v1/browser-use-v4/sessions/stop",
      envelope("browser-stop", { providerSessionId: "provider-session-1", reason: "completed" }),
      { apiKey: TEST_BROWSER_USE_KEY });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body?.stopped, true);
    const reconciled = await gateway.json("/v1/browser-use-v4/sessions/reconcile",
      envelope("browser-reconcile", { providerSessionId: "provider-session-1" }), { apiKey: TEST_BROWSER_USE_KEY });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body?.reconciled, true);
    assert.equal(reconciled.body?.terminated, true);
  } finally { await gateway.close(); }
});

test("an upstream that will not confirm termination is never attested as terminated", async () => {
  const calls: Record<string, unknown>[] = [];
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), {
    clock: () => current,
    browserUseUpstream: {
      ...upstreamStub(calls),
      reconcileSession: async () => { throw new Error("upstream api-key=must-not-leak"); },
    },
  });
  try {
    await gateway.json("/v1/browser-use-v4/sessions/start",
      envelope("browser-start", { request: pinnedRequest() }), { apiKey: TEST_BROWSER_USE_KEY });
    const reconciled = await gateway.json("/v1/browser-use-v4/sessions/reconcile",
      envelope("browser-reconcile", { providerSessionId: "provider-session-1" }), { apiKey: TEST_BROWSER_USE_KEY });
    assert.equal(reconciled.status, 503);
    assert.equal(reconciled.body?.terminated, undefined);
    assert.doesNotMatch(reconciled.raw, /must-not-leak/);
  } finally { await gateway.close(); }
});

test("live Browser Use Cloud v4 round trip", { skip: "requires real Browser Use Cloud credentials (PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_API_KEY) and real network egress; a stubbed upstream would prove nothing about the real contract" }, () => {
  assert.fail("unreachable");
});
