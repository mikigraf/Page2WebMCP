import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Acme fixture is a TypeScript Next App Router application", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(layout, /<html lang="en">/);
  assert.match(page, /Acme Support Console/);
});
