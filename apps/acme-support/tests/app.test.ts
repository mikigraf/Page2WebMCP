import test from "node:test";
import assert from "node:assert/strict";
import { AcmeSupport } from "../src/app.ts";

test("authenticated agents can search orders and create tickets", () => {
  const app = new AcmeSupport();
  const session = app.login("agent@example.test", "fixture-password");
  assert.equal(app.searchOrders(session, "ORD-4812")[0]?.id, "ORD-4812");
  assert.deepEqual(app.createTicket(session, { orderId: "ORD-4812", title: "TEST damaged shipment", priority: "high" }), {
    ticketId: "TCK-1001", status: "open", priority: "high", createdAt: "2026-08-26T00:00:00.000Z"
  });
});

test("fixture rejects unauthenticated and prohibited actions", () => {
  const app = new AcmeSupport();
  assert.throws(() => app.searchOrders("missing", "ORD-4812"), { code: "AUTH_REQUIRED" });
  const session = app.login("agent@example.test", "fixture-password");
  assert.throws(() => app.deleteAccount(session), { code: "HIGH_RISK_ACTION" });
});
