import test from "node:test";
import assert from "node:assert/strict";
import root from "../package.json" with { type: "json" };

test("exposes a fully autonomous verification command", () => {
  assert.equal(root.scripts["test:all"], "pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e");
});
