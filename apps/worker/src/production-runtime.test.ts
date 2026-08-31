import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { InMemoryControlPlaneRepository, type AnalysisResult, type RepositoryActor } from "../../../packages/database/src/control-plane.ts";
import { WorkflowController } from "../../../packages/database/src/workflow.ts";
import { createProductionWorkerRuntime, processProductionWorkerIteration, type ProductionWorkerRuntime } from "./production-runtime.ts";

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
