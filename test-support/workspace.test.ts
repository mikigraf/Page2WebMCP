import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import root from "../package.json" with { type: "json" };

const scripts: Readonly<Record<string, string | undefined>> = root.scripts;

function script(name: string): string {
  const command = scripts[name];
  assert.ok(command, `package.json must declare the ${name} script`);
  return command;
}

test("exposes a fully autonomous verification command", () => {
  const command = script("test:all");
  for (const required of [
    "pnpm lint",
    "pnpm security:policy",
    "pnpm typecheck",
    "pnpm test",
    "pnpm test:db:local",
    "pnpm build",
    "pnpm test:e2e"
  ]) assert.match(command, new RegExp(required.replaceAll(":", "\\:")));
});

test("exposes a machine-readable local demo seed command", () => {
  assert.equal(script("demo:seed"), "node scripts/demo-seed.mjs");
});

test("production-live commands load the operator .env without changing provider selection", () => {
  for (const name of ["live:preflight", "live:openapi", "live:website"]) {
    assert.match(script(name), /node --env-file-if-exists=\.env --import=tsx/);
  }
  assert.match(script("live:openapi"), /--provider openapi$/);
  assert.match(script("live:website"), /--provider website$/);
});

test("prints only local demo endpoints and fixture identities", () => {
  const output = execFileSync(process.execPath, ["scripts/demo-seed.mjs"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), {
    controlPlaneUrl: "http://localhost:3100",
    fixtureAppUrl: "http://localhost:3200",
    owner: { email: "owner@example.test", password: "fixture-password" },
    agent: { email: "agent@example.test", password: "fixture-password" }
  });
});
