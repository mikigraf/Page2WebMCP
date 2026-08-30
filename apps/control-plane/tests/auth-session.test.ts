import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticate,
  createFixtureAuthService,
  issueSession,
  sessionFromRequest,
  verifySessionToken
} from "../src/auth-fixture.ts";
import { createConfiguredSupabaseAuthService } from "../src/auth.ts";

const clock = new Date("2026-08-29T12:00:00.000Z");
const secret = "test-session-secret-that-is-long-enough";

test("fixture authentication returns a stable actor rather than a caller-controlled role", () => {
  assert.deepEqual(authenticate("owner@example.test", "fixture-password"), {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner"
  });
  assert.equal(authenticate("owner@example.test", "wrong"), undefined);
});

test("production auth has no fixture-credential fallback", () => {
  assert.throws(() => createConfiguredSupabaseAuthService({
    NODE_ENV: "production",
    PAGE2WEBMCP_OWNER_PASSWORD: "fixture-password"
  }), /SUPABASE_CONFIGURATION_REQUIRED/);
});

test("the explicit hermetic fixture still returns a server-verifiable session identifier", async () => {
  const service = createFixtureAuthService({ now: clock });
  const actor = authenticate("owner@example.test", "fixture-password")!;
  const token = issueSession(actor, { now: clock, ttlSeconds: 60 });
  const identity = await service.identity(new Request("https://control.example/api/projects", {
    headers: { cookie: `page2webmcp_fixture_session=${token}` }
  }));
  assert.match(identity?.sessionId ?? "", /^[0-9a-f-]{36}$/);
});

test("signed sessions reject tampering and expiration", () => {
  const actor = authenticate("owner@example.test", "fixture-password");
  assert.ok(actor);
  const token = issueSession(actor, { secret, now: clock, ttlSeconds: 60 });

  assert.deepEqual(verifySessionToken(token, { secret, now: clock }), actor);
  assert.equal(verifySessionToken(`${token}tampered`, { secret, now: clock }), undefined);
  assert.equal(verifySessionToken(token, { secret, now: new Date(clock.getTime() + 61_000) }), undefined);
});

test("request authentication ignores the legacy plaintext role cookie", () => {
  const forged = new Request("https://control.example/api/projects", {
    headers: { cookie: "page2webmcp_role=owner" }
  });
  assert.equal(sessionFromRequest(forged, { secret, now: clock }), undefined);

  const actor = authenticate("editor@example.test", "fixture-password");
  assert.ok(actor);
  const token = issueSession(actor, { secret, now: clock, ttlSeconds: 60 });
  const signed = new Request("https://control.example/api/projects", {
    headers: { cookie: `page2webmcp_fixture_session=${token}` }
  });
  assert.deepEqual(sessionFromRequest(signed, { secret, now: clock }), actor);
});
