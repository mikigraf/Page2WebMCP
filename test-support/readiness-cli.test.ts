import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = new URL("../", import.meta.url).pathname;
const node = "/usr/local/bin/node";
const tsx = "/Users/miki/Cloudsail-Development/runmill/node_modules/tsx/dist/cli.mjs";

test("release readiness CLI passes hermetic gates without claiming live success", async () => {
  const result = await run(node, [tsx, "scripts/check-release-readiness.ts", "--hermetic"], { cwd: root });
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, { status: "passed", code: "HERMETIC_READINESS_PASSED", liveSuccess: false });
});

test("release readiness CLI explicitly skips live checks when controls are absent", async () => {
  await assert.rejects(run(node, [tsx, "scripts/check-release-readiness.ts", "--live"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "test", PATH: process.env.PATH ?? "",
      PAGE2WEBMCP_STORAGE_MODE: undefined, DATABASE_URL: undefined,
      PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: undefined, PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: undefined },
  }), (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 2);
    assert.deepEqual(JSON.parse(failure.stdout ?? "{}"), {
      status: "skipped",
      code: "LIVE_CONTROLS_REQUIRED",
      liveSuccess: false,
    });
    return true;
  });
});
