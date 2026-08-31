import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const commonEnvironment = [
  "DATABASE_URL",
  "PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN",
  "PAGE2WEBMCP_E2E_LIVE_INSTALLATION",
  "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL",
  "PAGE2WEBMCP_PROVIDER_MODE",
  "PAGE2WEBMCP_PUBLIC_ORIGIN",
  "PAGE2WEBMCP_READINESS_RELEASE_HASH",
  "PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN",
  "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
  "PAGE2WEBMCP_STORAGE_MODE",
] as const;

const websiteEnvironment = [
  "PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN", "PAGE2WEBMCP_AUTH_HANDOFF_TOKEN",
  "PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN", "PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN",
  "PAGE2WEBMCP_BROWSER_USE_API_KEY", "PAGE2WEBMCP_BROWSER_USE_API_ORIGIN",
  "PAGE2WEBMCP_CDP_OBSERVER_ORIGIN", "PAGE2WEBMCP_CDP_OBSERVER_TOKEN",
  "PAGE2WEBMCP_EGRESS_POLICY_ORIGIN", "PAGE2WEBMCP_EGRESS_POLICY_TOKEN",
  "PAGE2WEBMCP_EGRESS_PROXY_ORIGIN", "PAGE2WEBMCP_EGRESS_PROXY_TOKEN",
  "PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN", "PAGE2WEBMCP_EVIDENCE_STORE_TOKEN",
  "PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN", "PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN",
  "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID", "PAGE2WEBMCP_SECRET_STORE_ORIGIN",
  "PAGE2WEBMCP_SECRET_STORE_TOKEN",
] as const;
const githubEnvironment = [
  "PAGE2WEBMCP_GITHUB_APP_ID",
  "PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64",
  "PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS",
  "PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN",
  "PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN",
] as const;

const providerMode = process.env.PAGE2WEBMCP_PROVIDER_MODE;
const providerEnvironment = providerMode === "website"
  ? websiteEnvironment
  : providerMode === "github"
    ? githubEnvironment
    : [];
const missingEnvironment = [...commonEnvironment, ...providerEnvironment].filter((name) => {
  const value = process.env[name];
  if (!value) return true;
  if (name === "PAGE2WEBMCP_E2E_LIVE_INSTALLATION") return value !== "true";
  if (name === "PAGE2WEBMCP_PROVIDER_MODE") return !["openapi", "website", "github"].includes(value);
  if (name === "PAGE2WEBMCP_STORAGE_MODE") return value !== "postgres";
  return false;
}).sort();

test("production readiness accepts only a real selected native installation and hosted bytes", {
  skip: missingEnvironment.length > 0
    ? `LIVE_CONTROLS_REQUIRED: ${missingEnvironment.join(",")}`
    : false,
  timeout: 120_000,
}, async (context) => {
  assert.equal(process.env.PAGE2WEBMCP_LOCAL_STACK, undefined);
  const publicOrigin = exactHostedStoragePrefix(process.env.PAGE2WEBMCP_PUBLIC_ORIGIN!);
  const contentHash = process.env.PAGE2WEBMCP_READINESS_RELEASE_HASH!;
  assert.match(contentHash, /^[a-f0-9]{64}$/);

  const result = await run(process.execPath, [tsx, "scripts/check-release-readiness.ts", "--live"], {
    cwd: root,
    env: { ...process.env, PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN: undefined },
    timeout: 90_000,
    maxBuffer: 256 * 1_024,
  });
  const readiness = JSON.parse(result.stdout) as { status?: unknown; code?: unknown; liveSuccess?: unknown };
  assert.deepEqual(readiness, {
    status: "passed",
    code: "LIVE_READINESS_PASSED",
    liveSuccess: true,
  });

  const artifactUrl = `${publicOrigin}/${contentHash}.js`;
  const response = await fetch(artifactUrl, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.url, artifactUrl);
  assert.equal(response.redirected, false);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 65_536);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), contentHash);
  const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  context.diagnostic(JSON.stringify({
    code: "LIVE_NATIVE_INSTALLATION_EVIDENCE",
    providerMode,
    artifactUrl,
    contentHash,
    integrity,
    liveSuccess: true,
  }));
});

function exactHostedStoragePrefix(value: string): string {
  const expected = "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
  assert.equal(value, expected);
  const url = new URL(value);
  assert.equal(url.protocol, "https:");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  return value;
}
