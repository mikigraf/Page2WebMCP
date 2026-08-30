import assert from "node:assert/strict";
import test from "node:test";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import { InMemoryControlPlaneRepository, type AnalysisResult, type RepositoryActor } from "../../../packages/database/src/control-plane.ts";
import { processNextAnalysis } from "./runner.ts";

const owner: RepositoryActor = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role: "owner"
};

async function enqueue(
  repository: InMemoryControlPlaneRepository,
  sourceType: "website" | "openapi" | "github",
  url: string
) {
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType,
    url,
    idempotencyKey: `project-${sourceType}-${crypto.randomUUID()}`,
    inputHash: `${sourceType}:${url}`
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: `analysis-${sourceType}-${crypto.randomUUID()}`,
    inputHash: project.id
  });
  return { project, run };
}

function fixtureAnalysisResult(): AnalysisResult {
  const plans = acmeCapabilityPlans("https://acme.example").slice(0, 1);
  const release = compileWebMcpRelease(plans);
  return {
    capabilities: plans.map((plan) => ({ plan, status: "proposed" })),
    diagnostics: [],
    evidence: acmeCapabilityEvidence().filter(({ reference }) =>
      plans.some((plan) => plan.evidence.some((item) => item.reference === reference))),
    release
  };
}

test("worker fails closed when no analysis adapter is configured", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const { run } = await enqueue(repository, "github", "https://code.widgets.example/team/repository");
  const completed = await processNextAnalysis(repository, { workerId: "unconfigured-worker" });
  assert.equal(completed?.id, run.id);
  assert.equal(completed?.status, "failed");
  assert.equal(completed?.errorCode, "ANALYZER_NOT_CONFIGURED");
});

test("worker binds the persisted source to the explicit analysis adapter", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const { run } = await enqueue(repository, "website", "https://unexpected.example/");
  const completed = await processNextAnalysis(repository, {
    workerId: "scope-worker",
    analyze: async (source) => {
      assert.equal(source.sourceType, "website");
      assert.equal(source.sourceUrl, "https://unexpected.example/");
      throw new Error("SOURCE_SCOPE_MISMATCH");
    },
  });
  assert.equal(completed?.id, run.id);
  assert.equal(completed?.status, "failed");
  assert.equal(completed?.attempts, 1);
  assert.equal(completed?.errorCode, "SOURCE_SCOPE_MISMATCH");
});

test("worker processing never needs member-scoped repository reads", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const { run } = await enqueue(repository, "website", "https://acme.example/");
  repository.getProject = async () => { throw new Error("APP_CONTEXT_FORBIDDEN"); };
  repository.getAnalysis = async () => { throw new Error("APP_CONTEXT_FORBIDDEN"); };

  const result = fixtureAnalysisResult();
  const completed = await processNextAnalysis(repository, { workerId: "worker-only", analyze: async () => result });

  assert.equal(completed?.id, run.id);
  assert.equal(completed?.status, "succeeded");
});

test("analysis deadline aborts work and returns the durable job to the bounded retry queue", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const { run } = await enqueue(repository, "website", "https://acme.example/");
  let observedAbort = false;
  const completed = await processNextAnalysis(repository, {
    workerId: "deadline-worker",
    deadlineMs: 10,
    heartbeatMs: 10,
    analyze: async (_project, signal) => new Promise<AnalysisResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    })
  });
  assert.equal(observedAbort, true);
  assert.equal(completed?.id, run.id);
  assert.equal(completed?.status, "queued");
  assert.equal(completed?.attempts, 1);
  assert.equal(completed?.errorCode, "ANALYSIS_DEADLINE_EXCEEDED");
});

test("heartbeats are serialized and stop before completion", async () => {
  const repository = new InMemoryControlPlaneRepository();
  await enqueue(repository, "website", "https://acme.example/");
  const originalHeartbeat = repository.heartbeatAnalysis.bind(repository);
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  let finishAnalysis!: () => void;
  const enoughHeartbeats = new Promise<void>((resolve) => { finishAnalysis = resolve; });
  repository.heartbeatAnalysis = async (...args) => {
    active += 1;
    calls += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await originalHeartbeat(...args);
      if (calls === 2) finishAnalysis();
    } finally {
      active -= 1;
    }
  };
  const result = fixtureAnalysisResult();
  const completed = await processNextAnalysis(repository, {
    workerId: "heartbeat-worker",
    heartbeatMs: 10,
    analyze: async () => {
      await enoughHeartbeats;
      return result;
    }
  });
  assert.equal(completed?.status, "succeeded");
  assert.ok(calls >= 2);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});
