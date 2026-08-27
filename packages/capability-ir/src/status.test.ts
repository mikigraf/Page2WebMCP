import test from "node:test";
import assert from "node:assert/strict";
import { CapabilityIRSchema, createCapability, transitionCapability } from "./status.ts";

test("R3 capabilities remain blocked", () => {
  const capability = createCapability("delete_account", "R3", false);
  assert.equal(transitionCapability(capability, "review_approved").status, "blocked");
});

test("production requires all deterministic gates", () => {
  const capability = createCapability("find_order", "R0", true);
  assert.equal(transitionCapability(capability, "publish_requested").status, "proposed");
  const verified = transitionCapability(capability, "verification_passed");
  assert.equal(transitionCapability(verified, "publish_requested").status, "production_ready");
});

test("CapabilityIR rejects unknown fields at runtime", () => {
  const capability = createCapability("find_order", "R0", true);
  assert.throws(() => CapabilityIRSchema.parse({ ...capability, untrustedExtra: true }));
  assert.deepEqual(CapabilityIRSchema.parse(capability), capability);
});
