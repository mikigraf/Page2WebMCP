import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

const ORIGIN = "http://127.0.0.1:3300";
const HOST = "127.0.0.1:3300";
const EMAIL = "operator@beaconworks.dev";
const PASSWORD = "example-target-password";

process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_EMAIL = EMAIL;
process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_PASSWORD = PASSWORD;

const { POST: login } = await import("../app/api/auth/login/route.ts");
const { GET: listParts } = await import("../app/api/parts/route.ts");
const { GET: getPart } = await import("../app/api/parts/[sku]/route.ts");
const { POST: createConfirmation } = await import("../app/api/confirmations/route.ts");
const { POST: createReservation } = await import("../app/api/reservations/route.ts");
const { partsConsole } = await import("../app/api/_runtime.ts");
const { GET: getReservation, DELETE: releaseReservation } = await import("../app/api/reservations/[id]/route.ts");
const { DELETE: deleteAccount } = await import("../app/api/account/route.ts");
const { GET: openApiDocument } = await import("../app/openapi.json/route.ts");

type Headers = Record<string, string>;

function request(path: string, init: { method?: string; headers?: Headers; body?: string } = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: { host: HOST, ...init.headers },
    body: init.body,
  });
}

function mutation(path: string, cookie: string, body: unknown, headers: Headers = {}): NextRequest {
  return request(path, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie, ...headers },
    body: JSON.stringify(body),
  });
}

async function authenticate(): Promise<string> {
  const response = await login(mutation("/api/auth/login", "", { email: EMAIL, password: PASSWORD }));
  assert.equal(response.status, 200);
  const value = response.cookies.get("parts_console_session")?.value;
  assert.ok(value, "login sets a session cookie");
  return `parts_console_session=${value}`;
}

test("login fails closed for wrong credentials and never sets a session cookie", async () => {
  const response = await login(mutation("/api/auth/login", "", { email: EMAIL, password: "wrong-password-value" }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: "AUTH_REQUIRED" });
  assert.deepEqual(response.headers.getSetCookie(), []);
});

test("login issues a hardened, bounded session cookie", async () => {
  const response = await login(mutation("/api/auth/login", "", { email: EMAIL, password: PASSWORD }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  const [cookie] = response.headers.getSetCookie();
  assert.match(cookie, /^parts_console_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=strict/i);
  assert.match(cookie, /Max-Age=1800/i);
  assert.match(cookie, /Path=\//i);
  assert.ok(!cookie.includes(PASSWORD));
});

test("mutation routes require a same-origin request", async () => {
  const handlers = [
    ["/api/auth/login", login],
    ["/api/confirmations", createConfirmation],
    ["/api/reservations", createReservation],
  ] as const;
  for (const [path, handler] of handlers) {
    const response = await handler(new NextRequest(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { host: HOST, origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { code: "ORIGIN_MISMATCH" });
  }
});

test("mutation routes bound the request body", async () => {
  const response = await login(mutation("/api/auth/login", "", { email: "x".repeat(20_000), password: PASSWORD }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { code: "PAYLOAD_TOO_LARGE" });
});

test("the authenticated read is gated and served no-store", async () => {
  const anonymous = await listParts(request("/api/parts?q=PC-1180"));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("cache-control"), "no-store");
  assert.deepEqual(await anonymous.json(), { code: "AUTH_REQUIRED" });

  const cookie = await authenticate();
  const authenticated = await listParts(request("/api/parts?q=PC-1180", { headers: { cookie } }));
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.headers.get("cache-control"), "no-store");
  const parts = await authenticated.json() as Array<{ sku: string }>;
  assert.equal(parts[0]?.sku, "PC-1180");
});

test("a confirmed reservation applies exactly one reversible effect and reads back authoritatively", async () => {
  const cookie = await authenticate();
  const before = await (await getPart(request("/api/parts/PC-1180", { headers: { cookie } }), { params: Promise.resolve({ sku: "PC-1180" }) })).json() as { available: number };
  const input = { sku: "PC-1180", quantity: 1, orderReference: "SO-90001", confirmed: true };
  const idempotencyKey = "reserve-route-0001";

  const requestToken = partsConsole().requestToken(cookie.split("=")[1]!)!;
  const unconfirmed = await createReservation(mutation("/api/reservations", cookie, input,
    { "idempotency-key": idempotencyKey, "x-csrf-token": requestToken }));
  assert.equal(unconfirmed.status, 403);
  assert.deepEqual(await unconfirmed.json(), { code: "CONFIRMATION_REQUIRED" });

  const confirmation = await createConfirmation(mutation("/api/confirmations", cookie, {
    toolName: "reserve_part_stock", input, idempotencyKey,
  }));
  assert.equal(confirmation.status, 201);
  const { evidence } = await confirmation.json() as { evidence: string };

  const headers = { "idempotency-key": idempotencyKey, "x-page2webmcp-confirmation": evidence, "x-csrf-token": requestToken };
  const created = await createReservation(mutation("/api/reservations", cookie, input, headers));
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const reservation = await created.json() as { reservationId: string; effectCount: number; reversible: boolean };
  assert.equal(reservation.effectCount, 1);
  assert.equal(reservation.reversible, true);

  const replay = await createReservation(mutation("/api/reservations", cookie, input, headers));
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), reservation);

  const params = { params: Promise.resolve({ id: reservation.reservationId }) };
  const finalState = await getReservation(request(`/api/reservations/${reservation.reservationId}`, { headers: { cookie } }), params);
  assert.equal(finalState.status, 200);
  const state = await finalState.json() as Record<string, unknown>;
  assert.deepEqual(state, {
    reservationId: reservation.reservationId,
    sku: "PC-1180",
    quantity: 1,
    orderReference: "SO-90001",
    status: "reserved",
    createdAt: state.createdAt,
    releasedAt: null,
  });
  assert.match(String(state.createdAt), /^\d{4}-\d{2}-\d{2}T/);

  const after = await (await getPart(request("/api/parts/PC-1180", { headers: { cookie } }), { params: Promise.resolve({ sku: "PC-1180" }) })).json() as { available: number };
  assert.equal(after.available, before.available - 1);

  const released = await releaseReservation(
    request(`/api/reservations/${reservation.reservationId}`, { method: "DELETE", headers: { cookie, origin: ORIGIN } }),
    { params: Promise.resolve({ id: reservation.reservationId }) },
  );
  assert.equal(released.status, 200);
  assert.equal((await released.json() as { status: string }).status, "released");
  const restored = await (await getPart(request("/api/parts/PC-1180", { headers: { cookie } }), { params: Promise.resolve({ sku: "PC-1180" }) })).json() as { available: number };
  assert.equal(restored.available, before.available);
});

test("the reversal route is same-origin gated and authenticated", async () => {
  const cookie = await authenticate();
  const crossOrigin = await releaseReservation(
    request("/api/reservations/RSV-missing", { method: "DELETE", headers: { cookie, origin: "https://evil.example" } }),
    { params: Promise.resolve({ id: "RSV-missing" }) },
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { code: "ORIGIN_MISMATCH" });

  const anonymous = await releaseReservation(
    request("/api/reservations/RSV-missing", { method: "DELETE", headers: { origin: ORIGIN } }),
    { params: Promise.resolve({ id: "RSV-missing" }) },
  );
  assert.equal(anonymous.status, 401);
});

test("account deletion stays blocked with a stable error code", async () => {
  const cookie = await authenticate();
  const response = await deleteAccount(request("/api/account", { method: "DELETE", headers: { cookie, origin: ORIGIN } }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: "HIGH_RISK_ACTION" });
});

test("the OpenAPI document is served as JSON without credentials", async () => {
  const response = openApiDocument();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(response.headers.getSetCookie(), []);
  const document = await response.json() as { openapi: string };
  assert.equal(document.openapi, "3.1.0");
});
