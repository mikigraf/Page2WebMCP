import test from "node:test";
import assert from "node:assert/strict";
import { startAcmeServer } from "../src/server.ts";

test("Acme Support exposes an authenticated same-origin API and public OpenAPI evidence", async (t) => {
  const server = await startAcmeServer();
  t.after(() => server.close());
  const unauthenticated = await fetch(`${server.origin}/api/orders?q=ORD-4812`);
  assert.equal(unauthenticated.status, 401);
  const login = await fetch(`${server.origin}/api/auth/login`, { method: "POST", body: JSON.stringify({ email: "agent@example.test", password: "fixture-password" }) });
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie);
  const orders = await fetch(`${server.origin}/api/orders?q=ORD-4812`, { headers: { cookie } });
  assert.deepEqual(await orders.json(), [{ id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" }]);
  const spec = await fetch(`${server.origin}/openapi.json`);
  assert.equal((await spec.json()).openapi, "3.1.0");
});
