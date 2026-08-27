import test from "node:test";
import assert from "node:assert/strict";
import { mergeEvidence } from "./fusion.ts";

test("evidence fusion blocks conflicting authentication or effects", () => {
  assert.deepEqual(mergeEvidence([{ source: "runtime", authentication: "same_origin_cookie", effects: "read" }, { source: "openapi", authentication: "same_origin_cookie", effects: "read" }]).status, "consistent");
  assert.deepEqual(mergeEvidence([{ source: "runtime", authentication: "same_origin_cookie", effects: "read" }, { source: "source", authentication: "server_secret", effects: "write" }]).status, "conflict");
});
