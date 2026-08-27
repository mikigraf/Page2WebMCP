import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("control plane is a TypeScript Next App Router application with an analysis endpoint", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/projects/analyze/route.ts", import.meta.url), "utf8");
  assert.match(page, /Page2WebMCP/);
  assert.match(route, /runFixtureWorkflow/);
});
