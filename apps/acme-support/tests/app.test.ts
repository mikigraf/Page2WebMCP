import test from "node:test";
import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { AcmeSupport } from "../src/app.ts";

const ticketInput = { orderId: "ORD-4812", title: "TEST damaged shipment", priority: "high" as const };

test("Acme OpenAPI fixture is standards-valid and describes every application route with schemas and cookie security", async () => {
  const document = new AcmeSupport().openApiDocument() as unknown as Record<string, Record<string, unknown>>;
  await assert.doesNotReject(SwaggerParser.validate(document as never));
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  assert.deepEqual(Object.keys(paths).sort(), ["/api/account", "/api/auth/login", "/api/confirmations", "/api/orders", "/api/orders/{id}", "/api/tickets"]);
  for (const pathItem of Object.values(paths)) for (const operation of Object.values(pathItem)) {
    assert.ok(operation.responses, "every operation declares responses");
  }
  assert.deepEqual(paths["/api/orders/{id}"].get.parameters, [{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  assert.equal((document.components as { securitySchemes: { acmeSession: { in: string; type: string } } }).securitySchemes.acmeSession.in, "cookie");
  assert.equal((document.components as { securitySchemes: { acmeSession: { in: string; type: string } } }).securitySchemes.acmeSession.type, "apiKey");
  assert.ok((paths["/api/tickets"].post.requestBody as Record<string, unknown>).content);
  assert.ok((paths["/api/tickets"].post.responses as Record<string, unknown>)["201"]);
  assert.ok(paths["/api/account"].delete);
});

function confirmTicket(app: AcmeSupport, session: string, input = ticketInput, idempotencyKey = crypto.randomUUID()) {
  const evidence = app.issueConfirmation(session, { toolName: "create_support_ticket", input, idempotencyKey });
  return { evidence, idempotencyKey };
}

test("authenticated agents can search orders and create confirmed tickets", () => {
  const app = new AcmeSupport({ randomId: () => "00000000-0000-4000-8000-000000000001", now: () => Date.parse("2026-08-29T00:00:00.000Z") });
  const session = app.login("agent@example.test", "fixture-password");
  assert.equal(app.searchOrders(session, "ORD-4812")[0]?.id, "ORD-4812");
  const confirmation = confirmTicket(app, session, ticketInput, "ticket-request-0001");
  assert.deepEqual(app.createTicket(session, ticketInput, confirmation.idempotencyKey, confirmation.evidence), {
    ticketId: "TCK-00000000-0000-4000-8000-000000000001", status: "open", priority: "high", createdAt: "2026-08-29T00:00:00.000Z",
  });
});

test("sessions are random, expire, and expired sessions fail closed", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  const app = new AcmeSupport({ now: () => now, sessionTtlMs: 1_000 });
  const first = app.login("agent@example.test", "fixture-password");
  const second = app.login("agent@example.test", "fixture-password");
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
  now += 1_001;
  assert.throws(() => app.searchOrders(first, "ORD-4812"), { code: "AUTH_REQUIRED" });
});

test("ticket creation fails closed for missing, mismatched, expired, and replayed confirmation evidence", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  let id = 0;
  const app = new AcmeSupport({ now: () => now, confirmationTtlMs: 1_000, randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` });
  const session = app.login("agent@example.test", "fixture-password");
  assert.throws(() => app.createTicket(session, ticketInput, "missing-proof-key", ""), { code: "CONFIRMATION_REQUIRED" });

  const mismatched = confirmTicket(app, session, ticketInput, "mismatch-key-0001");
  assert.throws(() => app.createTicket(session, { ...ticketInput, title: "Different title" }, mismatched.idempotencyKey, mismatched.evidence), { code: "CONFIRMATION_INVALID" });

  const wrongKey = confirmTicket(app, session, ticketInput, "bound-key-0001");
  assert.throws(() => app.createTicket(session, ticketInput, "bound-key-0002", wrongKey.evidence), { code: "CONFIRMATION_INVALID" });

  const otherSession = app.login("agent@example.test", "fixture-password");
  const wrongSession = confirmTicket(app, session, ticketInput, "bound-session-key");
  assert.throws(() => app.createTicket(otherSession, ticketInput, wrongSession.idempotencyKey, wrongSession.evidence), { code: "CONFIRMATION_INVALID" });

  const expired = confirmTicket(app, session, ticketInput, "expired-key-0001");
  now += 1_001;
  assert.throws(() => app.createTicket(session, ticketInput, expired.idempotencyKey, expired.evidence), { code: "CONFIRMATION_INVALID" });

  const used = confirmTicket(app, session, ticketInput, "used-key-0001");
  app.createTicket(session, ticketInput, used.idempotencyKey, used.evidence);
  assert.throws(() => app.createTicket(session, ticketInput, "different-key-0001", used.evidence), { code: "CONFIRMATION_INVALID" });
});

test("fixture stores are bounded and sweep expired sessions, confirmations, and idempotency records", () => {
  let now = Date.parse("2026-08-29T00:00:00.000Z");
  const sessions = new AcmeSupport({ now: () => now, sessionTtlMs: 100, maxSessions: 1 });
  const expiredSession = sessions.login("agent@example.test", "fixture-password");
  assert.throws(() => sessions.login("agent@example.test", "fixture-password"), { code: "CAPACITY_EXCEEDED" });
  now += 101;
  const currentSession = sessions.login("agent@example.test", "fixture-password");
  assert.notEqual(currentSession, expiredSession);

  const confirmations = new AcmeSupport({ now: () => now, confirmationTtlMs: 100, maxConfirmations: 1 });
  const confirmationSession = confirmations.login("agent@example.test", "fixture-password");
  confirmations.issueConfirmation(confirmationSession, { toolName: "create_support_ticket", input: ticketInput, idempotencyKey: "capacity-key-0001" });
  assert.throws(() => confirmations.issueConfirmation(confirmationSession, { toolName: "create_support_ticket", input: ticketInput, idempotencyKey: "capacity-key-0002" }), { code: "CAPACITY_EXCEEDED" });
  now += 101;
  assert.doesNotThrow(() => confirmations.issueConfirmation(confirmationSession, { toolName: "create_support_ticket", input: ticketInput, idempotencyKey: "capacity-key-0003" }));

  const idempotency = new AcmeSupport({ now: () => now, idempotencyTtlMs: 100, maxIdempotency: 1, maxTickets: 2 });
  const idempotencySession = idempotency.login("agent@example.test", "fixture-password");
  const first = confirmTicket(idempotency, idempotencySession, ticketInput, "retention-key-0001");
  idempotency.createTicket(idempotencySession, ticketInput, first.idempotencyKey, first.evidence);
  const blocked = confirmTicket(idempotency, idempotencySession, { ...ticketInput, title: "Second ticket" }, "retention-key-0002");
  assert.throws(() => idempotency.createTicket(idempotencySession, { ...ticketInput, title: "Second ticket" }, blocked.idempotencyKey, blocked.evidence), { code: "CAPACITY_EXCEEDED" });
  now += 101;
  const afterSweep = confirmTicket(idempotency, idempotencySession, { ...ticketInput, title: "After sweep" }, "retention-key-0003");
  assert.doesNotThrow(() => idempotency.createTicket(idempotencySession, { ...ticketInput, title: "After sweep" }, afterSweep.idempotencyKey, afterSweep.evidence));
});

test("idempotency returns the original ticket for a duplicate and rejects a conflicting body", () => {
  let id = 0;
  const app = new AcmeSupport({ randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` });
  const session = app.login("agent@example.test", "fixture-password");
  const confirmation = confirmTicket(app, session, ticketInput, "stable-request-key");
  const first = app.createTicket(session, ticketInput, confirmation.idempotencyKey, confirmation.evidence);
  const duplicate = app.createTicket(session, ticketInput, confirmation.idempotencyKey, "already-consumed");
  assert.deepEqual(duplicate, first);
  assert.throws(
    () => app.createTicket(session, { ...ticketInput, title: "Conflicting body" }, confirmation.idempotencyKey, confirmation.evidence),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("fixture rejects malformed payloads, unauthenticated calls, and prohibited actions", () => {
  const app = new AcmeSupport();
  assert.throws(() => app.searchOrders("missing", "ORD-4812"), { code: "AUTH_REQUIRED" });
  const session = app.login("agent@example.test", "fixture-password");
  assert.throws(() => app.issueConfirmation(session, { toolName: "create_support_ticket", input: { ...ticketInput, injected: true }, idempotencyKey: "strict-payload-key" }), { code: "VALIDATION_ERROR" });
  assert.throws(() => app.deleteAccount(session), { code: "HIGH_RISK_ACTION" });
});
