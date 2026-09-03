import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

const EMAIL = "operator@beaconworks.dev";
const PASSWORD = "example-target-password";
process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_EMAIL = EMAIL;
process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_PASSWORD = PASSWORD;

const { partsConsole, SESSION_COOKIE } = await import("../app/api/_runtime.ts");
const { GET: listReservations } = await import("../app/api/reservations/route.ts");

const ORIGIN = "https://target.example";

function request(cookie: string): NextRequest {
  return new NextRequest(`${ORIGIN}/api/reservations`, {
    headers: { host: "target.example", cookie },
  });
}

test("reservations are readable back, so a mutation's own reference can be observed", async () => {
  const session = partsConsole().login(EMAIL, PASSWORD);
  const anonymous = await listReservations(request("nothing=1"));
  assert.equal(anonymous.status, 401, "the listing is authenticated");

  const empty = await listReservations(request(`${SESSION_COOKIE}=${session}`));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);
});

test("the listing is declared in the API description within the supported subset", async () => {
  const { openApiDocument } = await import("../src/openapi.ts");
  const operation = (openApiDocument().paths as Record<string, Record<string, unknown>>)["/api/reservations"].get;
  assert.ok(operation, "GET /api/reservations is described");
  const serialized = JSON.stringify(operation);
  assert.doesNotMatch(serialized, /"const"|"format"/, "no unsupported schema keywords");
});
