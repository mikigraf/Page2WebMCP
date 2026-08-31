import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { runProductionWorker } from "./main.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const main = "apps/worker/src/main.ts";

const websiteMissingEnvironment = [
  "PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN",
  "PAGE2WEBMCP_AUTH_HANDOFF_TOKEN",
  "PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN",
  "PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN",
  "PAGE2WEBMCP_BROWSER_USE_API_KEY",
  "PAGE2WEBMCP_BROWSER_USE_API_ORIGIN",
  "PAGE2WEBMCP_CDP_OBSERVER_ORIGIN",
  "PAGE2WEBMCP_CDP_OBSERVER_TOKEN",
  "PAGE2WEBMCP_EGRESS_POLICY_ORIGIN",
  "PAGE2WEBMCP_EGRESS_POLICY_TOKEN",
  "PAGE2WEBMCP_EGRESS_PROXY_ORIGIN",
  "PAGE2WEBMCP_EGRESS_PROXY_TOKEN",
  "PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN",
  "PAGE2WEBMCP_EVIDENCE_STORE_TOKEN",
  "PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN",
  "PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN",
  "PAGE2WEBMCP_PUBLIC_ORIGIN",
  "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID",
  "PAGE2WEBMCP_SECRET_STORE_ORIGIN",
  "PAGE2WEBMCP_SECRET_STORE_TOKEN",
] as const;

test("actual provider construction precedes repository creation and the exact instance is reused", async () => {
  const order: string[] = [];
  const repository = new InMemoryControlPlaneRepository();
  const provider = {
    analysisSourceTypes: ["openapi"] as const,
    provenance: {
      mode: "openapi" as const,
      adapter: "bounded-openapi" as const,
      adapterVersion: 1 as const,
      fixture: false as const,
    },
    analyze: async () => ({ capabilities: [], diagnostics: [], evidence: [] }),
  };
  await runProductionWorker({ PAGE2WEBMCP_PROVIDER_MODE: "openapi" }, {
    signal: AbortSignal.abort(),
    constructProvider: () => { order.push("provider"); return provider; },
    validateConfiguration: () => { order.push("configuration"); },
    getRepository: () => { order.push("repository"); return repository; },
    createRuntime: (_repository, actualProvider) => {
      order.push("runtime");
      assert.equal(actualProvider, provider);
      return {
        analyze: actualProvider.analyze,
        analysisSourceTypes: actualProvider.analysisSourceTypes,
        providerProvenance: actualProvider.provenance,
      };
    },
    registerObservability: async () => { order.push("observability"); },
    shutdownObservability: async () => { order.push("observability-close"); },
    closeRepository: async () => { order.push("repository-close"); },
  });
  assert.deepEqual(order, [
    "provider", "configuration", "repository", "runtime", "observability",
    "repository-close", "observability-close",
  ]);
});

test("website controls fail startup with sorted operator key names before repository construction", async () => {
  const failure = await runFailure({
    PAGE2WEBMCP_PROVIDER_MODE: "website",
    DATABASE_URL: "postgresql://must-not-connect.invalid/page2webmcp",
  });
  assert.deepEqual(failure, {
    code: "WEBSITE_LIVE_CONFIGURATION_REQUIRED",
    missingEnvironment: websiteMissingEnvironment,
  });
});

test("GitHub controls fail startup with exact names and no fabricated provider", async () => {
  const failure = await runFailure({
    PAGE2WEBMCP_PROVIDER_MODE: "github",
    DATABASE_URL: "postgresql://must-not-connect.invalid/page2webmcp",
  });
  assert.deepEqual(failure, {
    code: "GITHUB_LIVE_CONFIGURATION_REQUIRED",
    missingEnvironment: [
      "PAGE2WEBMCP_GITHUB_APP_ID",
      "PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64",
      "PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS",
      "PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN",
      "PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN",
    ],
  });
});

test("OpenAPI startup validates common persistence after constructing its real provider", async () => {
  const failure = await runFailure({ PAGE2WEBMCP_PROVIDER_MODE: "openapi" });
  assert.deepEqual(failure, {
    code: "DATABASE_URL_REQUIRED",
    missingEnvironment: ["DATABASE_URL"],
  });
});

test("local and unknown modes fail without opening a repository", async () => {
  assert.deepEqual(await runFailure({ PAGE2WEBMCP_PROVIDER_MODE: "local" }), {
    code: "WORKER_PROVIDER_MODE_REQUIRED",
    missingEnvironment: ["PAGE2WEBMCP_PROVIDER_MODE"],
  });
  assert.deepEqual(await runFailure({ PAGE2WEBMCP_PROVIDER_MODE: "other" }), {
    code: "INVALID_PROVIDER_MODE",
    missingEnvironment: ["PAGE2WEBMCP_PROVIDER_MODE"],
  });
});

async function runFailure(environment: Record<string, string>): Promise<unknown> {
  try {
    await run(process.execPath, [tsx, main], {
      cwd: root,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        ...environment,
      },
      timeout: 10_000,
      maxBuffer: 32 * 1_024,
    });
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    const stderr = failure.stderr ?? "";
    assert.ok(Buffer.byteLength(stderr, "utf8") <= 16 * 1_024);
    const lines = stderr.trim().split("\n");
    assert.equal(lines.length, 1, stderr);
    assert.doesNotMatch(stderr, /must-not-connect|postgresql:\/\/|secret-value/i);
    return JSON.parse(lines[0]!);
  }
  assert.fail("worker startup unexpectedly succeeded");
}
