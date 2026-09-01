import assert from "node:assert/strict";
import test from "node:test";
import { GET as getWorkflow } from "../app/api/workflow-runs/[runId]/route.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import { processNextAnalysis } from "../../worker/src/runner.ts";
import { setWorkflowTelemetrySinkForTest } from "../../../packages/observability/src/server.ts";
import type { WorkflowTelemetryBatch } from "../../../packages/observability/src/workflow.ts";
import { authenticatedHeaders, installTestRepository, owner } from "./auth-test-helpers.ts";

for (const sourceType of ["website", "openapi"] as const) test(`${sourceType} workflow status preserves its exact analysis capabilities and diagnostics without GitHub or published claims`, async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository());
  const project = await repository.createProject(owner, {
    name: `Generic ${sourceType}`,
    sourceType,
    url: sourceType === "website" ? "https://widgets.example/" : "https://widgets.example/openapi.json",
    ...(sourceType === "openapi" ? {
      sourceConfiguration: {
        kind: "openapi" as const,
        targetOrigin: "https://widgets.example",
        testPageUrl: "https://widgets.example/",
        environment: "test" as const,
      },
    } : {}),
    idempotencyKey: `status-source-project-${sourceType}`,
    inputHash: `status-source-project-${sourceType}`,
  });
  const analysis = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: `status-source-analysis-${sourceType}`,
    inputHash: `status-source-analysis-${sourceType}`,
  });
  const plan = acmeCapabilityPlans("https://widgets.example")
    .find(({ tool }) => tool.name === "find_order")!;
  await processNextAnalysis(repository, {
    workerId: `status-source-worker-${sourceType}`,
    analyze: async () => ({
      capabilities: [{ plan, status: "proposed" }],
      diagnostics: [{
        code: "SERVER_ADAPTER_REQUIRED",
        operationKey: "POST /admin",
        reason: "api_key_header",
      }],
      evidence: acmeCapabilityEvidence().filter(({ reference }) =>
        plan.evidence.some((candidate) => candidate.reference === reference)),
      release: compileWebMcpRelease([plan]),
    }),
  });

  const headers = authenticatedHeaders(owner);
  const exported: WorkflowTelemetryBatch[] = [];
  setWorkflowTelemetrySinkForTest({ exportBatch: async (batch) => { exported.push(batch); } });
  const response = await getWorkflow(new Request(
    `https://control.example/api/workflow-runs/${analysis.id}`,
    { headers: { cookie: headers.cookie } },
  ), { params: Promise.resolve({ runId: analysis.id }) }).finally(() => {
    setWorkflowTelemetrySinkForTest(undefined);
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sourceType, sourceType);
  assert.deepEqual(body.capabilities.map(({ stableName }: { stableName: string }) => stableName), ["find_order"]);
  assert.deepEqual(body.diagnostics, [{
    code: "SERVER_ADAPTER_REQUIRED",
    operationKey: "POST /admin",
    reason: "api_key_header",
  }]);
  assert.equal(body.presentation.state, "unsupported");
  assert.equal(body.presentation.productionReady, false);
  assert.equal(body.outcome, "analysis_workflow_succeeded");
  assert.doesNotMatch(JSON.stringify(body), /draft.pull.request/i);
  assert.equal(exported.flatMap(({ observations }) => observations).length, body.events.length);
  assert.deepEqual(body.operational.telemetry, {
    configured: true,
    batches: 1,
    observations: body.events.length,
    exported: body.events.length,
    dropped: 0,
  });
  assert.equal(body.operational.metrics.workflow_queue_depth, 0);
  assert.equal(Array.isArray(body.operational.alerts), true);
});
