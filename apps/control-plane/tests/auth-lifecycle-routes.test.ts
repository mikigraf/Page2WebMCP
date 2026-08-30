import assert from "node:assert/strict";
import test from "node:test";
import { GET as callback } from "../app/api/auth/callback/route.ts";
import { POST as login } from "../app/api/auth/login/route.ts";
import { POST as logout } from "../app/api/auth/logout/route.ts";
import { POST as recovery } from "../app/api/auth/recovery/route.ts";
import { POST as refresh } from "../app/api/auth/refresh/route.ts";
import { POST as revoke } from "../app/api/auth/revoke/route.ts";
import { GET as session } from "../app/api/auth/session/route.ts";
import { POST as signup } from "../app/api/auth/signup/route.ts";
import { installTestRepository, anonymousCsrfHeaders } from "./auth-test-helpers.ts";

function mutation(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(`https://control.example${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function cookieValue(response: Response, name: string): string | undefined {
  const value = response.headers.get("set-cookie") ?? "";
  return value.match(new RegExp(`(?:^|, )(${name}=[^;]*)`))?.[1];
}

test("explicit SSR fixture covers signup, login, reload/new-tab, refresh, logout, recovery, and revocation routes", async () => {
  installTestRepository();
  const anonymous = anonymousCsrfHeaders("https://control.example");

  const signupResponse = await signup(mutation("/api/auth/signup", {
    email: "new@example.test",
    password: "a sufficiently strong password"
  }, anonymous));
  assert.equal(signupResponse.status, 202);
  assert.equal((await signupResponse.json()).emailVerificationRequired, true);

  const loginResponse = await login(mutation("/api/auth/login", {
    email: "owner@example.test",
    password: "fixture-password"
  }, anonymous));
  assert.equal(loginResponse.status, 200);
  const authCookie = cookieValue(loginResponse, "page2webmcp_fixture_session");
  assert.ok(authCookie);

  const reloaded = await session(new Request("https://control.example/api/auth/session", {
    headers: { cookie: authCookie }
  }));
  assert.equal(reloaded.status, 200);
  const sessionBody = await reloaded.json();
  assert.equal(sessionBody.actor.role, "owner");
  assert.doesNotMatch(JSON.stringify(sessionBody), /user_metadata|access_token|refresh_token/);
  const csrfCookie = cookieValue(reloaded, "page2webmcp_csrf_nonce");
  assert.ok(csrfCookie);

  const refreshResponse = await refresh(mutation("/api/auth/refresh", {}, {
    ...anonymous,
    cookie: `${authCookie}; ${anonymous.cookie}`
  }));
  assert.equal(refreshResponse.status, 200);
  assert.match(refreshResponse.headers.get("set-cookie") ?? "", /page2webmcp_fixture_session=/);
  const refreshedAuthCookie = cookieValue(refreshResponse, "page2webmcp_fixture_session")!;
  const refreshedSession = await session(new Request("https://control.example/api/auth/session", {
    headers: { cookie: refreshedAuthCookie }
  }));
  const refreshedBody = await refreshedSession.json();
  const refreshedCsrfCookie = cookieValue(refreshedSession, "page2webmcp_csrf_nonce")!;

  const recoveryResponse = await recovery(mutation("/api/auth/recovery", {
    email: "owner@example.test"
  }, { ...anonymous, cookie: `${authCookie}; ${anonymous.cookie}` }));
  assert.equal(recoveryResponse.status, 202);
  assert.match(recoveryResponse.headers.get("set-cookie") ?? "",
    /page2webmcp_fixture_session=.*Max-Age=0/);
  assert.match(recoveryResponse.headers.get("set-cookie") ?? "",
    /page2webmcp_csrf_nonce=.*Max-Age=0/);

  const revokedResponse = await revoke(mutation("/api/auth/revoke", {}, {
    cookie: `${refreshedAuthCookie}; ${refreshedCsrfCookie}`,
    origin: "https://control.example",
    "sec-fetch-site": "same-origin",
    "x-csrf-token": refreshedBody.csrfToken
  }));
  assert.equal(revokedResponse.status, 200);
  assert.match(revokedResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await session(new Request("https://control.example/api/auth/session", {
    headers: { cookie: refreshedAuthCookie }
  }))).status, 401);

  installTestRepository();
  const relogin = await login(mutation("/api/auth/login", {
    email: "owner@example.test",
    password: "fixture-password"
  }, anonymous));
  const secondCookie = cookieValue(relogin, "page2webmcp_fixture_session")!;
  const secondSession = await session(new Request("https://control.example/api/auth/session", {
    headers: { cookie: secondCookie }
  }));
  const secondBody = await secondSession.json();
  const secondCsrfCookie = cookieValue(secondSession, "page2webmcp_csrf_nonce")!;
  const logoutResponse = await logout(mutation("/api/auth/logout", {}, {
    cookie: `${secondCookie}; ${secondCsrfCookie}`,
    origin: "https://control.example",
    "sec-fetch-site": "same-origin",
    "x-csrf-token": secondBody.csrfToken
  }));
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get("set-cookie") ?? "", /page2webmcp_csrf_nonce=.*Max-Age=0/);
});

test("PKCE callback accepts only a one-time code and rejects bearer query tokens", async () => {
  installTestRepository();
  const verified = await callback(new Request(
    "https://control.example/api/auth/callback?code=fixture-owner-code"
  ));
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get("location"), "https://control.example/?auth=verified");
  assert.match(verified.headers.get("set-cookie") ?? "", /page2webmcp_fixture_session=/);

  const bearer = await callback(new Request(
    "https://control.example/api/auth/callback?access_token=forbidden&code=fixture-owner-code"
  ));
  assert.equal(bearer.status, 400);
  assert.equal((await bearer.json()).code, "BEARER_QUERY_TOKEN_FORBIDDEN");
});
