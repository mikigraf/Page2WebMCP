import test from "node:test";
import assert from "node:assert/strict";
import { startAcmeServer } from "../src/server.ts";

const loginBody = { email: "agent@example.test", password: "fixture-password" };
const ticketBody = { orderId: "ORD-4812", title: "TEST HTTP ticket", priority: "high" };

async function login(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(loginBody) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /Path=\//i);
  assert.match(cookie, /Max-Age=1800/i);
  return cookie;
}

async function confirmation(origin: string, cookie: string, idempotencyKey: string, input = ticketBody): Promise<string> {
  const response = await fetch(`${origin}/api/confirmations`, {
    method: "POST", headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ toolName: "create_support_ticket", input, idempotencyKey }),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { evidence: string }).evidence;
}

test("Acme Support exposes an authenticated same-origin API and public OpenAPI evidence", async (t) => {
  const server = await startAcmeServer();
  t.after(() => server.close());
  const unauthenticated = await fetch(`${server.origin}/api/orders?q=ORD-4812`);
  assert.equal(unauthenticated.status, 401);
  const cookie = await login(server.origin);
  const orders = await fetch(`${server.origin}/api/orders?q=ORD-4812`, { headers: { cookie } });
  assert.deepEqual(await orders.json(), [{ id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" }]);
  const spec = await fetch(`${server.origin}/openapi.json`);
  assert.equal((await spec.json()).openapi, "3.1.0");
});

test("ticket mutation requires confirmation and idempotency and never duplicates a matching request", async (t) => {
  const server = await startAcmeServer();
  t.after(() => server.close());
  const cookie = await login(server.origin);

  const missing = await fetch(`${server.origin}/api/tickets`, {
    method: "POST", headers: { origin: server.origin, cookie, "content-type": "application/json" }, body: JSON.stringify(ticketBody),
  });
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), { code: "CONFIRMATION_REQUIRED" });

  const key = "http-idempotency-key-0001";
  const evidence = await confirmation(server.origin, cookie, key);
  const headers = { origin: server.origin, cookie, "content-type": "application/json", "idempotency-key": key, "x-page2webmcp-confirmation": evidence };
  const first = await fetch(`${server.origin}/api/tickets`, { method: "POST", headers, body: JSON.stringify(ticketBody) });
  assert.equal(first.status, 201);
  const firstTicket = await first.json();
  const duplicate = await fetch(`${server.origin}/api/tickets`, { method: "POST", headers, body: JSON.stringify(ticketBody) });
  assert.equal(duplicate.status, 201);
  assert.deepEqual(await duplicate.json(), firstTicket);
  const conflict = await fetch(`${server.origin}/api/tickets`, { method: "POST", headers, body: JSON.stringify({ ...ticketBody, title: "Different title" }) });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { code: "IDEMPOTENCY_CONFLICT" });
});

test("HTTP routes reject malformed, oversized, and extra-property payloads", async (t) => {
  const server = await startAcmeServer();
  t.after(() => server.close());
  const malformed = await fetch(`${server.origin}/api/auth/login`, { method: "POST", headers: { origin: server.origin }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { code: "INVALID_JSON" });

  const extra = await fetch(`${server.origin}/api/auth/login`, { method: "POST", headers: { origin: server.origin }, body: JSON.stringify({ ...loginBody, admin: true }) });
  assert.equal(extra.status, 400);
  assert.deepEqual(await extra.json(), { code: "VALIDATION_ERROR" });

  const oversized = await fetch(`${server.origin}/api/auth/login`, { method: "POST", headers: { origin: server.origin }, body: JSON.stringify({ email: "x".repeat(17_000), password: "x" }) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { code: "PAYLOAD_TOO_LARGE" });
});

test("HTTP mutation routes reject cross-origin requests with a safe no-store error", async (t) => {
  const server = await startAcmeServer();
  t.after(() => server.close());
  const response = await fetch(`${server.origin}/api/auth/login`, {
    method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(loginBody),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: "ORIGIN_MISMATCH" });
});
