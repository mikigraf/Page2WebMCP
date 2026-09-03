import assert from "node:assert/strict";
import test from "node:test";
import { PartsConsole } from "../src/console.ts";
import { parseOperatorCredentials } from "../src/credentials.ts";

const operator = { email: "operator@beaconworks.dev", password: "example-target-password" };
const reservationInput = { sku: "PC-1180", quantity: 2, orderReference: "SO-77120", confirmed: true as const };

function consoleAt(overrides: Partial<ConstructorParameters<typeof PartsConsole>[0]> = {}) {
  return new PartsConsole({
    operator,
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    randomId: () => "00000000-0000-4000-8000-000000000001",
    ...overrides,
  });
}

function confirmed(app: PartsConsole, session: string, idempotencyKey = "reserve-request-0001", input: unknown = reservationInput) {
  const evidence = app.issueConfirmation(session, { toolName: "reserve_part_stock", input, idempotencyKey });
  return { evidence, idempotencyKey };
}

test("operator credentials come from configuration and are rejected when absent or too weak", () => {
  assert.deepEqual(parseOperatorCredentials({
    PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_EMAIL: operator.email,
    PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_PASSWORD: operator.password,
  }), operator);
  assert.equal(parseOperatorCredentials({}), null);
  assert.equal(parseOperatorCredentials({
    PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_EMAIL: operator.email,
    PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_PASSWORD: "short",
  }), null);
});

test("login succeeds for configured credentials and fails closed otherwise", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  assert.match(session, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(app.login(operator.email, operator.password), session);
  assert.throws(() => app.login(operator.email, "wrong-password-value"), { code: "AUTH_REQUIRED" });
  assert.throws(() => app.login("intruder@beaconworks.dev", operator.password), { code: "AUTH_REQUIRED" });
  assert.throws(() => new PartsConsole({ operator: null }).login(operator.email, operator.password), { code: "AUTH_REQUIRED" });
});

test("every read is gated on an unexpired session", () => {
  let now = Date.parse("2026-09-01T00:00:00.000Z");
  const app = new PartsConsole({ operator, now: () => now, sessionTtlMs: 1_000 });
  const session = app.login(operator.email, operator.password);
  assert.equal(app.listParts(session, "PC-1180")[0]?.sku, "PC-1180");
  assert.equal(app.getPart(session, "PC-1180").available, 12);
  assert.equal(app.isAuthenticated(session), true);
  now += 1_001;
  assert.equal(app.isAuthenticated(session), false);
  assert.throws(() => app.listParts(session, "PC-1180"), { code: "AUTH_REQUIRED" });
  assert.throws(() => app.getPart(session, "PC-1180"), { code: "AUTH_REQUIRED" });
  assert.throws(() => app.getReservation(session, "RSV-1"), { code: "AUTH_REQUIRED" });
  assert.throws(() => app.listParts("", "PC-1180"), { code: "AUTH_REQUIRED" });
});

test("a part read exposes supplier notes as untrusted content and never hides the authoritative counts", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  const part = app.getPart(session, "PC-1180");
  assert.equal(part.untrustedContent, true);
  assert.equal(part.onHand - part.reserved, part.available);
  assert.throws(() => app.getPart(session, "PC-9999"), { code: "NOT_FOUND" });
});

test("reserving stock requires explicit confirmation and applies exactly one effect", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  assert.throws(() => app.reserve(session, reservationInput, "reserve-request-0001", null), { code: "CONFIRMATION_REQUIRED" });
  assert.throws(
    () => app.reserve(session, { ...reservationInput, confirmed: false }, "reserve-request-0001", "cnf_x"),
    { code: "CONFIRMATION_REQUIRED" },
  );
  const { evidence, idempotencyKey } = confirmed(app, session);
  const reservation = app.reserve(session, reservationInput, idempotencyKey, evidence);
  assert.deepEqual(reservation, {
    reservationId: "RSV-00000000-0000-4000-8000-000000000001",
    sku: "PC-1180",
    quantity: 2,
    orderReference: "SO-77120",
    status: "reserved",
    reversible: true,
    effectCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(app.getPart(session, "PC-1180").available, 10);
  assert.equal(app.getPart(session, "PC-1180").reserved, 2);
});

test("a replayed confirmation token returns the same reservation without a second effect", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  const { evidence, idempotencyKey } = confirmed(app, session);
  const first = app.reserve(session, reservationInput, idempotencyKey, evidence);
  const replay = app.reserve(session, reservationInput, idempotencyKey, evidence);
  assert.deepEqual(replay, first);
  assert.equal(replay.effectCount, 1);
  assert.equal(app.getPart(session, "PC-1180").available, 10);
  assert.equal(app.listReservations(session).length, 1);
});

test("confirmation evidence is single-use, session-bound, fingerprint-bound, and expiring", () => {
  let now = Date.parse("2026-09-01T00:00:00.000Z");
  const app = new PartsConsole({ operator, now: () => now, confirmationTtlMs: 1_000 });
  const session = app.login(operator.email, operator.password);
  const other = app.login(operator.email, operator.password);
  const first = confirmed(app, session, "reserve-request-0100");
  app.reserve(session, reservationInput, first.idempotencyKey, first.evidence);
  const second = confirmed(app, session, "reserve-request-0200");
  assert.throws(() => app.reserve(session, reservationInput, second.idempotencyKey, first.evidence), { code: "CONFIRMATION_INVALID" });
  assert.throws(() => app.reserve(other, reservationInput, second.idempotencyKey, second.evidence), { code: "CONFIRMATION_INVALID" });
  assert.throws(
    () => app.reserve(session, { ...reservationInput, quantity: 3 }, second.idempotencyKey, second.evidence),
    { code: "CONFIRMATION_INVALID" },
  );
  const third = confirmed(app, session, "reserve-request-0300");
  now += 1_001;
  assert.throws(() => app.reserve(session, reservationInput, third.idempotencyKey, third.evidence), { code: "CONFIRMATION_INVALID" });
});

test("a reused idempotency key with different input is a conflict, and keys are bounded", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  const { evidence, idempotencyKey } = confirmed(app, session);
  app.reserve(session, reservationInput, idempotencyKey, evidence);
  assert.throws(
    () => app.reserve(session, { ...reservationInput, quantity: 1 }, idempotencyKey, evidence),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.throws(() => app.reserve(session, reservationInput, "short", evidence), { code: "IDEMPOTENCY_REQUIRED" });
  assert.throws(() => app.reserve(session, reservationInput, null, evidence), { code: "IDEMPOTENCY_REQUIRED" });
});

test("a reservation is reversible and the reversal is idempotent", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  const { evidence, idempotencyKey } = confirmed(app, session);
  const reservation = app.reserve(session, reservationInput, idempotencyKey, evidence);
  const released = app.release(session, reservation.reservationId);
  assert.equal(released.status, "released");
  assert.equal(released.releasedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(app.getPart(session, "PC-1180").available, 12);
  assert.deepEqual(app.release(session, reservation.reservationId), released);
  assert.equal(app.getPart(session, "PC-1180").available, 12);
  assert.throws(() => app.release(session, "RSV-missing"), { code: "NOT_FOUND" });
});

test("the authoritative final state is readable back from the target", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  const { evidence, idempotencyKey } = confirmed(app, session);
  const reservation = app.reserve(session, reservationInput, idempotencyKey, evidence);
  assert.deepEqual(app.getReservation(session, reservation.reservationId), {
    reservationId: reservation.reservationId,
    sku: "PC-1180",
    quantity: 2,
    orderReference: "SO-77120",
    status: "reserved",
    createdAt: "2026-09-01T00:00:00.000Z",
    releasedAt: "",
  });
  assert.throws(() => app.getReservation(session, "RSV-missing"), { code: "NOT_FOUND" });
});

test("reservation input is schema validated and stock is never oversold", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  const invalid: unknown[] = [
    null,
    [],
    "reserve",
    { ...reservationInput, sku: "" },
    { ...reservationInput, quantity: 0 },
    { ...reservationInput, quantity: 2.5 },
    { ...reservationInput, quantity: "2" },
    { ...reservationInput, orderReference: "x" },
    { ...reservationInput, extra: true },
    { sku: "PC-1180", quantity: 2, confirmed: true },
  ];
  for (const value of invalid) {
    assert.throws(() => app.issueConfirmation(session, { toolName: "reserve_part_stock", input: value, idempotencyKey: "reserve-request-0001" }), { code: "VALIDATION_ERROR" });
  }
  assert.throws(
    () => app.issueConfirmation(session, { toolName: "delete_everything", input: reservationInput, idempotencyKey: "reserve-request-0001" }),
    { code: "VALIDATION_ERROR" },
  );
  assert.throws(
    () => app.issueConfirmation(session, { toolName: "reserve_part_stock", input: { ...reservationInput, sku: "PC-9999" }, idempotencyKey: "reserve-request-0001" }),
    { code: "NOT_FOUND" },
  );
  const oversell = { sku: "PC-2245", quantity: 9, orderReference: "SO-77121", confirmed: true as const };
  const { evidence, idempotencyKey } = confirmed(app, session, "reserve-request-9000", oversell);
  assert.throws(() => app.reserve(session, oversell, idempotencyKey, evidence), { code: "INSUFFICIENT_STOCK" });
});

test("destructive account deletion stays blocked for authenticated operators", () => {
  const app = consoleAt();
  const session = app.login(operator.email, operator.password);
  assert.throws(() => app.deleteAccount(session), { code: "HIGH_RISK_ACTION" });
  assert.throws(() => app.deleteAccount(""), { code: "AUTH_REQUIRED" });
});

test("in-memory state is bounded by capacity limits", () => {
  const app = new PartsConsole({ operator, maxSessions: 1, maxConfirmations: 1, maxIdempotency: 1, maxReservations: 1 });
  const session = app.login(operator.email, operator.password);
  assert.throws(() => app.login(operator.email, operator.password), { code: "CAPACITY_EXCEEDED" });
  app.issueConfirmation(session, { toolName: "reserve_part_stock", input: reservationInput, idempotencyKey: "reserve-request-0001" });
  assert.throws(
    () => app.issueConfirmation(session, { toolName: "reserve_part_stock", input: reservationInput, idempotencyKey: "reserve-request-0002" }),
    { code: "CAPACITY_EXCEEDED" },
  );
});
