import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserUseCloudUpstream } from "../src/upstream/browser-use-cloud.ts";

const ORIGIN = "https://api.browser-use.example";
const KEY = "bu_upstream_key";

function transport(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

test("verifyCredentials authenticates against the v4 sessions listing, not a non-existent /me route", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const upstream = createBrowserUseCloudUpstream(ORIGIN, KEY, {
    fetch: transport((url, init) => {
      seen.push({ url, init });
      return Response.json({ sessions: [], nextCursor: null, hasMore: false });
    }),
  });
  const attested = await upstream.verifyCredentials();
  assert.deepEqual(attested, { apiVersion: "v4", authenticated: true, model: "browser-use-2.0" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, `${ORIGIN}/api/v4/sessions?limit=1`);
  assert.equal(seen[0]!.init.method, "GET");
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal(new Headers(seen[0]!.init.headers).get("x-browser-use-api-key"), KEY);
});

test("verifyCredentials maps upstream rejection and malformed listings to stable codes", async () => {
  const cases: [string, Response, string][] = [
    ["unauthorized", Response.json({ detail: "bad key" }, { status: 401 }), "BROWSER_USE_UPSTREAM_UNAUTHORIZED"],
    ["not found", Response.json({ detail: "Not Found" }, { status: 404 }), "BROWSER_USE_UPSTREAM_REJECTED"],
    ["no sessions array", Response.json({ items: [] }), "BROWSER_USE_UPSTREAM_RESPONSE_INVALID"],
  ];
  for (const [name, response, code] of cases) {
    const upstream = createBrowserUseCloudUpstream(ORIGIN, KEY, { fetch: transport(() => response) });
    await assert.rejects(upstream.verifyCredentials(), { message: code }, name);
  }
});

const NOW = new Date("2026-09-02T16:00:00.000Z");
const REQUEST = {
  apiVersion: "v4" as const,
  model: "browser-use-2.0" as const,
  allowedDomains: ["widgets.example"],
  allowedOrigins: ["https://widgets.example"],
  proxy: { denyByDefault: true as const, policyReference: "urn:sha256:" + "a".repeat(64) },
  session: { ephemeral: true as const, keepAlive: true as const, recording: false as const, profile: null, workspace: null, persistMemory: false as const },
  features: { downloads: false as const, uploads: false as const, skills: false as const, agentmail: false as const },
  expiresAt: "2026-09-02T16:12:30.000Z",
};

test("startSession creates a v4 cloud browser with a minute timeout and maps its https CDP host to a wss endpoint", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const upstream = createBrowserUseCloudUpstream(ORIGIN, KEY, {
    clock: () => NOW,
    fetch: transport((url, init) => {
      seen.push({ url, init });
      return Response.json({
        id: "c1f510b5-f6d0-4472-8e3e-945089f24340",
        status: "active",
        liveUrl: "https://live.browser-use.com?wss=https%3A%2F%2Fc1f510b5.cdp.browser-use.com",
        cdpUrl: "https://c1f510b5-f6d0-4472-8e3e-945089f24340.cdp.browser-use.com",
        timeoutAt: "2026-09-02T16:13:00.000Z",
      }, { status: 201 });
    }),
  });
  const started = await upstream.startSession(REQUEST);
  assert.deepEqual(started, {
    providerSessionId: "c1f510b5-f6d0-4472-8e3e-945089f24340",
    liveUrl: "https://live.browser-use.com?wss=https%3A%2F%2Fc1f510b5.cdp.browser-use.com",
    cdpUrl: "wss://c1f510b5-f6d0-4472-8e3e-945089f24340.cdp.browser-use.com/",
  });
  assert.equal(seen[0]!.url, `${ORIGIN}/api/v4/browsers`);
  assert.equal(seen[0]!.init.method, "POST");
  const body = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["metadata", "timeout"]);
  assert.equal(body.timeout, 13, "12.5 minutes remaining rounds up to whole minutes");
  assert.match(String((body.metadata as Record<string, unknown>).page2webmcpPolicyDigest), /^[0-9a-f]{64}$/);
});

test("startSession rejects a browser that is not active or whose endpoints are not https", async () => {
  for (const [name, created] of [
    ["not active", { id: "b1", status: "stopped", liveUrl: "https://l.example", cdpUrl: "https://b1.cdp.browser-use.com" }],
    ["http cdp", { id: "b1", status: "active", liveUrl: "https://l.example", cdpUrl: "http://b1.cdp.browser-use.com" }],
    ["missing id", { status: "active", liveUrl: "https://l.example", cdpUrl: "https://b1.cdp.browser-use.com" }],
  ] as const) {
    const upstream = createBrowserUseCloudUpstream(ORIGIN, KEY, {
      clock: () => NOW, fetch: transport(() => Response.json(created, { status: 201 })),
    });
    await assert.rejects(upstream.startSession(REQUEST), { message: "BROWSER_USE_UPSTREAM_RESPONSE_INVALID" }, name);
  }
});

test("stopSession issues the v4 stop action and reconcileSession only trusts a stopped browser", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  let status = "active";
  const upstream = createBrowserUseCloudUpstream(ORIGIN, KEY, {
    clock: () => NOW,
    fetch: transport((url, init) => {
      seen.push({ url, init });
      if (init.method === "PATCH") status = "stopped";
      return Response.json({ id: "b1", status, liveUrl: null, cdpUrl: null });
    }),
  });
  await assert.rejects(upstream.reconcileSession("b1"), { message: "BROWSER_USE_UPSTREAM_TERMINATION_UNPROVEN" });
  await upstream.stopSession("b1", "completed");
  assert.equal(seen[1]!.url, `${ORIGIN}/api/v4/browsers/b1`);
  assert.equal(seen[1]!.init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(seen[1]!.init.body)), { action: "stop" });
  assert.deepEqual(await upstream.reconcileSession("b1"), { terminated: true });
  assert.equal(seen[2]!.init.method, "GET");
});
