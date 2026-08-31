import assert from "node:assert/strict";
import test from "node:test";
import { GET as getRun } from "../app/api/analysis-runs/[runId]/route.ts";
import { POST as analyze } from "../app/api/projects/analyze/route.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import { setAnalysisAdapterForTest } from "../../worker/src/runner.ts";
import { createOpenApiAnalysisAdapter } from "../../worker/src/workflow.ts";
import { authenticatedHeaders, installTestRepository, owner as actor } from "./auth-test-helpers.ts";

const authHeaders = authenticatedHeaders(actor);
const cookie = authHeaders.cookie;

const fixtureAnalysisAdapter = async (source: Parameters<NonNullable<Parameters<typeof setAnalysisAdapterForTest>[0]>>[0]) => {
  const origin = source.sourceType === "github" ? "https://acme.example" : new URL(source.sourceUrl).origin;
  const plans = acmeCapabilityPlans(origin).slice(0, source.sourceType === "github" ? 1 : 3);
  const release = compileWebMcpRelease(plans);
  return {
    capabilities: plans.map((plan) => ({ plan, status: "proposed" as const })),
    diagnostics: [],
    evidence: acmeCapabilityEvidence().filter(({ reference }) =>
      plans.some((plan) => plan.evidence.some((item) => item.reference === reference))),
    release,
  };
};

setAnalysisAdapterForTest(fixtureAnalysisAdapter);

async function createFixtureProject(repository: InMemoryControlPlaneRepository, sourceType: "website" | "openapi" | "github") {
  return repository.createProject(actor, {
    name: "Acme Support",
    sourceType,
    url: sourceType === "github"
      ? "https://github.com/acme/support"
      : sourceType === "openapi"
        ? "https://acme.example/openapi.json"
        : "https://acme.example/",
    ...(sourceType === "openapi" ? {
      sourceConfiguration: {
        kind: "openapi" as const,
        targetOrigin: "https://acme.example",
        testPageUrl: "https://acme.example/",
        environment: "test" as const,
      },
    } : {}),
    idempotencyKey: `project-${sourceType}-${crypto.randomUUID()}`,
    inputHash: `project-${sourceType}`
  });
}

function analysisRequest(projectId: string, key: string, sessionCookie = cookie): Request {
  return new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      ...authHeaders,
      ...(sessionCookie === cookie ? {} : { cookie: sessionCookie }),
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({ projectId })
  });
}

for (const sourceType of ["website", "openapi", "github"] as const) {
  test(`analysis is bound to the persisted ${sourceType} project and exposes durable run state`, async () => {
    const repository = new InMemoryControlPlaneRepository();
    installTestRepository(repository);
    const project = await createFixtureProject(repository, sourceType);

    const response = await analyze(analysisRequest(project.id, `analysis-${sourceType}`));
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.match(accepted.runId, /^[0-9a-f-]{36}$/);

    const status = await getRun(
      new Request(`https://control.example/api/analysis-runs/${accepted.runId}`, { headers: { cookie } }),
      { params: Promise.resolve({ runId: accepted.runId }) }
    );
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.run.status, "succeeded");
    assert.equal(body.projectId, project.id);
    if (sourceType === "github") {
      assert.equal(body.result.draftPullRequest, undefined);
      assert.equal(body.capabilities.length, 1);
      assert.equal(body.capabilities[0].status, "proposed");
    } else {
      assert.deepEqual(body.capabilities.map((item: { stableName: string; status: string }) => [item.stableName, item.status]), [
        ["create_support_ticket", "proposed"],
        ["find_order", "proposed"],
        ["get_order_status", "proposed"]
      ]);
    }
  });
}

test("mixed OpenAPI analysis preserves unsupported-operation diagnostics through the run API", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Mixed Widgets", version: "1" },
    components: { securitySchemes: { serviceKey: { type: "apiKey", in: "header", name: "X-Service-Key" } } },
    paths: {
      "/private": { get: {
        security: [{ serviceKey: [] }],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
      } },
      "/public": { get: {
        security: [],
        responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
      } },
    },
  });
  const mixedAdapter = createOpenApiAnalysisAdapter({
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review/openapi",
    environment: "test",
    provider: {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async ({ url }) => ({
        status: 200,
        url,
        headers: { "content-type": "application/json" },
        body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
      }) },
    },
  });
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  setAnalysisAdapterForTest(mixedAdapter);
  try {
    const project = await repository.createProject(actor, {
      name: "Mixed Widgets",
      sourceType: "openapi",
      url: "https://specs.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://specs.widgets.example", testPageUrl: "https://specs.widgets.example/", environment: "test" },
      idempotencyKey: "project-mixed-openapi",
      inputHash: "project-mixed-openapi",
    });
    const accepted = await (await analyze(analysisRequest(project.id, "analysis-mixed-openapi"))).json();
    const response = await getRun(
      new Request(`https://control.example/api/analysis-runs/${accepted.runId}`, { headers: { cookie } }),
      { params: Promise.resolve({ runId: accepted.runId }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.result.diagnostics, [{
      code: "SERVER_ADAPTER_REQUIRED",
      operationKey: "GET /private",
      reason: "api_key_header",
    }]);
    assert.equal(body.capabilities.length, 1);
    assert.match(body.capabilities[0].stableName, /^get_operation_/);
  } finally {
    setAnalysisAdapterForTest(fixtureAnalysisAdapter);
  }
});

test("all-unsupported OpenAPI analysis exposes exact diagnostics without an invented release", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Private Widgets", version: "1" },
    components: { securitySchemes: { serviceKey: { type: "apiKey", in: "header", name: "X-Service-Key" } } },
    paths: { "/private": { get: {
      security: [{ serviceKey: [] }],
      responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
    } } },
  });
  const unsupportedAdapter = createOpenApiAnalysisAdapter({
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review/openapi",
    environment: "test",
    provider: {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async ({ url }) => ({
        status: 200,
        url,
        headers: { "content-type": "application/json" },
        body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
      }) },
    },
  });
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  setAnalysisAdapterForTest(unsupportedAdapter);
  try {
    const project = await repository.createProject(actor, {
      name: "Private Widgets",
      sourceType: "openapi",
      url: "https://specs.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://specs.widgets.example", testPageUrl: "https://specs.widgets.example/", environment: "test" },
      idempotencyKey: "project-private-openapi",
      inputHash: "project-private-openapi",
    });
    const accepted = await (await analyze(analysisRequest(project.id, "analysis-private-openapi"))).json();
    assert.equal(accepted.status, "succeeded");
    const response = await getRun(
      new Request(`https://control.example/api/analysis-runs/${accepted.runId}`, { headers: { cookie } }),
      { params: Promise.resolve({ runId: accepted.runId }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.run.status, "succeeded");
    assert.deepEqual(body.result.capabilities, []);
    assert.deepEqual(body.capabilities, []);
    assert.deepEqual(body.result.diagnostics, [{
      code: "SERVER_ADAPTER_REQUIRED",
      operationKey: "GET /private",
      reason: "api_key_header",
    }]);
    assert.equal(body.result.release, undefined);
  } finally {
    setAnalysisAdapterForTest(fixtureAnalysisAdapter);
  }
});

test("analysis requires authentication and an idempotency key", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const project = await createFixtureProject(repository, "website");
  assert.equal((await analyze(analysisRequest(project.id, "anonymous", ""))).status, 401);

  const missingKey = new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id })
  });
  const response = await analyze(missingKey);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "IDEMPOTENCY_KEY_REQUIRED");
});

test("duplicate analysis requests return the original run", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const project = await createFixtureProject(repository, "openapi");
  const first = await analyze(analysisRequest(project.id, "same-analysis"));
  const second = await analyze(analysisRequest(project.id, "same-analysis"));
  assert.equal((await second.json()).runId, (await first.json()).runId);
});

test("fixture execution drains earlier queued work until the requested run completes", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const earlier = await createFixtureProject(repository, "website");
  await repository.enqueueAnalysis(actor, {
    projectId: earlier.id,
    idempotencyKey: "earlier-analysis",
    inputHash: "earlier"
  });
  const target = await createFixtureProject(repository, "openapi");
  const response = await analyze(analysisRequest(target.id, "target-analysis"));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "succeeded");
});
