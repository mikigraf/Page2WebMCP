import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  parseReadinessMode,
  runReadinessCli,
  type ReadinessCliDependencies,
} from "../scripts/check-release-readiness.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const script = fileURLToPath(new URL("../scripts/check-release-readiness.ts", import.meta.url));
const artifactBytes = Buffer.from("export const selected = true;", "utf8");
const selectedHash = createHash("sha256").update(artifactBytes).digest("hex");
const hosted = "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const local = "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases";

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
      : "postgresql://app:secret@127.0.0.1:54322/page2webmcp",
    PAGE2WEBMCP_MAINTENANCE_DATABASE_URL: mode === "live"
      ? "postgresql://readiness:secret@database.example/page2webmcp"
      : "postgresql://readiness:secret@127.0.0.1:54322/page2webmcp",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "v".repeat(32),
    ...(mode === "live" ? {
      PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.example",
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

function dependencies(order: string[], expectedLocalOnly = false): ReadinessCliDependencies {
  return {
    constructProvider: () => {
      order.push("provider");
      return {
        provenance: { mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false },
        analysisSourceTypes: ["openapi"],
        analyze: async () => { throw new Error("UNUSED"); },
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
    handshake: async (_environment, mode) => {
      order.push("verifier");
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
            selectedReleasePersisted: true,
            sessionIdentityDigest: "d".repeat(64),
          };
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
  }), (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 2);
    const output = JSON.parse(failure.stdout ?? "{}");
    assert.deepEqual(output.missingKeys, [
      "DATABASE_URL",
      "PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN",
      "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL",
      "PAGE2WEBMCP_PROVIDER_MODE",
      "PAGE2WEBMCP_PUBLIC_ORIGIN",
      "PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN",
      "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
      "PAGE2WEBMCP_STORAGE_MODE",
    ]);
    assert.equal(JSON.stringify(output).includes("secret"), false);
    assert.equal(output.liveSuccess, false);
    return true;
  });
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

test("live constructs the provider before active artifact, verifier, and exact-hash database checks", async () => {
  const order: string[] = [];
  const outcome = await runReadinessCli(["--live"], completeEnvironment(), dependencies(order));
  assert.deepEqual(outcome, {
    output: { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false },
    exitCode: 2,
  });
  assert.deepEqual(order, [
    "provider", "artifact", "verifier", "application-database-construction", "application-database-audit",
    "application-database-close", "database-construction", "database-topology", "database-query", "database-close",
  ]);
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
  assert.deepEqual(order, ["provider", "artifact"]);
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
