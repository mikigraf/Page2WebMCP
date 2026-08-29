import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/auth/login/route.ts";

test("fixture owner login sets an HttpOnly signed session cookie", async () => {
  const response = await POST(new Request("http://test/api/auth/login", {
    method: "POST",
    headers: { origin: "http://test" },
    body: JSON.stringify({ email: "owner@example.test", password: "fixture-password" })
  }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^page2webmcp_session=[A-Za-z0-9._-]+;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=3600/);
  assert.doesNotMatch(cookie, /page2webmcp_role/);
});

test("fixture login rejects invalid credentials", async () => {
  const response = await POST(new Request("http://test/api/auth/login", {
    method: "POST",
    headers: { origin: "http://test" },
    body: JSON.stringify({ email: "owner@example.test", password: "wrong" })
  }));
  assert.equal(response.status, 401);
});
