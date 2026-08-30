import assert from "node:assert/strict";
import test from "node:test";
import {
  awaitWebsiteAuthentication,
  browserUseCloudV4PolicyDigest,
  withBrowserUseCloudV4Session,
  type BrowserUseCloudV4Controls,
  type BrowserUseCloudV4Request,
} from "./browser-use-v4.ts";

const now = new Date("2026-08-30T12:00:00.000Z");
const expiresAt = "2026-08-30T12:10:00.000Z";
const targetOrigin = "https://widgets.example";

function controls(overrides: Partial<BrowserUseCloudV4Controls> = {}): BrowserUseCloudV4Controls {
  return {
    clock: () => now,
    leases: {
      claim: async () => ({ leaseId: "lease-1" }),
      release: async () => undefined,
    },
    secretReferences: {
      put: async ({ purpose, expiresAt: expiry }) => ({ reference: `secretref:${purpose}`, expiresAt: expiry }),
      revoke: async () => undefined,
    },
    transport: {
      start: async (request) => ({
        providerSessionId: "provider-session-1",
        liveUrl: "https://live.browser-use.example/super-secret",
        cdpUrl: "wss://cdp.browser-use.example/super-secret",
        appliedPolicyDigest: browserUseCloudV4PolicyDigest(request),
      }),
      stop: async () => undefined,
      reconcile: async () => undefined,
    },
    ...overrides,
  };
}

test("Browser Use Cloud v4 adapter pins every discovery control and returns TTL references only", async () => {
  const starts: BrowserUseCloudV4Request[] = [];
  const stopped: unknown[] = [];
  const reconciled: unknown[] = [];
  const stored: unknown[] = [];
  const revoked: string[] = [];
  const result = await withBrowserUseCloudV4Session({
    organizationId: "org-1",
    projectId: "project-1",
    runId: "run-1",
    targetOrigin,
    expiresAt,
    proxyPolicyReference: { reference: "secretref:proxy-policy", expiresAt },
  }, controls({
    secretReferences: {
      put: async (input) => {
        stored.push(input);
        return { reference: `secretref:${input.purpose}`, expiresAt: input.expiresAt };
      },
      revoke: async (reference) => { revoked.push(reference); },
    },
    transport: {
      start: async (request) => {
        starts.push(request);
        return {
          providerSessionId: "provider-session-1",
          liveUrl: "https://live.browser-use.example/super-secret",
          cdpUrl: "wss://cdp.browser-use.example/super-secret",
          appliedPolicyDigest: browserUseCloudV4PolicyDigest(request),
        };
      },
      stop: async (...args) => { stopped.push(args); },
      reconcile: async (...args) => { reconciled.push(args); },
    },
  }), async (session) => {
    assert.deepEqual(session, {
      apiVersion: "v4",
      model: "browser-use-2.0",
      targetOrigin,
      expiresAt,
      leaseId: "lease-1",
      liveReference: "secretref:browser_live_url",
      cdpReference: "secretref:browser_cdp_url",
      policyDigest: session.policyDigest,
    });
    assert.match(session.policyDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(session).includes("super-secret"), false);
    return "observed";
  });

  assert.equal(result, "observed");
  assert.deepEqual(starts, [{
    apiVersion: "v4",
    model: "browser-use-2.0",
    allowedDomains: ["widgets.example"],
    allowedOrigins: [targetOrigin],
    proxy: { denyByDefault: true, policyReference: "secretref:proxy-policy" },
    session: {
      ephemeral: true,
      keepAlive: true,
      recording: false,
      profile: null,
      workspace: null,
      persistMemory: false,
    },
    features: { downloads: false, uploads: false, skills: false, agentmail: false },
    expiresAt,
  }]);
  assert.equal(JSON.stringify(stored).includes("super-secret"), true);
  assert.deepEqual(revoked.sort(), ["secretref:browser_cdp_url", "secretref:browser_live_url"]);
  assert.deepEqual(stopped, [["provider-session-1", "completed"]]);
  assert.deepEqual(reconciled, [["provider-session-1"]]);
});

test("Browser Use Cloud v4 fails closed on missing controls, proxy/TTL errors, and policy drift", async () => {
  const input = {
    organizationId: "org-1", projectId: "project-1", runId: "run-1", targetOrigin, expiresAt,
    proxyPolicyReference: { reference: "secretref:proxy-policy", expiresAt },
  };
  await assert.rejects(withBrowserUseCloudV4Session(input, {} as BrowserUseCloudV4Controls, async () => undefined), /BROWSER_PROVIDER_CONTROLS_REQUIRED/);
  await assert.rejects(withBrowserUseCloudV4Session({ ...input, proxyPolicyReference: { reference: "https:\/\/proxy.example/secret", expiresAt } }, controls(), async () => undefined), /BROWSER_PROXY_POLICY_REQUIRED/);
  await assert.rejects(withBrowserUseCloudV4Session({ ...input, expiresAt: "2026-08-30T12:20:00.000Z" }, controls(), async () => undefined), /BROWSER_SESSION_TTL_INVALID/);
  await assert.rejects(withBrowserUseCloudV4Session(input, controls({
    transport: {
      start: async () => ({ providerSessionId: "provider-session-1", liveUrl: "https://live.invalid/x", cdpUrl: "wss://cdp.invalid/x", appliedPolicyDigest: "0".repeat(64) }),
      stop: async () => undefined,
      reconcile: async () => undefined,
    },
  }), async () => undefined), /BROWSER_PROVIDER_CONTROL_ATTESTATION_FAILED/);
  await assert.rejects(withBrowserUseCloudV4Session(input, controls({
    secretReferences: {
      put: async ({ purpose }) => ({ reference: `secretref:${purpose}`, expiresAt: "2026-08-30T12:11:00.000Z" }),
      revoke: async () => undefined,
    },
  }), async () => undefined), /BROWSER_SECRET_REFERENCE_INVALID/);
});

test("Browser Use session claims once and cleans up/reconciles after failure and cancellation", async () => {
  const events: string[] = [];
  const input = {
    organizationId: "org-1", projectId: "project-1", runId: "run-1", targetOrigin, expiresAt,
    proxyPolicyReference: { reference: "secretref:proxy-policy", expiresAt },
  };
  await assert.rejects(withBrowserUseCloudV4Session(input, controls({
    leases: { claim: async () => { throw new Error("BROWSER_SESSION_ALREADY_ACTIVE"); }, release: async () => { events.push("release"); } },
  }), async () => undefined), /BROWSER_SESSION_ALREADY_ACTIVE/);
  assert.equal(events.length, 0);

  await assert.rejects(withBrowserUseCloudV4Session(input, controls({
    leases: { claim: async () => ({ leaseId: "lease-failure" }), release: async () => { events.push("release"); } },
    transport: {
      start: async (request) => ({ providerSessionId: "provider-failure", liveUrl: "https://live.invalid/x", cdpUrl: "wss://cdp.invalid/x", appliedPolicyDigest: browserUseCloudV4PolicyDigest(request) }),
      stop: async (_id, reason) => { events.push(`stop:${reason}`); },
      reconcile: async () => { events.push("reconcile"); },
    },
  }), async () => { throw new Error("EXPLORER_FAILED"); }), /EXPLORER_FAILED/);
  assert.deepEqual(events, ["stop:failed", "reconcile", "release"]);

  const controller = new AbortController();
  await assert.rejects(withBrowserUseCloudV4Session(input, controls({
    signal: controller.signal,
    leases: { claim: async () => ({ leaseId: "lease-cancel" }), release: async () => { events.push("cancel-release"); } },
    transport: {
      start: async (request) => ({ providerSessionId: "provider-cancel", liveUrl: "https://live.invalid/x", cdpUrl: "wss://cdp.invalid/x", appliedPolicyDigest: browserUseCloudV4PolicyDigest(request) }),
      stop: async (_id, reason) => { events.push(`cancel-stop:${reason}`); },
      reconcile: async () => { events.push("cancel-reconcile"); },
    },
  }), async () => {
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    return "must-not-complete";
  }), /BROWSER_SESSION_ABORTED/);
  assert.deepEqual(events.slice(-3), ["cancel-stop:cancelled", "cancel-reconcile", "cancel-release"]);
});

test("durable auth handoff resumes only on bounded deterministic same-origin evidence", async () => {
  const opens: unknown[] = [];
  const closes: unknown[] = [];
  const store = {
    open: async (input: unknown) => { opens.push(input); return { handoffId: "handoff-1" }; },
    wait: async () => ({
      authenticatedOrigin: targetOrigin,
      observedAt: "2026-08-30T12:01:00.000Z",
      signals: ["logout_control", "account_control"] as const,
    }),
    close: async (...args: unknown[]) => { closes.push(args); },
  };
  const result = await awaitWebsiteAuthentication({
    organizationId: "org-1", projectId: "project-1", runId: "run-1", targetOrigin,
    liveReference: "secretref:browser_live_url", expiresAt,
  }, { store, clock: () => now });
  assert.match(result.reference, /^urn:sha256:[a-f0-9]{64}$/);
  assert.equal(result.targetOrigin, targetOrigin);
  assert.deepEqual(JSON.parse(result.content), {
    authenticatedOrigin: targetOrigin,
    observedAt: "2026-08-30T12:01:00.000Z",
    signals: ["account_control", "logout_control"],
    version: 1,
  });
  assert.equal(JSON.stringify(result).includes("secretref"), false);
  assert.equal(opens.length, 1);
  assert.deepEqual(closes, [["handoff-1", "completed"]]);

  for (const completion of [
    { authenticatedOrigin: "https://other.example", observedAt: "2026-08-30T12:01:00.000Z", signals: ["account_control"] },
    { authenticatedOrigin: targetOrigin, observedAt: "2026-08-30T12:01:00.000Z", signals: [] },
    { authenticatedOrigin: targetOrigin, observedAt: "2026-08-30T12:01:00.000Z", signals: ["account_control"], password: "canary" },
  ]) {
    await assert.rejects(awaitWebsiteAuthentication({
      organizationId: "org-1", projectId: "project-1", runId: "run-1", targetOrigin,
      liveReference: "secretref:browser_live_url", expiresAt,
    }, {
      store: { open: async () => ({ handoffId: "handoff-bad" }), wait: async () => completion, close: async () => undefined },
      clock: () => now,
    }), /AUTH_(?:ORIGIN_MISMATCH|STATE_UNVERIFIED|CREDENTIAL_MATERIAL_BLOCKED)/);
  }
});

test("auth handoff expiry, MFA timeout, and cancellation close durable wait state", async () => {
  await assert.rejects(awaitWebsiteAuthentication({
    organizationId: "org-1", projectId: "project-1", runId: "run-1", targetOrigin,
    liveReference: "secretref:browser_live_url", expiresAt: "2026-08-30T11:59:00.000Z",
  }, { store: { open: async () => ({ handoffId: "never" }), wait: async () => { throw new Error("never"); }, close: async () => undefined }, clock: () => now }), /AUTH_HANDOFF_EXPIRED/);

  const closed: unknown[] = [];
  await assert.rejects(awaitWebsiteAuthentication({
    organizationId: "org-1", projectId: "project-1", runId: "run-1", targetOrigin,
    liveReference: "secretref:browser_live_url", expiresAt,
  }, {
    store: {
      open: async () => ({ handoffId: "handoff-mfa" }),
      wait: async () => { throw new Error("AUTH_MFA_TIMEOUT"); },
      close: async (...args) => { closed.push(args); },
    },
    clock: () => now,
  }), /AUTH_MFA_TIMEOUT/);
  assert.deepEqual(closed, [["handoff-mfa", "failed"]]);
});

test("Browser Use provider startup receives cancellation and releases its durable lease", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const pending = withBrowserUseCloudV4Session({
    organizationId: "org-1", projectId: "project-1", runId: "run-start-cancel", targetOrigin, expiresAt,
    proxyPolicyReference: { reference: "secretref:proxy-policy", expiresAt },
  }, controls({
    signal: controller.signal,
    leases: {
      claim: async () => ({ leaseId: "lease-start-cancel" }),
      release: async () => { events.push("release"); },
    },
    transport: {
      start: async (_request, providerSignal?: AbortSignal): Promise<never> => {
        if (!providerSignal) throw new Error("BROWSER_START_SIGNAL_REQUIRED");
        return await new Promise<never>((_resolve, reject) => providerSignal.addEventListener("abort", () => reject(providerSignal.reason), { once: true }));
      },
      stop: async () => { events.push("stop"); },
      reconcile: async () => { events.push("reconcile"); },
    },
  }), async () => undefined);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, /BROWSER_SESSION_ABORTED/);
  assert.deepEqual(events, ["release"]);
});

test("Browser Use session expiry aborts a stalled action and reconciles provider state", async () => {
  const shortExpiry = "2026-08-30T12:00:00.040Z";
  const events: string[] = [];
  let actionCompleted = false;
  await assert.rejects(withBrowserUseCloudV4Session({
    organizationId: "org-1", projectId: "project-1", runId: "run-expiry", targetOrigin,
    expiresAt: shortExpiry,
    proxyPolicyReference: { reference: "secretref:proxy-policy", expiresAt },
  }, controls({
    leases: {
      claim: async () => ({ leaseId: "lease-expiry" }),
      release: async () => { events.push("release"); },
    },
    transport: {
      start: async (request) => ({
        providerSessionId: "provider-expiry",
        liveUrl: "https://live.invalid/expiry",
        cdpUrl: "wss://cdp.invalid/expiry",
        appliedPolicyDigest: browserUseCloudV4PolicyDigest(request),
      }),
      stop: async (_id, reason) => { events.push(`stop:${reason}`); },
      reconcile: async () => { events.push("reconcile"); },
    },
  }), async (_session, sessionSignal) => {
    assert.equal(sessionSignal?.aborted ?? false, false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    actionCompleted = true;
    return "must-not-complete";
  }), /BROWSER_SESSION_EXPIRED/);
  assert.equal(actionCompleted, false);
  assert.deepEqual(events, ["stop:cancelled", "reconcile", "release"]);
});
