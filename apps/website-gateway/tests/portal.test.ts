import assert from "node:assert/strict";
import test from "node:test";
import { portalUrlFor, safePortalUrl } from "../src/routes/portal-url.ts";
import { startGateway, testEnvironment, sha256Hex, TEST_TOKENS } from "./harness.ts";

const origin = "https://auth-handoff.example";

test("a portal url carries exactly one opaque handoff parameter", () => {
  const url = portalUrlFor(origin, "AbC123._~-");
  assert.equal(url, "https://auth-handoff.example/portal?handoff=AbC123._~-");
  assert.equal(safePortalUrl(url, origin), url);
});

test("portal url building refuses forbidden parameter names and unsafe handoff values", () => {
  for (const name of ["token", "secret", "password", "passcode", "cookie", "csrf", "otp", "credential",
    "api_key", "apiKey", "code", "session", "provider", "live", "cdp"]) {
    assert.equal(portalUrlFor(origin, "abc", name), undefined, name);
  }
  assert.equal(portalUrlFor(origin, "has space"), undefined);
  assert.equal(portalUrlFor(origin, ""), undefined);
  assert.equal(portalUrlFor(origin, "x".repeat(129)), undefined);
  assert.equal(portalUrlFor("http://auth-handoff.example", "abc"), undefined);
});

test("portal url validation matches the control plane sanitizer", () => {
  assert.equal(safePortalUrl("https://auth-handoff.example/portal?handoff=a&extra=b", origin), undefined);
  assert.equal(safePortalUrl("https://auth-handoff.example/portal", origin), undefined);
  assert.equal(safePortalUrl("https://auth-handoff.example/other?handoff=a", origin), undefined);
  assert.equal(safePortalUrl("https://elsewhere.example/portal?handoff=a", origin), undefined);
  assert.equal(safePortalUrl("https://auth-handoff.example/portal?handoff=a#frag", origin), undefined);
  assert.equal(safePortalUrl("https://user:pass@auth-handoff.example/portal?handoff=a", origin), undefined);
  assert.equal(safePortalUrl("https://auth-handoff.example/portal?token=a", origin), undefined);
});

test("the portal page never discloses the provider session, cdp url, live url or any secret", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), {
    clock: () => current,
    authenticationObserver: { observe: async (input: Readonly<{ targetOrigin: string }>) => ({
      authenticatedOrigin: input.targetOrigin, observedAt: "2026-08-31T12:01:00.000Z", signals: ["account_control"] as const,
    }) },
  });
  try {
    const unknown = await gateway.get("/portal?handoff=unknownhandoffvalue");
    assert.equal(unknown.status, 404);
    assert.match(unknown.contentType ?? "", /^text\/html/);
    assert.doesNotMatch(unknown.text, /secretref:|wss:|provider-session|Bearer /);
    const malformed = await gateway.get("/portal?handoff=has%20space");
    assert.equal(malformed.status, 400);
    const extra = await gateway.get("/portal?handoff=abc&token=leak");
    assert.equal(extra.status, 400);
  } finally { await gateway.close(); }
});

test("the human status page is served without a control token and leaks nothing", async () => {
  const gateway = await startGateway();
  try {
    const status = await gateway.get("/status?handoff=unknownhandoffvalue");
    assert.equal(status.status, 404);
    assert.match(status.contentType ?? "", /^text\/html/);
    assert.doesNotMatch(status.text, new RegExp(TEST_TOKENS["authentication-handoff"]));
    assert.doesNotMatch(status.text, /secretref:|wss:/);
    assert.equal(sha256Hex("unused").length, 64);
  } finally { await gateway.close(); }
});
