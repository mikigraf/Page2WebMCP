import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { InMemoryControlPlaneRepository, type AnalysisResult, type RepositoryActor } from "../../../packages/database/src/control-plane.ts";
import { WorkflowController } from "../../../packages/database/src/workflow.ts";
import {
  createProductionWorkerRuntime,
  createProductionWorkerRuntimeFromProvider,
  createProductionProvider,
  inspectProductionProviderConfiguration,
  processProductionWorkerIteration,
  type ProductionWorkerRuntime,
} from "./production-runtime.ts";

const owner: RepositoryActor = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "owner",
};

function configuredEnvironment() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    PAGE2WEBMCP_PROVIDER_MODE: "github",
    PAGE2WEBMCP_GITHUB_APP_ID: "12345",
    PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"),
    PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS: JSON.stringify([{
      owner: "bright-tools", repository: "widget-console", repositoryId: 90210,
      installationId: 41, ref: "refs/heads/main", targetOrigin: "https://widgets.example",
    }]),
    PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN: "https://sandbox.example",
    PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN: "sandbox_ephemeral_control_token_abcdefghijklmnopqrstuvwxyz",
  };
}

const websiteKeys = [
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

function configuredWebsiteEnvironment(): Record<string, string> {
  return {
    PAGE2WEBMCP_PROVIDER_MODE: "website",
    PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN: "https://auth-handoff.example",
    PAGE2WEBMCP_AUTH_HANDOFF_TOKEN: "auth_handoff_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN: "https://browser-leases.example",
    PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN: "browser_lease_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_BROWSER_USE_API_KEY: "bu_test_cloud_key_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_BROWSER_USE_API_ORIGIN: "https://browser-gateway.example",
    PAGE2WEBMCP_CDP_OBSERVER_ORIGIN: "https://cdp-observer.example",
    PAGE2WEBMCP_CDP_OBSERVER_TOKEN: "cdp_observer_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_EGRESS_POLICY_ORIGIN: "https://egress-policy.example",
    PAGE2WEBMCP_EGRESS_POLICY_TOKEN: "egress_policy_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_EGRESS_PROXY_ORIGIN: "https://egress-proxy.example",
    PAGE2WEBMCP_EGRESS_PROXY_TOKEN: "egress_proxy_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN: "https://evidence-store.example",
    PAGE2WEBMCP_EVIDENCE_STORE_TOKEN: "evidence_store_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN: "https://ownership-store.example",
    PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN: "ownership_store_control_token_abcdefghijklmnopqrstuvwxyz",
    PAGE2WEBMCP_PUBLIC_ORIGIN: "https://storage.example/storage/v1/object/public/page2webmcp-releases",
    PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID: "kms://page2webmcp/browser-session-secrets",
    PAGE2WEBMCP_SECRET_STORE_ORIGIN: "https://secret-store.example",
    PAGE2WEBMCP_SECRET_STORE_TOKEN: "secret_store_control_token_abcdefghijklmnopqrstuvwxyz",
  };
}

test("pure selected-provider inspection returns sorted key names and never values", () => {
  const website = inspectProductionProviderConfiguration({ PAGE2WEBMCP_PROVIDER_MODE: "website" });
  assert.deepEqual(website, { code: "WEBSITE_LIVE_CONFIGURATION_REQUIRED", keys: websiteKeys });
  assert.doesNotMatch(JSON.stringify(website), /token_|https:\/\//);

  const invalid = configuredWebsiteEnvironment();
  invalid.PAGE2WEBMCP_AUTH_HANDOFF_TOKEN = "secret-value-too-short";
  invalid.PAGE2WEBMCP_PUBLIC_ORIGIN = "https://storage.example";
  assert.deepEqual(inspectProductionProviderConfiguration(invalid), {
    code: "WEBSITE_LIVE_CONFIGURATION_REQUIRED",
    keys: ["PAGE2WEBMCP_AUTH_HANDOFF_TOKEN", "PAGE2WEBMCP_PUBLIC_ORIGIN"],
  });

  assert.deepEqual(inspectProductionProviderConfiguration({ PAGE2WEBMCP_PROVIDER_MODE: "openapi" }), {
    code: "PRODUCTION_PROVIDER_CONFIGURATION_READY", keys: [],
  });
  assert.deepEqual(inspectProductionProviderConfiguration({ PAGE2WEBMCP_PROVIDER_MODE: "github" }), {
    code: "GITHUB_LIVE_CONFIGURATION_REQUIRED",
    keys: [
      "PAGE2WEBMCP_GITHUB_APP_ID",
      "PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64",
      "PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS",
      "PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN",
      "PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN",
    ],
  });
  assert.deepEqual(inspectProductionProviderConfiguration({
    ...configuredEnvironment(), PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS: "[{}]",
  }), {
    code: "GITHUB_LIVE_CONFIGURATION_REQUIRED", keys: ["PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS"],
  });
  assert.deepEqual(inspectProductionProviderConfiguration({ PAGE2WEBMCP_PROVIDER_MODE: "local" }), {
    code: "WORKER_PROVIDER_MODE_REQUIRED", keys: ["PAGE2WEBMCP_PROVIDER_MODE"],
  });
});

test("provider-only construction returns an exact non-fixture provenance tuple without a repository", () => {
  assert.deepEqual(createProductionProvider({ PAGE2WEBMCP_PROVIDER_MODE: "openapi" }, {
    fetch: async () => { throw new Error("NO_NETWORK_DURING_CONSTRUCTION"); },
  }).provenance, {
    mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false,
  });
  assert.deepEqual(createProductionProvider(configuredWebsiteEnvironment(), {
    fetch: async () => { throw new Error("NO_NETWORK_DURING_CONSTRUCTION"); },
  }).provenance, {
    mode: "website", adapter: "browser-use-v4", adapterVersion: 4, fixture: false,
  });
});

test("a provider constructed before repository creation is reused without reconstruction", () => {
  const provider = createProductionProvider({ PAGE2WEBMCP_PROVIDER_MODE: "openapi" }, {
    fetch: async () => { throw new Error("NO_NETWORK_DURING_CONSTRUCTION"); },
  });
  const runtime = createProductionWorkerRuntimeFromProvider(
    new InMemoryControlPlaneRepository(),
    provider,
    { fetch: async () => { throw new Error("PROVIDER_MUST_NOT_BE_RECONSTRUCTED"); } },
  );
  assert.equal(runtime.analyze, provider.analyze);
  assert.equal(runtime.providerProvenance, provider.provenance);
  assert.equal(runtime.analysisSourceTypes, provider.analysisSourceTypes);
});

test("missing selected website controls fail before every repository claim path", () => {
  const repository = new InMemoryControlPlaneRepository();
  let analysisClaims = 0;
  let workflowReconciles = 0;
  let workflowClaims = 0;
  repository.claimAnalysis = async () => { analysisClaims += 1; return undefined; };
  repository.reconcileWorkflows = async () => { workflowReconciles += 1; return 0; };
  repository.claimWorkflowTask = async () => { workflowClaims += 1; return undefined; };
  assert.throws(
    () => createProductionWorkerRuntime(repository, { PAGE2WEBMCP_PROVIDER_MODE: "website" }, { fetch }),
    /^Error: WEBSITE_LIVE_CONFIGURATION_REQUIRED$/,
  );
  assert.deepEqual({ analysisClaims, workflowReconciles, workflowClaims }, {
    analysisClaims: 0, workflowReconciles: 0, workflowClaims: 0,
  });
});

test("OpenAPI and website runtimes expose one source and never enter GitHub workflow claims", async () => {
  for (const [mode, environment] of [
    ["openapi", { PAGE2WEBMCP_PROVIDER_MODE: "openapi" }],
    ["website", configuredWebsiteEnvironment()],
  ] as const) {
    const repository = new InMemoryControlPlaneRepository();
    const claimedSourceTypes: Array<readonly string[] | undefined> = [];
    let workflowReconciles = 0;
    let workflowClaims = 0;
    repository.claimAnalysis = async (_workerId, _leaseMs, sourceTypes) => {
      claimedSourceTypes.push(sourceTypes);
      return undefined;
    };
    repository.reconcileWorkflows = async () => { workflowReconciles += 1; return 0; };
    repository.claimWorkflowTask = async () => { workflowClaims += 1; return undefined; };
    const runtime = createProductionWorkerRuntime(repository, environment, {
      fetch: async () => { throw new Error("NO_CONTROL_OR_GITHUB_CALL_DURING_CONSTRUCTION"); },
    });
    assert.deepEqual(runtime.analysisSourceTypes, [mode]);
    assert.equal(runtime.workflows, undefined);
    assert.equal(await processProductionWorkerIteration(
      repository, runtime, `${mode}-worker`, new AbortController().signal,
    ), false);
    assert.deepEqual(claimedSourceTypes, [[mode]]);
    assert.equal(workflowReconciles, 0);
    assert.equal(workflowClaims, 0);
  }
});

test("production runtime validates GitHub controls before the repository can be claimed", () => {
  const repository = new InMemoryControlPlaneRepository();
  let claims = 0;
  repository.claimAnalysis = async () => { claims += 1; return undefined; };
  assert.throws(
    () => createProductionWorkerRuntime(repository, { PAGE2WEBMCP_PROVIDER_MODE: "github" }, { fetch }),
    /GITHUB_LIVE_CONFIGURATION_REQUIRED/,
  );
  assert.equal(claims, 0);
});

test("production iteration always passes its explicit configured adapter to the durable analysis runner", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Widget console",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "project-production-runtime",
    inputHash: "project-production-runtime",
  });
  await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-production-runtime",
    inputHash: "analysis-production-runtime",
  });
  let calls = 0;
  const evidenceContent = "{}";
  const diagnosticOnly: AnalysisResult = {
    capabilities: [],
    diagnostics: [{ code: "UNSUPPORTED_REPOSITORY", operationKey: "a".repeat(40) }],
    evidence: [{ source: "github", content: evidenceContent,
      reference: `urn:sha256:${createHash("sha256").update(evidenceContent).digest("hex")}` }],
  };
  const runtime: ProductionWorkerRuntime = {
    analysisSourceTypes: ["github"],
    analyze: async (source) => {
      calls += 1;
      assert.equal(source.sourceType, "github");
      return diagnosticOnly;
    },
    workflows: new WorkflowController(repository, { handlers: {}, sideEffects: {} }),
  };
  assert.equal(await processProductionWorkerIteration(repository, runtime, "production-worker", new AbortController().signal), true);
  assert.equal(calls, 1);
  assert.equal((await repository.getLatestAnalysis(owner, project.id))?.status, "succeeded");
});

test("production runtime construction accepts only the real configured GitHub factory", () => {
  const repository = new InMemoryControlPlaneRepository();
  const runtime = createProductionWorkerRuntime(repository, configuredEnvironment(), { fetch });
  assert.equal(typeof runtime.analyze, "function");
  assert.ok(runtime.workflows);
  assert.equal(typeof runtime.workflows.runNext, "function");
  assert.equal("setAnalysisAdapterForTest" in runtime, false);
});

test("production runtime requires the isolated sandbox before exposing workflow mutation handlers", () => {
  const repository = new InMemoryControlPlaneRepository();
  const missingSandbox: Record<string, string | undefined> = { ...configuredEnvironment() };
  delete missingSandbox.PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN;
  assert.throws(() => createProductionWorkerRuntime(repository, missingSandbox, { fetch }), /GITHUB_SANDBOX_CONFIGURATION_REQUIRED/);
});

test("dedicated GitHub runtime never claims or fails website and OpenAPI analysis jobs", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const runs = [];
  for (const [sourceType, url] of [
    ["website", "https://widgets.example/"],
    ["openapi", "https://widgets.example/openapi.json"],
  ] as const) {
    const project = await repository.createProject(owner, {
      name: `${sourceType} source stays on its worker`,
      sourceType,
      url,
      ...(sourceType === "openapi" ? {
        sourceConfiguration: {
          kind: "openapi" as const,
          targetOrigin: "https://widgets.example",
          testPageUrl: "https://widgets.example/",
          environment: "test" as const,
        },
      } : {}),
      idempotencyKey: `production-source-filter-project-${sourceType}`,
      inputHash: `production-source-filter-project-${sourceType}`,
    });
    runs.push(await repository.enqueueAnalysis(owner, {
      projectId: project.id,
      idempotencyKey: `production-source-filter-analysis-${sourceType}`,
      inputHash: `production-source-filter-analysis-${sourceType}`,
    }));
  }
  let providerCalls = 0;
  const runtime = createProductionWorkerRuntime(repository, configuredEnvironment(), {
    fetch: async () => { providerCalls += 1; throw new Error("NON_GITHUB_PROVIDER_MUST_NOT_RUN"); },
  });
  assert.equal(await processProductionWorkerIteration(
    repository, runtime, "dedicated-github-worker", new AbortController().signal,
  ), false);
  assert.equal(providerCalls, 0);
  for (const run of runs) assert.equal((await repository.getAnalysis(owner, run.id)).status, "queued");
});

test("production iteration reaches the Task 5 controller when the analysis queue is empty", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Controller reachability",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "production-controller-project",
    inputHash: "production-controller-project",
  });
  const workflow = await repository.startWorkflow(owner, {
    projectId: project.id,
    idempotencyKey: "production-controller-workflow",
    inputHash: "production-controller-workflow",
  });
  const runtime: ProductionWorkerRuntime = {
    analysisSourceTypes: ["github"],
    analyze: async () => { throw new Error("analysis must stay empty"); },
    workflows: new WorkflowController(repository, {
      handlers: { preflight: async () => ({}) },
      sideEffects: {},
    }),
  };
  assert.equal(await processProductionWorkerIteration(
    repository, runtime, "production-controller-worker", new AbortController().signal,
  ), true);
  assert.equal((await repository.getWorkflowRun(owner, workflow.id)).currentPhase, "ownership");
});
