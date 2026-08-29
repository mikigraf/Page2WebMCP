import test from "node:test";
import assert from "node:assert/strict";
import { AcmeSupport } from "../../acme-support/src/app";
import { runFixtureSourceHardening, runFixtureWorkflow } from "./workflow.ts";

test("autonomous fixture workflow derives safe tools and blocks high-risk action", () => {
  const result = runFixtureWorkflow(new AcmeSupport(), "https://acme.example");
  assert.deepEqual(result.capabilities.map((capability) => [capability.identity.name, capability.status]), [
    ["find_order", "proposed"], ["get_order_status", "proposed"], ["create_support_ticket", "proposed"], ["delete_account", "blocked"]
  ]);
  assert.match(result.release.code, /find_order/);
  assert.doesNotMatch(result.release.code, /delete_account/);
  assert.equal(
    result.release.manifest.plans.find((plan) => plan.tool.name === "get_order_status")?.annotations.untrusted,
    true
  );
  assert.equal(result.evidence.some((item) => JSON.stringify(item).includes("fixture-password")), false);
});

test("source hardening opens a constrained draft pull request", () => {
  const pr = runFixtureSourceHardening();
  assert.equal(pr.draft, true);
  assert.deepEqual(pr.files, ["app/_page2webmcp/register.generated.ts", "tests/page2webmcp/tools.test.ts", "docs/page2webmcp-security.md"]);
});
