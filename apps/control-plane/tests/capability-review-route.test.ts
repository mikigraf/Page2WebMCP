import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/capabilities/review/route.ts";

test("review endpoint permits an owner to approve a low-risk capability", async () => {
  const response = await POST(new Request("http://test/api/capabilities/review", { method: "POST", headers: { cookie: "page2webmcp_role=owner" }, body: JSON.stringify({ name: "find_order", riskTier: "R0", action: "approve" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: "find_order", status: "reviewed" });
});

test("review endpoint requires an owner for R1 approval and keeps R3 blocked", async () => {
  const editor = await POST(new Request("http://test/api/capabilities/review", { method: "POST", headers: { cookie: "page2webmcp_role=editor" }, body: JSON.stringify({ name: "create_support_ticket", riskTier: "R1", action: "approve" }) }));
  assert.equal(editor.status, 403);
  assert.deepEqual(await editor.json(), { code: "OWNER_APPROVAL_REQUIRED" });

  const r3 = await POST(new Request("http://test/api/capabilities/review", { method: "POST", headers: { cookie: "page2webmcp_role=owner" }, body: JSON.stringify({ name: "delete_account", riskTier: "R3", action: "approve" }) }));
  assert.equal(r3.status, 409);
  assert.deepEqual(await r3.json(), { name: "delete_account", status: "blocked", code: "HIGH_RISK_ACTION" });
});
