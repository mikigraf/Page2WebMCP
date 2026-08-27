import test from "node:test";
import assert from "node:assert/strict";
import { runAutonomousDemo } from "../test-support/demo.ts";

test("end-to-end URL-to-WebMCP journey executes a confirmed R1 tool and preserves safety gates", async () => {
  const result = await runAutonomousDemo();
  assert.equal(result.discovery.executedMutationDuringDiscovery, false);
  assert.equal(result.release.published, true);
  assert.deepEqual(result.toolResult, { ticketId: "TCK-1001", status: "open", priority: "high", createdAt: "2026-08-26T00:00:00.000Z" });
  assert.equal(result.confirmationCount, 1);
  assert.equal(result.blockedCapability, "delete_account");
  assert.equal(result.artifact.includes("fixture-password"), false);
});
