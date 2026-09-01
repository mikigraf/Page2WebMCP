import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { CapabilityPlan } from "../../capability-ir/src/plan.ts";
import { compileWebMcpRelease } from "../../compiler/src/compiler.ts";
import {
  InMemoryControlPlaneRepository,
  RepositoryError,
  capabilityPlanDigest,
  type AnalysisResult,
  type RepositoryActor,
} from "./control-plane.ts";
import {
  WORKFLOW_PHASE_REGISTRY,
  WorkflowController,
  workflowRetryDelayMs,
  type WorkflowSideEffectPort,
  type WorkflowSideEffectRequest,
} from "./workflow.ts";

const ownerA: RepositoryActor = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role: "owner",
};
const ownerB: RepositoryActor = {
  id: "22222222-2222-2222-2222-222222222222",
  organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  role: "owner",
};

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function widgetPlan(reference: string): CapabilityPlan {
  return {
    version: 1,
    targetOrigin: "https://widgets.example",
    tool: { name: "list_widgets", title: "List widgets", description: "List the current account's widgets." },
    schemas: {
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      output: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string", maxLength: 64 } },
          required: ["id"],
          additionalProperties: false,
        },
        maxItems: 100,
      },
    },
    annotations: { readOnly: true, untrusted: false },
    authentication: { mode: "same_origin_cookie", requiredScopes: [] },
    effects: {
      kind: "read", riskTier: "R0", reversible: true,
      summary: "Reads widget summaries without changing them.", confirmation: "none",
    },
    idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    request: {
      adapter: "json_api", method: "GET", pathTemplate: "/api/widgets",
      path: {}, query: {}, body: {}, bodyEncoding: "json",
    },
    response: {
      adapter: "json_api", contentTypes: ["application/json"],
      projection: { kind: "array", fields: { id: "id" } },
      errorMappings: { default: "TARGET_ERROR" },
    },
    success: { adapter: "json_api", statusCodes: [200], requiredOutputFields: ["id"] },
    evidence: [{ source: "openapi", reference }],
  };
}

function analysisResult(): AnalysisResult {
  const content = JSON.stringify({ source: "bounded-openapi", version: 1 });
  const reference = `urn:sha256:${hash(content)}`;
  const plan = widgetPlan(reference);
  const release = compileWebMcpRelease([plan]);
  return {
    capabilities: [{ plan, status: "proposed" }],
    diagnostics: [],
    evidence: [{ source: "openapi", content, reference }],
    release: {
      code: release.code,
      contentHash: release.contentHash,
      allowedOrigin: release.allowedOrigin,
      manifest: release.manifest,
    },
  };
}

function mutationAnalysisResult(): AnalysisResult {
  const content = JSON.stringify({ source: "generic-github", version: 1 });
  const reference = `urn:sha256:${hash(content)}`;
  const plan: CapabilityPlan = {
    version: 1,
    targetOrigin: "https://widgets.example",
    tool: { name: "create_widget", title: "Create widget", description: "Creates one reviewed widget." },
    schemas: {
      input: { type: "object", properties: { title: { type: "string", maxLength: 120 } },
        required: ["title"], additionalProperties: false },
      output: { type: "object", properties: { id: { type: "string", maxLength: 64 } },
        required: ["id"], additionalProperties: false },
    },
    annotations: { readOnly: false, untrusted: false },
    authentication: { mode: "same_origin_cookie", requiredScopes: [] },
    effects: { kind: "mutation", riskTier: "R2", reversible: false,
      summary: "Creates one widget after explicit review.", confirmation: "always" },
    idempotency: { strategy: "none", verified: false, retry: "none" },
    request: { adapter: "json_api", method: "POST", pathTemplate: "/api/widgets", path: {}, query: {},
      body: { title: "title" }, optional: [], bodyEncoding: "json" },
    response: { adapter: "json_api", contentTypes: ["application/json"],
      projection: { kind: "object", fields: { id: "id" } }, errorMappings: { default: "TARGET_ERROR" } },
    success: { adapter: "json_api", statusCodes: [201], requiredOutputFields: ["id"] },
    evidence: [{ source: "github", reference }],
  };
  const release = compileWebMcpRelease([plan]);
  return {
    capabilities: [{ plan, status: "proposed" }], diagnostics: [],
    evidence: [{ source: "github", content, reference }],
    release: { code: release.code, contentHash: release.contentHash,
      allowedOrigin: release.allowedOrigin, manifest: release.manifest },
  };
}

async function completeAnalysisForProject(
  repository: InMemoryControlPlaneRepository,
  projectId: string,
  result: AnalysisResult,
  suffix: string,
) {
  const analysis = await repository.enqueueAnalysis(ownerA, {
    projectId, idempotencyKey: `analysis-${suffix}`, inputHash: `analysis-${suffix}`,
  });
  const claimed = await repository.claimAnalysis(`analysis-worker-${suffix}`, 60_000);
  assert.ok(claimed);
  await repository.completeAnalysis(`analysis-worker-${suffix}`, analysis.id, result, claimed.leaseGeneration);
  return analysis;
}

async function createProject(
  repository: InMemoryControlPlaneRepository,
  actor: RepositoryActor,
  suffix: string,
) {
  return repository.createProject(actor, {
    name: `Widgets ${suffix}`,
    sourceType: "openapi",
    url: `https://${suffix}.widgets.example/openapi.json`,
    sourceConfiguration: { kind: "openapi", targetOrigin: `https://${suffix}.widgets.example`, testPageUrl: `https://${suffix}.widgets.example/`, environment: "test" },
    idempotencyKey: `project-${suffix}`,
    inputHash: `project-${suffix}`,
  });
}

test("analysis lifecycle dual-writes immutable source, task, event, evidence, and plan links", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await createProject(repository, ownerA, "dual-write");
  const [source] = await repository.listProjectSources(ownerA, project.id);
  assert.equal(source?.sourceType, "openapi");
  assert.equal(source?.sourceUrl, "https://dual-write.widgets.example/openapi.json");
  assert.equal(source?.active, true);

  const [snapshot] = await repository.listSourceSnapshots(ownerA, project.id);
  assert.equal(snapshot?.projectSourceId, source?.id);
  assert.match(snapshot?.sourceIdentityHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(snapshot?.artifactReference, undefined);

  const analysis = await repository.enqueueAnalysis(ownerA, {
    projectId: project.id,
    idempotencyKey: "analysis-dual-write",
    inputHash: "analysis-dual-write",
  });
  const workflow = await repository.getWorkflowRun(ownerA, analysis.id);
  assert.equal(workflow.id, analysis.id);
  assert.equal(workflow.analysisRunId, analysis.id);
  assert.equal(workflow.sourceSnapshotId, snapshot?.id);
  assert.equal(workflow.status, "queued");
  assert.equal(workflow.currentPhase, "analysis");
  assert.deepEqual((await repository.listWorkflowEvents(ownerA, workflow.id)).map(({ sequence, version, type }) => (
    { sequence, version, type }
  )), [
    { sequence: 1, version: 1, type: "workflow.created" },
    { sequence: 2, version: 2, type: "task.created" },
  ]);

  const claimed = await repository.claimAnalysis("worker-dual-write", 60_000);
  assert.ok(claimed);
  assert.equal(claimed.workflowTaskId, (await repository.listWorkflowTasks(ownerA, workflow.id))[0]?.id);
  assert.equal(claimed.leaseGeneration, 1);
  now = new Date(now.getTime() + 15_000);
  await repository.heartbeatAnalysis("worker-dual-write", analysis.id, 60_000, claimed.leaseGeneration);
  const completed = await repository.completeAnalysis(
    "worker-dual-write", analysis.id, analysisResult(), claimed.leaseGeneration,
  );
  assert.equal(completed.status, "succeeded");
  assert.equal((await repository.getWorkflowRun(ownerA, workflow.id)).status, "succeeded");
  const [task] = await repository.listWorkflowTasks(ownerA, workflow.id);
  assert.equal(task?.status, "succeeded");
  assert.match(task?.outputHash ?? "", /^[0-9a-f]{64}$/);
  const evidenceLinks = await repository.listWorkflowEvidence(ownerA, workflow.id);
  assert.deepEqual(evidenceLinks.map(({ reference }) => reference), analysisResult().evidence.map(({ reference }) => reference));
  const planLinks = await repository.listWorkflowCapabilityPlans(ownerA, workflow.id);
  assert.deepEqual(planLinks.map(({ planDigest }) => planDigest), [capabilityPlanDigest(analysisResult().capabilities[0]!.plan)]);
});

test("task completion and next-task creation are atomic, legal, and command-idempotent", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await createProject(repository, ownerA, "transitions");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-transitions", inputHash: "workflow-transitions",
  });
  const claimed = await repository.claimWorkflowTask("worker-transitions");
  assert.equal(claimed?.phase, "preflight");
  assert.ok(claimed);
  const before = await repository.listWorkflowEvents(ownerA, run.id);

  await assert.rejects(repository.completeWorkflowTask("worker-transitions", claimed.id, claimed.leaseGeneration + 1, {
    idempotencyKey: "complete-preflight", inputHash: "complete-preflight",
    outputReference: `urn:sha256:${"a".repeat(64)}`,
  }), (error: unknown) => error instanceof RepositoryError && error.code === "LEASE_LOST");
  assert.deepEqual(await repository.listWorkflowEvents(ownerA, run.id), before);

  const completion = await repository.completeWorkflowTask("worker-transitions", claimed.id, claimed.leaseGeneration, {
    idempotencyKey: "complete-preflight", inputHash: "complete-preflight",
    outputReference: `urn:sha256:${"a".repeat(64)}`,
  });
  assert.equal(completion.task.status, "succeeded");
  assert.equal(completion.nextTask?.phase, "ownership");
  assert.equal(completion.run.currentPhase, "ownership");
  const after = await repository.listWorkflowEvents(ownerA, run.id);
  assert.deepEqual(after.slice(-2).map(({ type }) => type), ["task.completed", "task.created"]);

  const replay = await repository.completeWorkflowTask("worker-transitions", claimed.id, claimed.leaseGeneration, {
    idempotencyKey: "complete-preflight", inputHash: "complete-preflight",
    outputReference: `urn:sha256:${"a".repeat(64)}`,
  });
  assert.equal(replay.nextTask?.id, completion.nextTask?.id);
  assert.equal((await repository.listWorkflowEvents(ownerA, run.id)).length, after.length);
  await assert.rejects(repository.completeWorkflowTask("worker-transitions", claimed.id, claimed.leaseGeneration, {
    idempotencyKey: "complete-preflight", inputHash: "changed-command",
    outputReference: `urn:sha256:${"a".repeat(64)}`,
  }), (error: unknown) => error instanceof RepositoryError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await repository.listWorkflowTasks(ownerA, run.id)).filter(({ phase }) => phase === "ownership").length, 1);
});

test("lease generation rejects stale completion and cancellation persists before propagation", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await createProject(repository, ownerA, "lease-cancel");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-lease-cancel", inputHash: "workflow-lease-cancel",
  });
  const first = await repository.claimWorkflowTask("same-worker");
  assert.ok(first);
  now = new Date(now.getTime() + 60_001);
  const reclaimed = await repository.claimWorkflowTask("same-worker");
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, first.id);
  assert.equal(reclaimed.leaseGeneration, 2);
  await assert.rejects(repository.completeWorkflowTask("same-worker", first.id, first.leaseGeneration, {
    idempotencyKey: "stale-complete", inputHash: "stale-complete",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "LEASE_LOST");

  const cancelled = await repository.cancelWorkflow(ownerA, {
    runId: run.id, idempotencyKey: "cancel-run", inputHash: "cancel-run",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelRequestedAt);
  const events = await repository.listWorkflowEvents(ownerA, run.id);
  assert.deepEqual(events.slice(-3).map(({ type }) => type), [
    "workflow.cancel_requested", "task.cancelled", "workflow.cancelled",
  ]);
  await assert.rejects(repository.completeWorkflowTask("same-worker", reclaimed.id, reclaimed.leaseGeneration, {
    idempotencyKey: "complete-after-cancel", inputHash: "complete-after-cancel",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "CANCELLED");
  assert.equal(await repository.claimWorkflowTask("other-worker"), undefined);
});

test("durable waits consume no worker and resume tokens are opaque, scoped, expiring, and replay-safe", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await createProject(repository, ownerA, "wait-resume");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-wait", inputHash: "workflow-wait",
  });
  const preflight = await repository.claimWorkflowTask("worker-wait");
  assert.ok(preflight);
  await repository.completeWorkflowTask("worker-wait", preflight.id, preflight.leaseGeneration, {
    idempotencyKey: "complete-to-ownership", inputHash: "complete-to-ownership",
  });
  const ownership = await repository.claimWorkflowTask("worker-wait");
  assert.equal(ownership?.phase, "ownership");
  assert.ok(ownership);
  const waiting = await repository.waitWorkflowTask("worker-wait", ownership.id, ownership.leaseGeneration, {
    idempotencyKey: "wait-for-owner", inputHash: "wait-for-owner", reason: "ownership_proof",
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  assert.match(waiting.waitToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(waiting.task.waitKeyHash?.includes(waiting.waitToken), false);
  assert.equal((await repository.getWorkflowRun(ownerA, run.id)).status, "waiting");
  assert.equal(await repository.claimWorkflowTask("worker-idle"), undefined);

  await assert.rejects(repository.resumeWorkflowTask(ownerB, {
    runId: run.id, waitToken: waiting.waitToken, idempotencyKey: "resume-owner", inputHash: "resume-owner",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "NOT_FOUND");
  const resumed = await repository.resumeWorkflowTask(ownerA, {
    runId: run.id, waitToken: waiting.waitToken, idempotencyKey: "resume-owner", inputHash: "resume-owner",
  });
  assert.equal(resumed.status, "queued");
  const beforeReplay = (await repository.listWorkflowEvents(ownerA, run.id)).length;
  assert.equal((await repository.resumeWorkflowTask(ownerA, {
    runId: run.id, waitToken: waiting.waitToken, idempotencyKey: "resume-owner", inputHash: "resume-owner",
  })).id, resumed.id);
  assert.equal((await repository.listWorkflowEvents(ownerA, run.id)).length, beforeReplay);
  assert.equal((await repository.claimWorkflowTask("worker-resumed"))?.id, ownership.id);

  const expiryProject = await createProject(repository, ownerA, "wait-expiry");
  const expiryRun = await repository.startWorkflow(ownerA, {
    projectId: expiryProject.id, idempotencyKey: "workflow-wait-expiry", inputHash: "workflow-wait-expiry",
  });
  const expiryTask = await repository.claimWorkflowTask("worker-expiry");
  assert.ok(expiryTask);
  const expiring = await repository.waitWorkflowTask("worker-expiry", expiryTask.id, expiryTask.leaseGeneration, {
    idempotencyKey: "wait-expiring", inputHash: "wait-expiring", reason: "external_authentication",
    expiresAt: new Date(now.getTime() + 1_000).toISOString(),
  });
  now = new Date(now.getTime() + 1_001);
  await assert.rejects(repository.resumeWorkflowTask(ownerA, {
    runId: expiryRun.id, waitToken: expiring.waitToken,
    idempotencyKey: "resume-expired", inputHash: "resume-expired",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "WAIT_EXPIRED");
});

test("tenant-aware claims enforce quotas and transient retries use bounded full jitter", async () => {
  assert.equal(workflowRetryDelayMs(1, undefined, () => 0.5), 500);
  assert.equal(workflowRetryDelayMs(2, undefined, () => 0.5), 1_000);
  assert.equal(workflowRetryDelayMs(3, 900_000, () => 0.5), 300_000);
  let now = new Date("2026-08-30T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now, { random: () => 0.5, activeTaskQuota: 2 });
  for (const suffix of ["fair-a1", "fair-a2", "fair-a3"]) {
    const project = await createProject(repository, ownerA, suffix);
    await repository.startWorkflow(ownerA, {
      projectId: project.id, idempotencyKey: `workflow-${suffix}`, inputHash: `workflow-${suffix}`,
    });
  }
  const projectB = await createProject(repository, ownerB, "fair-b1");
  await repository.startWorkflow(ownerB, {
    projectId: projectB.id, idempotencyKey: "workflow-fair-b1", inputHash: "workflow-fair-b1",
  });
  const first = await repository.claimWorkflowTask("fair-worker-1");
  const second = await repository.claimWorkflowTask("fair-worker-2");
  assert.deepEqual(new Set([first?.organizationId, second?.organizationId]),
    new Set([ownerA.organizationId, ownerB.organizationId]));
  const third = await repository.claimWorkflowTask("fair-worker-3");
  assert.equal(third?.organizationId, ownerA.organizationId);
  assert.equal(await repository.claimWorkflowTask("quota-worker"), undefined);
  assert.ok(first);
  const retry = await repository.failWorkflowTask("fair-worker-1", first.id, first.leaseGeneration, {
    idempotencyKey: "retry-transient", inputHash: "retry-transient",
    errorCode: "PROVIDER_UNAVAILABLE", classification: "transient",
  });
  assert.equal(retry.status, "queued");
  assert.equal(retry.retryClassification, "transient");
  assert.equal(retry.availableAt, new Date(now.getTime() + 500).toISOString());
  const unrelated = await repository.claimWorkflowTask("too-early");
  assert.notEqual(unrelated?.id, first.id);
  if (unrelated) {
    await repository.cancelWorkflow(ownerA, {
      runId: unrelated.workflowRunId, idempotencyKey: "cancel-unrelated", inputHash: "cancel-unrelated",
    });
  }
  now = new Date(now.getTime() + 501);
  const retried = await repository.claimWorkflowTask("retry-worker");
  assert.equal(retried?.id, first.id);
  assert.equal(retried?.attempts, 2);
});

test("compatibility analysis claims share tenant fairness and active workflow quotas", async () => {
  const repository = new InMemoryControlPlaneRepository(undefined, { activeTaskQuota: 2 });
  for (const suffix of ["analysis-fair-a1", "analysis-fair-a2", "analysis-fair-a3"]) {
    const project = await createProject(repository, ownerA, suffix);
    await repository.enqueueAnalysis(ownerA, {
      projectId: project.id, idempotencyKey: `enqueue-${suffix}`, inputHash: `enqueue-${suffix}`,
    });
  }
  const projectB = await createProject(repository, ownerB, "analysis-fair-b1");
  await repository.enqueueAnalysis(ownerB, {
    projectId: projectB.id, idempotencyKey: "enqueue-analysis-fair-b1", inputHash: "enqueue-analysis-fair-b1",
  });
  const first = await repository.claimAnalysis("analysis-fair-1", 60_000);
  const second = await repository.claimAnalysis("analysis-fair-2", 60_000);
  assert.deepEqual(new Set([first?.organizationId, second?.organizationId]),
    new Set([ownerA.organizationId, ownerB.organizationId]));
  assert.equal((await repository.claimAnalysis("analysis-fair-3", 60_000))?.organizationId, ownerA.organizationId);
  assert.equal(await repository.claimAnalysis("analysis-quota", 60_000), undefined);
});

test("reconciliation idempotently requeues expired leases and phase registry has controller-only transitions", async () => {
  assert.deepEqual(WORKFLOW_PHASE_REGISTRY.map(({ phase, execution }) => [phase, execution]), [
    ["preflight", "worker"], ["ownership", "wait"], ["browser_auth", "wait"], ["explore", "worker"],
    ["propose", "worker"], ["review_wait", "wait"], ["controlled_mutation_verification", "worker"],
    ["compile", "worker"], ["candidate_verify", "worker"], ["publish", "worker"], ["install_verify", "worker"],
  ]);
  let now = new Date("2026-08-30T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await createProject(repository, ownerA, "reconcile");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-reconcile", inputHash: "workflow-reconcile",
  });
  const claimed = await repository.claimWorkflowTask("crashed-worker");
  assert.ok(claimed);
  now = new Date(now.getTime() + 60_001);
  assert.equal(await repository.reconcileWorkflows("reconciler-a"), 1);
  assert.equal(await repository.reconcileWorkflows("reconciler-a"), 0);
  const repaired = (await repository.listWorkflowTasks(ownerA, run.id))[0]!;
  assert.equal(repaired.status, "queued");
  assert.ok(repaired.reconciledAt);
  assert.equal((await repository.claimWorkflowTask("replacement-worker"))?.leaseGeneration, 2);
});

test("in-memory reconciliation repairs exactly one missing adjacent task with the completed output hash", async () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  let injectCompletionCrash = false;
  let completionClockCalls = 0;
  const repository = new InMemoryControlPlaneRepository(() => {
    if (injectCompletionCrash && ++completionClockCalls === 5) throw new Error("SIMULATED_COMPLETION_CRASH");
    return now;
  });
  const project = await createProject(repository, ownerA, "missing-next");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-missing-next", inputHash: "workflow-missing-next",
  });
  const claimed = await repository.claimWorkflowTask("missing-next-worker");
  assert.ok(claimed);
  injectCompletionCrash = true;
  await assert.rejects(repository.completeWorkflowTask(
    "missing-next-worker", claimed.id, claimed.leaseGeneration, {
      idempotencyKey: "complete-before-crash", inputHash: "complete-before-crash",
      outputReference: `urn:sha256:${"d".repeat(64)}`,
    },
  ), /SIMULATED_COMPLETION_CRASH/);
  injectCompletionCrash = false;

  const [completed] = await repository.listWorkflowTasks(ownerA, run.id);
  assert.equal(completed?.phase, "preflight");
  assert.equal(completed?.status, "succeeded");
  assert.ok(completed?.outputHash);
  assert.equal(await repository.reconcileWorkflows("missing-next-reconciler"), 1);
  assert.equal(await repository.reconcileWorkflows("missing-next-reconciler"), 0);
  const tasks = await repository.listWorkflowTasks(ownerA, run.id);
  assert.deepEqual(new Set(tasks.map(({ phase }) => phase)), new Set(["preflight", "ownership"]));
  assert.equal(tasks.find(({ phase }) => phase === "ownership")?.inputHash, completed.outputHash);
});

test("a fresh controller resumes deterministically from every persisted phase boundary", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await createProject(repository, ownerA, "phase-restarts");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-phase-restarts", inputHash: "workflow-phase-restarts",
  });
  for (const { phase } of WORKFLOW_PHASE_REGISTRY) {
    const controller = new WorkflowController(repository, {
      handlers: { [phase]: async () => ({}) },
      sideEffects: {},
    });
    const completed = await controller.runNext(`restart-${phase}`);
    assert.equal(completed?.phase, phase);
    assert.equal(completed?.status, "succeeded");
  }
  assert.equal((await repository.getWorkflowRun(ownerA, run.id)).status, "succeeded");
  assert.deepEqual(new Set((await repository.listWorkflowTasks(ownerA, run.id)).map(({ phase }) => phase)),
    new Set(WORKFLOW_PHASE_REGISTRY.map(({ phase }) => phase)));
  const events = await repository.listWorkflowEvents(ownerA, run.id);
  assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
});

test("controller serializes heartbeats while a phase handler is active", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await createProject(repository, ownerA, "controller-heartbeat");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-heartbeat", inputHash: "workflow-heartbeat",
  });
  const originalHeartbeat = repository.heartbeatWorkflowTask.bind(repository);
  let activeHeartbeats = 0;
  let maximumActiveHeartbeats = 0;
  let heartbeatCount = 0;
  let observedTwoHeartbeats!: () => void;
  const twoHeartbeats = new Promise<void>((resolve) => { observedTwoHeartbeats = resolve; });
  repository.heartbeatWorkflowTask = async (...arguments_: Parameters<typeof originalHeartbeat>) => {
    activeHeartbeats += 1;
    maximumActiveHeartbeats = Math.max(maximumActiveHeartbeats, activeHeartbeats);
    try {
      await delay(15);
      return await originalHeartbeat(...arguments_);
    } finally {
      activeHeartbeats -= 1;
      heartbeatCount += 1;
      if (heartbeatCount === 2) observedTwoHeartbeats();
    }
  };
  const controller = new WorkflowController(repository, {
    handlers: {
      preflight: async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            twoHeartbeats,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("HEARTBEATS_NOT_OBSERVED")), 1_000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        return {};
      },
    },
    sideEffects: {},
    heartbeatMs: 10,
  });
  assert.equal((await controller.runNext("heartbeat-worker"))?.status, "succeeded");
  assert.equal(maximumActiveHeartbeats, 1);
  assert.equal((await repository.listWorkflowEvents(ownerA, run.id))
    .filter(({ type }) => type === "task.heartbeat").length, 2);
});

test("controller treats deterministic configuration failures as permanent", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await createProject(repository, ownerA, "permanent-phase-failure");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id,
    idempotencyKey: "workflow-permanent-phase-failure",
    inputHash: "workflow-permanent-phase-failure",
  });
  const controller = new WorkflowController(repository, {
    handlers: {
      preflight: async () => { throw new Error("WORKFLOW_PHASE_CONFIGURATION_INVALID"); },
    },
    sideEffects: {},
  });
  await assert.rejects(controller.runNext("permanent-failure-worker"), /WORKFLOW_PHASE_CONFIGURATION_INVALID/);
  const [failed] = await repository.listWorkflowTasks(ownerA, run.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.retryClassification, "permanent");
  assert.equal(failed?.attempts, 1);
});

test("controller preserves a typed rate-limit failure and bounds Retry-After", async () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now, { random: () => 0 });
  const project = await createProject(repository, ownerA, "rate-limited-phase");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id,
    idempotencyKey: "workflow-rate-limited-phase",
    inputHash: "workflow-rate-limited-phase",
  });
  const controller = new WorkflowController(repository, {
    handlers: {
      preflight: async () => ({
        checkpointReference: undefined,
        failure: {
          errorCode: "PROVIDER_RATE_LIMITED",
          classification: "rate_limited" as const,
          retryAfterMs: 900_000,
        },
      }),
    },
    sideEffects: {},
  });
  const failed = await controller.runNext("rate-limited-worker");
  assert.equal(failed?.status, "queued");
  assert.equal(failed?.retryClassification, "rate_limited");
  assert.equal(failed?.availableAt, new Date(now.getTime() + 300_000).toISOString());
  assert.equal((await repository.getWorkflowRun(ownerA, run.id)).status, "queued");
});

test("controller proves the lease before stable side effects, reconciles once, and always cleans up", async () => {
  let now = new Date("2026-08-30T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await createProject(repository, ownerA, "controller");
  const controllerRun = await repository.startWorkflow(ownerA, {
    projectId: project.id, idempotencyKey: "workflow-controller", inputHash: "workflow-controller",
  });
  const events: string[] = [];
  const sideEffect: WorkflowSideEffectPort = {
    lookup: async () => { events.push("lookup"); return undefined; },
    execute: async ({ idempotencyKey }) => {
      events.push(`execute:${idempotencyKey}`);
      throw new Error("AMBIGUOUS_PROVIDER_RESULT");
    },
    reconcile: async ({ idempotencyKey }) => {
      events.push(`reconcile:${idempotencyKey}`);
      return { outputReference: `urn:sha256:${"b".repeat(64)}`, outputHash: "b".repeat(64) };
    },
    cleanup: async ({ idempotencyKey }) => { events.push(`cleanup:${idempotencyKey}`); },
  };
  const controller = new WorkflowController(repository, {
    handlers: {
      preflight: async ({ sideEffect: runSideEffect }) => {
        const result = await runSideEffect("browser_session_create", "input-v1");
        return { outputReference: result.outputReference };
      },
    },
    sideEffects: { browser_session_create: sideEffect },
  });
  const completed = await controller.runNext("controller-worker");
  assert.equal(completed?.status, "succeeded");
  assert.equal(events[0], "lookup");
  assert.match(events[1] ?? "", /^execute:wfx_[0-9a-f]{64}$/);
  assert.equal(events[2], events[1]!.replace("execute:", "reconcile:"));
  assert.equal(events[3], events[1]!.replace("execute:", "cleanup:"));
  await repository.cancelWorkflow(ownerA, {
    runId: controllerRun.id, idempotencyKey: "cancel-controller-run", inputHash: "cancel-controller-run",
  });

  const leaseProject = await createProject(repository, ownerA, "controller-lease-loss");
  await repository.startWorkflow(ownerA, {
    projectId: leaseProject.id, idempotencyKey: "workflow-controller-lease", inputHash: "workflow-controller-lease",
  });
  let executed = false;
  const leaseController = new WorkflowController(repository, {
    handlers: {
      preflight: async ({ sideEffect: runSideEffect }) => {
        now = new Date(now.getTime() + 60_001);
        await runSideEffect("must_not_run", "input-v1");
        return {};
      },
    },
    sideEffects: {
      must_not_run: {
        lookup: async () => undefined,
        execute: async () => { executed = true; return { outputReference: `urn:sha256:${"c".repeat(64)}`, outputHash: "c".repeat(64) }; },
        reconcile: async () => undefined,
        cleanup: async () => undefined,
      },
    },
  });
  await assert.rejects(leaseController.runNext("lease-controller-worker"), (error: unknown) =>
    error instanceof RepositoryError && error.code === "LEASE_LOST");
  assert.equal(executed, false);
});

test("diagnostic-only analysis terminates without verification, publication, or installation tasks", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await createProject(repository, ownerA, "diagnostic-only");
  const run = await repository.enqueueAnalysis(ownerA, {
    projectId: project.id, idempotencyKey: "analysis-diagnostic", inputHash: "analysis-diagnostic",
  });
  const claimed = await repository.claimAnalysis("diagnostic-worker", 60_000);
  assert.ok(claimed);
  const content = JSON.stringify({ source: "unsupported-openapi", version: 1 });
  await repository.completeAnalysis("diagnostic-worker", run.id, {
    capabilities: [],
    diagnostics: [{ code: "SERVER_ADAPTER_REQUIRED", operationKey: "GET /private", reason: "api_key_header" }],
    evidence: [{ source: "openapi", content, reference: `urn:sha256:${hash(content)}` }],
  }, claimed.leaseGeneration);
  assert.deepEqual((await repository.listWorkflowTasks(ownerA, run.id)).map(({ phase }) => phase), ["analysis"]);
  assert.deepEqual(await repository.listWorkflowCapabilityPlans(ownerA, run.id), []);
  assert.equal((await repository.getWorkflowRun(ownerA, run.id)).status, "succeeded");
});

test("GitHub workflow binds the exact reviewed analysis and exposes lease-scoped execution material", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(ownerA, {
    name: "Bright tools widget console", sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "project-github-reviewed-binding", inputHash: "project-github-reviewed-binding",
  });
  const analysis = await completeAnalysisForProject(repository, project.id, mutationAnalysisResult(), "github-reviewed-binding");
  await assert.rejects(repository.startWorkflow(ownerA, {
    projectId: project.id, analysisRunId: analysis.id,
    idempotencyKey: "workflow-before-review", inputHash: "workflow-before-review",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  const [capability] = await repository.listAnalysisCapabilities(ownerA, analysis.id);
  assert.ok(capability);
  await repository.reviewCapability(ownerA, capability.id, { action: "approve", expectedVersion: capability.version });
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id, analysisRunId: analysis.id,
    idempotencyKey: "workflow-reviewed", inputHash: "workflow-reviewed",
  });
  assert.equal(run.reviewedAnalysisRunId, analysis.id);
  assert.equal(
    (await repository.getLatestReviewedWorkflowForAnalysis(ownerA, project.id, analysis.id))?.id,
    run.id,
  );
  assert.equal(
    await repository.getLatestReviewedWorkflowForAnalysis(
      ownerA,
      project.id,
      "00000000-0000-4000-8000-000000000000",
    ),
    undefined,
  );
  const task = await repository.claimWorkflowTask("github-material-worker");
  assert.ok(task);
  const material = await repository.getWorkflowExecutionMaterial(
    "github-material-worker", task.id, task.leaseGeneration,
  );
  assert.equal(material.workflowRunId, run.id);
  assert.equal(material.analysisRunId, analysis.id);
  assert.equal(material.sourceType, "github");
  assert.equal(material.sourceUrl, project.url);
  assert.deepEqual(material.capabilities.map(({ stableName, status }) => ({ stableName, status })), [
    { stableName: "create_widget", status: "reviewed" },
  ]);
  await assert.rejects(repository.getWorkflowExecutionMaterial(
    "github-material-worker", task.id, task.leaseGeneration + 1,
  ), (error: unknown) => error instanceof RepositoryError && error.code === "LEASE_LOST");
});

test("reviewed analysis workflow binding rejects cross-project and blocked authorization", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const first = await repository.createProject(ownerA, {
    name: "First repository", sourceType: "github", url: "https://github.com/bright-tools/first",
    idempotencyKey: "project-first-binding", inputHash: "project-first-binding",
  });
  const second = await repository.createProject(ownerA, {
    name: "Second repository", sourceType: "github", url: "https://github.com/bright-tools/second",
    idempotencyKey: "project-second-binding", inputHash: "project-second-binding",
  });
  const analysis = await completeAnalysisForProject(repository, first.id, mutationAnalysisResult(), "cross-project-binding");
  const [capability] = await repository.listAnalysisCapabilities(ownerA, analysis.id);
  assert.ok(capability);
  await repository.reviewCapability(ownerA, capability.id, { action: "block", expectedVersion: capability.version });
  await assert.rejects(repository.startWorkflow(ownerA, {
    projectId: first.id, analysisRunId: analysis.id,
    idempotencyKey: "workflow-blocked", inputHash: "workflow-blocked",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  await assert.rejects(repository.startWorkflow(ownerA, {
    projectId: second.id, analysisRunId: analysis.id,
    idempotencyKey: "workflow-cross-project", inputHash: "workflow-cross-project",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
});

test("controller binds every side effect to the exact worker lease and workflow task", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await createProject(repository, ownerA, "side-effect-lease-identity");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id,
    idempotencyKey: "workflow-side-effect-lease-identity",
    inputHash: "workflow-side-effect-lease-identity",
  });
  const requests: WorkflowSideEffectRequest[] = [];
  const outputHash = "e".repeat(64);
  const controller = new WorkflowController(repository, {
    handlers: { preflight: async ({ sideEffect }) => ({
      outputReference: (await sideEffect("fixture.effect", "f".repeat(64))).outputReference,
    }) },
    sideEffects: { "fixture.effect": {
      lookup: async (request) => { requests.push(request); return undefined; },
      execute: async () => ({ outputReference: `urn:sha256:${outputHash}`, outputHash }),
      reconcile: async () => undefined,
      cleanup: async () => undefined,
    } },
  });
  const task = await controller.runNext("worker-exact-lease");
  assert.ok(task);
  assert.equal(requests.length, 1);
  assert.deepEqual({
    workerId: requests[0]!.workerId,
    taskId: requests[0]!.taskId,
    workflowRunId: requests[0]!.workflowRunId,
    phase: requests[0]!.phase,
    leaseGeneration: requests[0]!.leaseGeneration,
  }, {
    workerId: "worker-exact-lease",
    taskId: task.id,
    workflowRunId: run.id,
    phase: "preflight",
    leaseGeneration: 1,
  });
});

test("controller durably records redacted correlated side-effect start and terminal events", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await createProject(repository, ownerA, "side-effect-observability");
  const run = await repository.startWorkflow(ownerA, {
    projectId: project.id,
    idempotencyKey: "workflow-side-effect-observability",
    inputHash: "workflow-side-effect-observability",
  });
  const inputHash = "1".repeat(64);
  const outputHash = "2".repeat(64);
  const controller = new WorkflowController(repository, {
    handlers: { preflight: async ({ sideEffect }) => ({
      outputReference: (await sideEffect("github.snapshot.read", inputHash)).outputReference,
    }) },
    sideEffects: { "github.snapshot.read": {
      lookup: async () => undefined,
      execute: async () => ({
        outputReference: `urn:sha256:${outputHash}`,
        outputHash,
        version: "github-api-2022-11-28",
        costMicros: 17,
      }),
      reconcile: async () => undefined,
      cleanup: async () => undefined,
    } },
  });

  await controller.runNext("worker-side-effect-observability");
  const sideEffects = (await repository.listWorkflowEvents(ownerA, run.id))
    .filter(({ type }) => type.startsWith("task.side_effect_"));
  assert.deepEqual(sideEffects.map(({ type, payload }) => ({ type, payload })), [
    {
      type: "task.side_effect_started",
      payload: { operation: "github.snapshot.read", inputHash },
    },
    {
      type: "task.side_effect_completed",
      payload: {
        operation: "github.snapshot.read",
        inputHash,
        outputHash,
        version: "github-api-2022-11-28",
        costMicros: 17,
        durationMs: sideEffects[1]?.payload?.durationMs,
      },
    },
  ]);
  assert.equal(typeof sideEffects[1]?.payload?.durationMs, "number");
  assert.equal(sideEffects.every(({ workflowRunId, taskId }) => workflowRunId === run.id && Boolean(taskId)), true);
  await repository.cancelWorkflow(ownerA, {
    runId: run.id,
    idempotencyKey: "cancel-side-effect-observability",
    inputHash: "cancel-side-effect-observability",
  });

  const failedProject = await createProject(repository, ownerA, "side-effect-observability-failed");
  const failedRun = await repository.startWorkflow(ownerA, {
    projectId: failedProject.id,
    idempotencyKey: "workflow-side-effect-observability-failed",
    inputHash: "workflow-side-effect-observability-failed",
  });
  const failedController = new WorkflowController(repository, {
    handlers: { preflight: async ({ sideEffect }) => {
      await sideEffect("browser.observe", "3".repeat(64));
      return {};
    } },
    sideEffects: { "browser.observe": {
      lookup: async () => undefined,
      execute: async () => { throw new Error("Bearer secret-token user@example.test"); },
      reconcile: async () => undefined,
      cleanup: async () => undefined,
    } },
  });
  await assert.rejects(
    failedController.runNext("worker-side-effect-observability-failed"),
    /secret-token/,
  );
  const failedEvents = await repository.listWorkflowEvents(ownerA, failedRun.id);
  const failedSideEffect = failedEvents.find(({ type }) => type === "task.side_effect_failed");
  assert.deepEqual(failedSideEffect?.payload, {
    operation: "browser.observe",
    inputHash: "3".repeat(64),
    durationMs: failedSideEffect?.payload?.durationMs,
    outcome: "failure",
  });
  assert.doesNotMatch(JSON.stringify(failedEvents), /secret-token|example\.test|Bearer/i);
});
