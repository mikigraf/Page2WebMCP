import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/check-production-live-preflight.ts", import.meta.url));

function environment(): Record<string, string> {
  return {
    DATABASE_URL:
      "postgresql://app:password@db.bimqgiedckdurqiywctl.supabase.co:5432/postgres?sslmode=require",
    PAGE2WEBMCP_MAINTENANCE_DATABASE_URL:
      "postgresql://maintenance:password@db.bimqgiedckdurqiywctl.supabase.co:5432/postgres?sslmode=require",
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.widgets.dev",
    PAGE2WEBMCP_SUPABASE_URL: "https://bimqgiedckdurqiywctl.supabase.co",
    PAGE2WEBMCP_SUPABASE_SECRET_KEY: `sb_secret_${"s".repeat(32)}`,
    PAGE2WEBMCP_PUBLIC_ORIGIN:
      "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.widgets.dev",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: `verifier_${"v".repeat(32)}`,
    PAGE2WEBMCP_GIT_COMMIT_SHA: "c".repeat(40),
    PAGE2WEBMCP_APPLICATION_RELEASE_ID: "page2webmcp-2026_09_01-rc1",
    PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE: "/secure/page2webmcp-operator.json",
    PAGE2WEBMCP_RECEIPT_SIGNING_KEY: `receipt_signing_${"k".repeat(32)}`,
    PAGE2WEBMCP_PROVIDER_MODE: "openapi",
    PAGE2WEBMCP_E2E_SOURCE_URL: "https://specs.widgets.dev/openapi.json",
    PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN: "https://staging.widgets.dev",
    PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL: "https://staging.widgets.dev/test",
    PAGE2WEBMCP_E2E_INSTALL_PAGE_URL: "https://staging.widgets.dev/install",
    PAGE2WEBMCP_E2E_ENVIRONMENT: "production",
  };
}

async function spawn(args: string[], overrides: Record<string, string | undefined> = {}) {
  const runtimeArgs = (process.versions as Record<string, string | undefined>).bun
    ? [script, ...args]
    : ["--import", "tsx", script, ...args];
  return run(process.execPath, runtimeArgs, {
    cwd: root,
    env: { PATH: process.env.PATH, NODE_ENV: "test", ...environment(), ...overrides },
  });
}

test("preflight CLI accepts only exact mode/provider arguments and prints one secret-free JSON object", async () => {
  const success = await spawn(["--dry-run", "--provider", "openapi"]);
  const lines = success.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]!);
  assert.equal(output.journey, "openapi");
  assert.equal(output.mode, "dry-run");
  assert.equal(output.liveSuccess, false);
  assert.doesNotMatch(success.stdout, /password|sb_secret_|verifier_/);

  await assert.rejects(spawn(["--dry-run", "--live", "--provider", "openapi"]), (error: unknown) => {
    const failure = error as { code: number; stdout: string };
    assert.equal(failure.code, 2);
    assert.equal(failure.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(failure.stdout).code, "PRODUCTION_LIVE_ARGUMENTS_INVALID");
    return true;
  });
});

test("preflight CLI reports every invalid name, exits nonzero, and live preflight never claims success", async () => {
  await assert.rejects(spawn(["--dry-run", "--provider", "openapi"], {
    DATABASE_URL: "",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "",
  }), (error: unknown) => {
    const failure = error as { code: number; stdout: string };
    assert.equal(failure.code, 1);
    assert.deepEqual(JSON.parse(failure.stdout).missingControls, [
      "DATABASE_URL",
      "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
    ]);
    return true;
  });

  const live = await spawn(["--live", "--provider", "openapi"]);
  const output = JSON.parse(live.stdout);
  assert.equal(output.code, "PRODUCTION_LIVE_READY_TO_EXECUTE");
  assert.equal(output.liveSuccess, false);
});
