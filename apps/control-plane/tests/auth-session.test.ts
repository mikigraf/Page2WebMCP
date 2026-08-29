import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticate,
  issueSession,
  sessionFromRequest,
  verifySessionToken
} from "../src/auth.ts";

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

test("production authentication uses only deployment-managed credentials", () => {
  const environment = {
    NODE_ENV: "production",
    PAGE2WEBMCP_OWNER_PASSWORD: "deployment-owner-password-with-32-bytes",
    PAGE2WEBMCP_EDITOR_PASSWORD: "deployment-editor-password-with-32-bytes"
  };
  assert.equal(authenticate("owner@example.test", "fixture-password", environment), undefined);
  assert.equal(authenticate("owner@example.test", "deployment-owner-password-with-32-bytes", environment)?.role, "owner");
  assert.equal(authenticate("editor@example.test", "deployment-editor-password-with-32-bytes", environment)?.role, "editor");
  assert.equal(authenticate("owner@example.test", "fixture-invalid-password", { NODE_ENV: "production" }), undefined);
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
    headers: { cookie: `page2webmcp_session=${token}` }
  });
  assert.deepEqual(sessionFromRequest(signed, { secret, now: clock }), actor);
});
