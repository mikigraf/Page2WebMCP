import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/auth/login/route.ts";

test("fixture owner login sets an HttpOnly server-authoritative role cookie", async () => {
  const response = await POST(new Request("http://test/api/auth/login", { method: "POST", body: JSON.stringify({ email: "owner@example.test", password: "fixture-password" }) }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /page2webmcp_role=owner; Path=\/; HttpOnly; SameSite=Lax/);
});

test("fixture login rejects invalid credentials", async () => {
  const response = await POST(new Request("http://test/api/auth/login", { method: "POST", body: JSON.stringify({ email: "owner@example.test", password: "wrong" }) }));
  assert.equal(response.status, 401);
});
