import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

test("Acme has no independent mutable release route", async () => {
  await assert.rejects(access(new URL("../app/api/releases/acme/route.ts", import.meta.url)));
});
