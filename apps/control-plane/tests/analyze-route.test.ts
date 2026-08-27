import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/projects/analyze/route.ts";

type AnalysisCapability = { identity: { name: string }; status: string };
type AnalysisBody = { sourceType: string; capabilities?: AnalysisCapability[]; draftPullRequest?: { draft: boolean } };

for (const sourceType of ["website", "openapi", "github"] as const) {
  test(`analysis produces a safe result for the ${sourceType} path`, async () => {
    const response = await POST(new Request("http://test/api/projects/analyze", { method: "POST", body: JSON.stringify({ sourceType }) }));
    assert.equal(response.status, 200);
    const body = await response.json() as AnalysisBody;
    assert.equal(body.sourceType, sourceType);
    if (sourceType === "github") {
      assert.equal(body.draftPullRequest?.draft, true);
    } else {
      assert.deepEqual(body.capabilities?.map((capability) => [capability.identity.name, capability.status]), [
        ["find_order", "proposed"],
        ["get_order_status", "proposed"],
        ["create_support_ticket", "proposed"],
        ["delete_account", "blocked"]
      ]);
    }
  });
}

test("analysis rejects an unrecognized source path", async () => {
  const response = await POST(new Request("http://test/api/projects/analyze", { method: "POST", body: JSON.stringify({ sourceType: "unknown" }) }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: "INVALID_SOURCE_TYPE" });
});
