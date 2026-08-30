import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, assertCsrf, issueCsrfChallenge } from "../src/api.ts";

const secret = "test-csrf-secret-that-is-long-enough-for-hmac";
const now = new Date("2026-08-30T12:00:00.000Z");

test("server-issued CSRF challenges bind exact origin, HttpOnly nonce, session, and expiry", () => {
  const challenge = issueCsrfChallenge(new Request("https://control.example/api/auth/csrf"), {
    secret,
    now,
    sessionId: "session-1",
    nonce: "0123456789abcdef0123456789abcdef"
  });
  assert.match(challenge.cookie, /^page2webmcp_csrf_nonce=/);
  assert.match(challenge.cookie, /HttpOnly/);
  assert.match(challenge.cookie, /Secure/);
  assert.match(challenge.cookie, /SameSite=Strict/);

  const valid = new Request("https://control.example/api/projects", {
    method: "POST",
    headers: {
      origin: "https://control.example",
      "sec-fetch-site": "same-origin",
      cookie: challenge.cookie.split(";")[0]!,
      "x-csrf-token": challenge.token
    }
  });
  assert.doesNotThrow(() => assertCsrf(valid, { secret, now, sessionId: "session-1" }));
  assert.throws(() => assertCsrf(valid, { secret, now, sessionId: "session-2" }), (error: unknown) =>
    error instanceof ApiError && error.code === "CSRF_TOKEN_INVALID");
  assert.throws(() => assertCsrf(valid, {
    secret,
    now: new Date(now.getTime() + 16 * 60_000),
    sessionId: "session-1"
  }), (error: unknown) => error instanceof ApiError && error.code === "CSRF_TOKEN_EXPIRED");
});

test("mutations reject missing and forged CSRF proofs before state changes", () => {
  const missing = new Request("https://control.example/api/projects", {
    method: "POST",
    headers: { origin: "https://control.example", "sec-fetch-site": "same-origin" }
  });
  assert.throws(() => assertCsrf(missing, { secret, now, sessionId: "session-1" }), (error: unknown) =>
    error instanceof ApiError && error.code === "CSRF_TOKEN_REQUIRED");
});
