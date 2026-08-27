import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRelease } from "./verify.ts";

test("release evaluator requires all production gates and rejects unsafe selection scores", () => {
  assert.equal(evaluateRelease({ schema: true, authenticated: true, replayPasses: 3, noSecretLeakage: true, browserExecution: true, selectionScore: 18 }).eligible, true);
  assert.equal(evaluateRelease({ schema: true, authenticated: true, replayPasses: 2, noSecretLeakage: true, browserExecution: true, selectionScore: 20 }).eligible, false);
});
