import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSource, generateHardeningChange } from "./analyze.ts";

test("source analyzer finds secured fixture routes and limits generated output paths", () => {
  const analysis = analyzeSource({
    "app/api/tickets/route.ts": "export async function POST() { return acme.createTicket(session(request), await request.json()); }",
    "app/api/_fixture.ts": "export function session(request) { return request.cookies.get('acme_session'); }"
  });
  assert.equal(analysis.createTicket.authorization, "source_confirmed");
  assert.deepEqual(generateHardeningChange(analysis), ["app/_page2webmcp/register.generated.ts", "tests/page2webmcp/tools.test.ts", "docs/page2webmcp-security.md"]);
});

test("source analyzer ignores comments and refuses a route without real authorization AST evidence", () => {
  const analysis = analyzeSource({
    "app/api/tickets/route.ts": "// createTicket(session(request))\nexport async function POST() { return Response.json({ ok: true }); }",
    "app/api/_fixture.ts": "// request.cookies.get('acme_session')\nexport function session() { return undefined; }"
  });
  assert.equal(analysis.createTicket.authorization, "unknown");
  assert.throws(() => generateHardeningChange(analysis), /AUTHORIZATION_UNCONFIRMED/);
});
