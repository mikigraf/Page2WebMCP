import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { buildDeploymentIdentity } from "../apps/control-plane/src/deployment-identity.ts";
import {
  operatorClockSkewCompensatedNow,
  OPERATOR_CLOCK_SKEW_TOLERANCE_MS,
  parseReadinessMode,
  runReadinessCli,
  sourceMigrationLedgerCurrent,
  type ReadinessCliDependencies,
} from "../scripts/check-release-readiness.ts";
import { PRODUCTION_LIVE_COMMON_CONTROLS } from "../packages/operations/src/production-live.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/check-release-readiness.ts", import.meta.url));
const artifactBytes = Buffer.from("export const selected = true;", "utf8");
const selectedHash = createHash("sha256").update(artifactBytes).digest("hex");
const hosted = "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const local = "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases";
const selectedContext = {
  sourceType: "openapi" as const,
  sourceUrl: "https://specs.widgets.example/openapi.json",
  sourceIdentityHash: "e".repeat(64),
  sourceArtifact: {
    contentHash: "f".repeat(64),
    artifactReference: `urn:sha256:${"f".repeat(64)}`,
    finalUrl: "https://specs.widgets.example/openapi.json",
    mimeType: "application/json",
    sizeBytes: 87,
  },
  sourceConfiguration: {
    kind: "openapi" as const,
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/webmcp-test",
    environment: "production" as const,
  },
};
const deployment = buildDeploymentIdentity({
  gitCommitSha: "c".repeat(40),
  applicationReleaseId: "page2webmcp-2026_09_01-rc1",
  controlPlaneOrigin: "https://control.example",
  sourceTreeSha256: "d".repeat(64),
});

async function spawn(args: string[], environment: Record<string, string | undefined> = {}) {
  return run(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "test", ...environment },
  });
}

function completeEnvironment(mode: "live" | "local-live" = "live") {
  return {
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_PUBLIC_ORIGIN: mode === "live" ? hosted : local,
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: mode === "live"
      ? "https://control.example"
      : "http://127.0.0.1:3100",
    PAGE2WEBMCP_PROVIDER_MODE: "openapi",
    PAGE2WEBMCP_READINESS_RELEASE_HASH: selectedHash,
    DATABASE_URL: mode === "live"
      ? "postgresql://app:secret@database.example/page2webmcp"
      : "postgresql://page2webmcp_app_local:secret@127.0.0.1:58322/postgres?options=-c+role%3Dpage2webmcp_app",
    PAGE2WEBMCP_MAINTENANCE_DATABASE_URL: mode === "live"
      ? "postgresql://readiness:secret@database.example/page2webmcp"
      : "postgresql://page2webmcp_maintenance_local:secret@127.0.0.1:58322/postgres?options=-c+role%3Dpage2webmcp_maintenance",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "v".repeat(32),
    ...(mode === "live" ? {
      PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.example",
      PAGE2WEBMCP_SUPABASE_URL: "https://bimqgiedckdurqiywctl.supabase.co",
      PAGE2WEBMCP_SUPABASE_SECRET_KEY: `sb_secret_${"s".repeat(32)}`,
      PAGE2WEBMCP_GIT_COMMIT_SHA: deployment.gitCommitSha,
      PAGE2WEBMCP_APPLICATION_RELEASE_ID: deployment.applicationReleaseId,
    } : {
      PAGE2WEBMCP_LOCAL_STACK: "true",
      PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN: "http://127.0.0.1:3900",
    }),
  };
}

function response(url: string, bytes = artifactBytes): Response {
  const value = new Response(bytes, { status: 200, headers: { "content-type": "application/javascript" } });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function dependencies(
  order: string[],
  expectedLocalOnly = false,
  selectedReleasePersisted = true,
  context: typeof selectedContext | undefined = selectedContext,
): ReadinessCliDependencies {
  return {
    deploymentIdentityDigest: deployment.identityDigest,
    loadBuildIdentity: () => deployment,
    constructProvider: () => {
      order.push("provider");
      return {
        provenance: { mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false },
        analysisSourceTypes: ["openapi"],
        analyze: async () => { throw new Error("UNUSED"); },
        probe: async ({ selectedReleaseHash, publicOrigin, context, signal }) => {
          order.push("provider-probe");
          assert.equal(selectedReleaseHash, selectedHash);
          assert.equal(publicOrigin, hosted);
          assert.deepEqual(context, selectedContext);
          assert.equal(signal.aborted, false);
        },
      };
    },
    fetch: async (input, init) => {
      order.push("artifact");
      assert.equal(String(input), `${hosted}/${selectedHash}.js`);
      assert.deepEqual({ method: init?.method, redirect: init?.redirect, credentials: init?.credentials }, {
        method: "GET", redirect: "error", credentials: "omit",
      });
      return response(String(input));
    },
    handshake: async (_environment, mode, _signal, binding) => {
      order.push("verifier");
      if (mode === "live") assert.equal(binding.deploymentIdentityDigest, deployment.identityDigest);
      return { protocolVersion: 1, mode, webMcpImplementation: "native", verifierOriginDigest: "b".repeat(64) };
    },
    createApplicationRepository: () => {
      order.push("application-database-construction");
      return {
        inspectApplicationRole: async () => {
          order.push("application-database-audit");
          return { sessionIdentityDigest: "a".repeat(64) };
        },
        close: async () => { order.push("application-database-close"); },
      };
    },
    createMaintenanceRepository: () => {
      order.push("database-construction");
      return {
        inspectSelectedReleaseTopology: async (hash, provider, localOnly) => {
          order.push("database-topology");
          assert.equal(hash, selectedHash);
          assert.equal(provider.mode, "openapi");
          assert.equal(localOnly, expectedLocalOnly);
          return {
            migrationsCurrent: true,
            rlsVerified: true,
            selectedReleasePersisted,
            sessionIdentityDigest: "d".repeat(64),
          };
        },
        loadSelectedProviderProbeContext: async (hash) => {
          order.push("database-provider-context");
          assert.equal(hash, selectedHash);
          return context;
        },
        findSelectedNativeInstallationProof: async (hash) => {
          order.push("database-query");
          assert.equal(hash, selectedHash);
          return undefined;
        },
        close: async () => { order.push("database-close"); },
      };
    },
  };
}

test("release readiness CLI passes hermetic gates without network, provider, or database access", async () => {
  const result = await spawn(["--hermetic"]);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "passed", code: "HERMETIC_READINESS_PASSED", liveSuccess: false,
  });
});

test("exactly one exclusive readiness flag is required", async () => {
  for (const args of [[], ["--live", "--hermetic"], ["--live", "--live"], ["--unknown"], ["live"],
    ["--hermetic", "extra"]]) {
    assert.throws(() => parseReadinessMode(args), /READINESS_MODE_REQUIRED/);
    await assert.rejects(spawn(args), (error: unknown) => {
      const failure = error as { code?: number; stdout?: string };
      assert.equal(failure.code, 1);
      assert.deepEqual(JSON.parse(failure.stdout ?? "{}"), {
        status: "failed", code: "READINESS_MODE_REQUIRED", liveSuccess: false,
      });
      return true;
    });
  }
});

test("missing live controls are sorted names only, never values", async () => {
  await assert.rejects(spawn(["--live"], {
    PAGE2WEBMCP_STORAGE_MODE: undefined,
    PAGE2WEBMCP_PUBLIC_ORIGIN: undefined,
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: undefined,
    PAGE2WEBMCP_PROVIDER_MODE: undefined,
    DATABASE_URL: undefined,
    PAGE2WEBMCP_MAINTENANCE_DATABASE_URL: undefined,
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: undefined,
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: undefined,
    PAGE2WEBMCP_SUPABASE_URL: undefined,
    PAGE2WEBMCP_SUPABASE_SECRET_KEY: undefined,
    PAGE2WEBMCP_GIT_COMMIT_SHA: undefined,
    PAGE2WEBMCP_APPLICATION_RELEASE_ID: undefined,
  }), (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 2);
    const output = JSON.parse(failure.stdout ?? "{}");
    assert.deepEqual(output.missingKeys, [
      "DATABASE_URL",
      "PAGE2WEBMCP_APPLICATION_RELEASE_ID",
      "PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN",
      "PAGE2WEBMCP_GIT_COMMIT_SHA",
      "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL",
      "PAGE2WEBMCP_PROVIDER_MODE",
      "PAGE2WEBMCP_PUBLIC_ORIGIN",
      "PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN",
      "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
      "PAGE2WEBMCP_STORAGE_MODE",
      "PAGE2WEBMCP_SUPABASE_SECRET_KEY",
      "PAGE2WEBMCP_SUPABASE_URL",
    ]);
    assert.equal(JSON.stringify(output).includes("secret"), false);
    assert.equal(output.liveSuccess, false);
    return true;
  });
});

test("local-live databases require exact IP-literal loopback port 58322", async () => {
  const invalid = [
    "postgresql://app:secret@127.0.0.1:54322/page2webmcp",
    ...[58320, 58321, 58323, 58324, 58325, 58326, 58327, 58328, 58329]
      .map((port) => `postgresql://app:secret@127.0.0.1:${port}/page2webmcp`),
    "postgresql://app:secret@localhost:58322/page2webmcp",
    "postgresql://app:secret@127.0.0.2:58322/page2webmcp",
  ];
  for (const key of ["DATABASE_URL", "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL"] as const) {
    for (const value of invalid) {
      const environment = { ...completeEnvironment("local-live"), [key]: value };
      assert.deepEqual(await runReadinessCli(["--local-live"], environment, dependencies([], true)), {
        output: { status: "skipped", code: "LIVE_CONTROLS_REQUIRED", liveSuccess: false, missingKeys: [key] },
        exitCode: 2,
      });
    }
  }

  const ipv6 = completeEnvironment("local-live");
  ipv6.DATABASE_URL =
    "postgresql://page2webmcp_app_local:secret@[::1]:58322/postgres?options=-c+role%3Dpage2webmcp_app";
  ipv6.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL =
    "postgresql://page2webmcp_maintenance_local:secret@[::1]:58322/postgres?options=-c+role%3Dpage2webmcp_maintenance";
  ipv6.PAGE2WEBMCP_READINESS_RELEASE_HASH = "A".repeat(64);
  assert.equal((await runReadinessCli(["--local-live"], ipv6, dependencies([], true))).output.code,
    "LIVE_INSTALLATION_EVIDENCE_REQUIRED");

  const live = completeEnvironment();
  live.DATABASE_URL = "postgresql://app:secret@database.example:6432/page2webmcp";
  live.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL =
    "postgresql://readiness:secret@database.example:6432/page2webmcp";
  live.PAGE2WEBMCP_READINESS_RELEASE_HASH = "A".repeat(64);
  assert.equal((await runReadinessCli(["--live"], live, dependencies([]))).output.code,
    "LIVE_INSTALLATION_EVIDENCE_REQUIRED");
});

test("source readiness requires the complete migration ledger through the verifier-v2 repair", async () => {
  const migrations = await readdir(new URL("../supabase/migrations/", import.meta.url));
  assert.equal(migrations.includes("20260901100000_openapi_document_freeze.sql"), true);
  assert.equal(sourceMigrationLedgerCurrent(migrations), true);
  assert.equal(sourceMigrationLedgerCurrent(
    migrations.filter((name) => name !== "20260901071658_website_authentication_wait.sql"),
  ), false);
  assert.equal(sourceMigrationLedgerCurrent([
    "20260831211329_installed_execution_evidence.sql",
    "20260901000000_selected_provider_probe_context.sql",
    "20260901010000_single_installation_proof.sql",
    "20260901020000_durable_result_surfaces.sql",
    "20260901030000_analysis_source_lock.sql",
    "20260901040000_analysis_source_lock_readiness.sql",
  ]), false);
});

test("a provider constructor failure never emits the inspection success code", async () => {
  const outcome = await runReadinessCli(["--live"], completeEnvironment(), {
    ...dependencies([]),
    constructProvider: () => { throw new Error("provider internal detail"); },
  });
  assert.deepEqual(outcome, {
    output: { status: "failed", code: "PROVIDER_CONSTRUCTION_FAILED", liveSuccess: false },
    exitCode: 1,
  });
});

test("provider construction failure wins before missing or malformed selected-hash evidence", async () => {
  for (const releaseHash of [undefined, "A".repeat(64)]) {
    const environment: Record<string, string | undefined> = {
      ...completeEnvironment(),
      PAGE2WEBMCP_READINESS_RELEASE_HASH: releaseHash,
    };
    const order: string[] = [];
    const outcome = await runReadinessCli(["--live"], environment, {
      ...dependencies(order),
      constructProvider: () => {
        order.push("provider");
        throw new Error("provider internal detail");
      },
    });
    assert.deepEqual(outcome, {
      output: { status: "failed", code: "PROVIDER_CONSTRUCTION_FAILED", liveSuccess: false },
      exitCode: 1,
    });
    assert.deepEqual(order, ["provider"]);
  }
});

test("complete controls without an exact selected hash remain installation-evidence-required", async () => {
  const order: string[] = [];
  const environment: Record<string, string | undefined> = completeEnvironment();
  environment.PAGE2WEBMCP_READINESS_RELEASE_HASH = "A".repeat(64);
  assert.deepEqual(await runReadinessCli(["--live"], environment, dependencies(order)), {
    output: { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false },
    exitCode: 2,
  });
  assert.deepEqual(order, ["provider"]);
});

test("a syntactically valid nonexistent selected hash remains installation-evidence-required", async () => {
  const order: string[] = [];
  assert.deepEqual(await runReadinessCli(
    ["--live"], completeEnvironment(), dependencies(order, false, false, undefined),
  ), {
    output: { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false },
    exitCode: 2,
  });
  assert.equal(order.includes("provider-probe"), false);
  assert.equal(order.includes("artifact"), false);
});

test("live loads the exact selected-release context before probing its provider", async () => {
  const order: string[] = [];
  const outcome = await runReadinessCli(["--live"], completeEnvironment(), dependencies(order));
  assert.deepEqual(outcome, {
    output: { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false },
    exitCode: 2,
  });
  assert.deepEqual(order, [
    "provider", "application-database-construction", "application-database-audit", "application-database-close",
    "database-construction", "database-topology", "database-provider-context", "database-query", "database-close",
    "provider-probe", "artifact", "verifier",
  ]);
});

test("live readiness rejects a digest that is not the exact local build identity before external work", async () => {
  const order: string[] = [];
  const outcome = await runReadinessCli(["--live"], completeEnvironment(), {
    ...dependencies(order),
    deploymentIdentityDigest: "e".repeat(64),
  });
  assert.deepEqual(outcome, {
    output: { status: "failed", code: "DEPLOYMENT_IDENTITY_MISMATCH", liveSuccess: false },
    exitCode: 1,
  });
  assert.deepEqual(order, []);
});

test("a syntactically valid but unreachable or revoked provider fails closed before artifact and databases", async () => {
  const order: string[] = [];
  const base = dependencies(order);
  const outcome = await runReadinessCli(["--live"], completeEnvironment(), {
    ...base,
    constructProvider: () => ({
      provenance: { mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false },
      analysisSourceTypes: ["openapi"],
      analyze: async () => { throw new Error("UNUSED"); },
      probe: async () => {
        order.push("provider-probe");
        throw new Error("revoked credential must stay redacted");
      },
    }),
  });
  assert.deepEqual(outcome, {
    output: { status: "skipped", code: "LIVE_CONTROLS_REQUIRED", liveSuccess: false },
    exitCode: 2,
  });
  assert.deepEqual(order, [
    "application-database-construction", "application-database-audit", "application-database-close",
    "database-construction", "database-topology", "database-provider-context", "database-query", "database-close",
    "provider-probe",
  ]);
  assert.doesNotMatch(JSON.stringify(outcome), /revoked credential/);
});

test("an unreachable or overprivileged application database prevents readiness before maintenance proof", async () => {
  const order: string[] = [];
  const deps: ReadinessCliDependencies = {
    ...dependencies(order),
    createApplicationRepository: () => ({
      inspectApplicationRole: async () => { throw new Error("connection detail must stay redacted"); },
      close: async () => { order.push("application-database-close"); },
    }),
  };
  assert.deepEqual(await runReadinessCli(["--live"], completeEnvironment(), deps), {
    output: { status: "failed", code: "APPLICATION_DATABASE_READINESS_FAILED", liveSuccess: false },
    exitCode: 1,
  });
  assert.equal(order.includes("database-construction"), false);
});

test("application and maintenance readiness connections must use distinct login identities", async () => {
  const order: string[] = [];
  const deps: ReadinessCliDependencies = {
    ...dependencies(order),
    createApplicationRepository: () => ({
      inspectApplicationRole: async () => ({ sessionIdentityDigest: "d".repeat(64) }),
      close: async () => undefined,
    }),
  };
  assert.deepEqual(await runReadinessCli(["--live"], completeEnvironment(), deps), {
    output: { status: "failed", code: "DATABASE_ROLE_SEPARATION_FAILED", liveSuccess: false },
    exitCode: 1,
  });
});

test("live never reads the local verifier environment key", async () => {
  const base = completeEnvironment();
  const environment = new Proxy(base as Record<string, string | undefined>, {
    get(target, property, receiver) {
      if (property === "PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN") throw new Error("LOCAL_SENTINEL_READ");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal((await runReadinessCli(["--live"], environment, dependencies([]))).output.code,
    "LIVE_INSTALLATION_EVIDENCE_REQUIRED");
});

test("artifact bytes are actively hashed and a mismatch stops before verifier or database", async () => {
  const order: string[] = [];
  const deps = dependencies(order);
  const outcome = await runReadinessCli(["--live"], completeEnvironment(), {
    ...deps,
    fetch: async (input) => { order.push("artifact"); return response(String(input), Buffer.from("wrong")); },
  });
  assert.deepEqual(outcome, {
    output: { status: "failed", code: "ARTIFACT_INTEGRITY_FAILED", liveSuccess: false }, exitCode: 1,
  });
  assert.deepEqual(order, [
    "provider", "application-database-construction", "application-database-audit", "application-database-close",
    "database-construction", "database-topology", "database-provider-context", "database-query", "database-close",
    "provider-probe", "artifact",
  ]);
});

test("local-live runs its selected-provider topology diagnostics but can never claim live success", async () => {
  const order: string[] = [];
  const deps = dependencies(order, true);
  const outcome = await runReadinessCli(["--local-live"], completeEnvironment("local-live"), {
    ...deps,
    fetch: async (input, init) => {
      order.push("artifact");
      assert.equal(String(input), `${local}/${selectedHash}.js`);
      assert.equal(init?.credentials, "omit");
      return response(String(input));
    },
  });
  assert.deepEqual(outcome, {
    output: { status: "passed", code: "LOCAL_LIVE_READINESS_PASSED", liveSuccess: false }, exitCode: 0,
  });
});

test("a CDN session cookie on the hosted artifact does not fail readiness", async () => {
  // Hosted Storage is fronted by a CDN that sets its own bot-management cookie.
  // The read omits credentials and every byte is hash-verified, so the cookie
  // cannot affect the artifact. A drifted URL still fails.
  const order: string[] = [];
  const withCookie = await runReadinessCli(["--local-live"], completeEnvironment("local-live"), {
    ...dependencies(order, true),
    fetch: async (input) => {
      const value = new Response(artifactBytes, {
        status: 200,
        headers: {
          "content-type": "application/javascript",
          "set-cookie": "__cf_bm=opaque; HttpOnly; Secure; Path=/; Domain=supabase.co",
        },
      });
      Object.defineProperty(value, "url", { value: String(input) });
      return value;
    },
  });
  assert.equal(withCookie.output.code, "LOCAL_LIVE_READINESS_PASSED");

  const drifted = await runReadinessCli(["--local-live"], completeEnvironment("local-live"), {
    ...dependencies([], true),
    fetch: async () => response(`${local}/elsewhere.js`),
  });
  assert.notEqual(drifted.output.code, "LOCAL_LIVE_READINESS_PASSED");
});

test("live readiness reports the same deployment-identity and hosted Storage controls as the journey preflight", async () => {
  // Operator-only controls the readiness command never uses: it neither writes a
  // receipt nor authenticates as the operator.
  const operatorOnly = new Set([
    "PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE",
    "PAGE2WEBMCP_RECEIPT_SIGNING_KEY",
  ]);
  const shared = PRODUCTION_LIVE_COMMON_CONTROLS.filter((key) => !operatorOnly.has(key));
  for (const key of shared) {
    const environment: Record<string, string | undefined> = { ...completeEnvironment("live"), [key]: undefined };
    const result = await runReadinessCli(["--live"], environment, dependencies([]));
    assert.equal(result.output.code, "LIVE_CONTROLS_REQUIRED", key);
    assert.ok(result.output.missingKeys?.includes(key), `${key} must be reported by name`);
  }

  for (const [key, value] of [
    ["PAGE2WEBMCP_SUPABASE_URL", "https://another-project.supabase.co"],
    ["PAGE2WEBMCP_SUPABASE_SECRET_KEY", "short"],
    ["PAGE2WEBMCP_GIT_COMMIT_SHA", "not-a-commit"],
    ["PAGE2WEBMCP_APPLICATION_RELEASE_ID", "release.with.dots"],
  ] as const) {
    const result = await runReadinessCli(
      ["--live"], { ...completeEnvironment("live"), [key]: value }, dependencies([]),
    );
    assert.deepEqual(result.output.missingKeys, [key]);
  }

  // local-live keeps its narrower control set: the hosted Storage and deployment
  // identity controls are live-only and must not appear there.
  const local = await runReadinessCli(["--local-live"], {
    ...completeEnvironment("local-live"),
    PAGE2WEBMCP_SUPABASE_URL: undefined,
    PAGE2WEBMCP_SUPABASE_SECRET_KEY: undefined,
    PAGE2WEBMCP_GIT_COMMIT_SHA: undefined,
    PAGE2WEBMCP_APPLICATION_RELEASE_ID: undefined,
  }, dependencies([], true));
  assert.notEqual(local.output.code, "LIVE_CONTROLS_REQUIRED");
  assert.equal(local.output.missingKeys, undefined);
});

test("the operator clock-skew compensated now() is ahead of the raw clock by the documented tolerance", () => {
  // An operator's own machine drifting a few tens of milliseconds behind true
  // time is enough to trip the live verifier's zero-tolerance "response must
  // not be from the future" check, since two Render-hosted services calling
  // each other never see that drift. This asserts the compensation this CLI
  // applies for its own handshake, not the verifier's own validation.
  const before = Date.now();
  const compensated = operatorClockSkewCompensatedNow().getTime();
  const after = Date.now();
  assert.ok(compensated >= before + OPERATOR_CLOCK_SKEW_TOLERANCE_MS);
  assert.ok(compensated <= after + OPERATOR_CLOCK_SKEW_TOLERANCE_MS);
});
