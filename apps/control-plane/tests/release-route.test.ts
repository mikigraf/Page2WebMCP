import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/releases/publish/route.ts";

test("release route denies incomplete verification and permits an owner-complete report", async () => {
  const denied = await POST(new Request("http://test", { method: "POST", headers: { cookie: "page2webmcp_role=owner" }, body: JSON.stringify({ report: { schema: true, authenticated: true, replayPasses: 2, noSecretLeakage: true, browserExecution: true, selectionScore: 20 } }) }));
  assert.equal(denied.status, 409);
  const published = await POST(new Request("http://test", { method: "POST", headers: { cookie: "page2webmcp_role=owner" }, body: JSON.stringify({ report: { schema: true, authenticated: true, replayPasses: 3, noSecretLeakage: true, browserExecution: true, selectionScore: 20 } }) }));
  assert.equal(published.status, 201);
});
