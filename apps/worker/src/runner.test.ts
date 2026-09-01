import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import {
  InMemoryControlPlaneRepository,
  type AnalysisResult,
  type ClaimedAnalysisRunRecord,
  type RepositoryActor,
} from "../../../packages/database/src/control-plane.ts";
import { computeSourceIdentityHash } from "../../../packages/database/src/source-identity.ts";
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

test("worker retries only the stable transient website control classification", async () => {
  for (const [code, status] of [
    ["WEBSITE_CONTROL_RETRYABLE", "queued"],
    ["WEBSITE_CONTROL_REJECTED", "failed"],
    ["WEBSITE_CONTROL_RESPONSE_INVALID", "failed"],
  ] as const) {
    const repository = new InMemoryControlPlaneRepository();
    const { run } = await enqueue(repository, "website", "https://acme.example/");
    const completed = await processNextAnalysis(repository, {
      workerId: `classification-${code.toLowerCase()}`,
      analyze: async () => { throw new Error(code); },
    });
    assert.equal(completed?.id, run.id);
    assert.equal(completed?.status, status);
    assert.equal(completed?.errorCode, code);
  }
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

test("worker atomically waits without completing or failing and a fresh worker resumes the claimed checkpoint", async () => {
  const repository = new InMemoryControlPlaneRepository(() => new Date("2026-09-01T12:00:00.000Z"));
  const { project, run } = await enqueue(repository, "website", "https://widgets.example/");
  const sourceIdentityHash = computeSourceIdentityHash("website", "https://widgets.example/", { kind: "website" });
  let completes = 0;
  let failures = 0;
  const complete = repository.completeAnalysis.bind(repository);
  const fail = repository.failAnalysis.bind(repository);
  repository.completeAnalysis = async (...args) => { completes += 1; return complete(...args); };
  repository.failAnalysis = async (...args) => { failures += 1; return fail(...args); };

  const waitingResult = await processNextAnalysis(repository, {
    workerId: "authentication-public-worker",
    analyze: async (source) => ({
      disposition: "waiting_for_authentication" as const,
      capabilities: [] as [],
      diagnostics: [] as [],
      evidence: [] as [],
      checkpointReference: `urn:sha256:${"a".repeat(64)}`,
      sourceSnapshotId: source.sourceSnapshotId!,
      sourceIdentityHash,
      targetOriginDigest: createHash("sha256").update("https://widgets.example").digest("hex"),
      expiresAt: "2026-09-01T12:09:00.000Z",
    }),
  });
  assert.equal(waitingResult, undefined);
  const waiting = await repository.getWebsiteAuthenticationWait(owner, run.id);
  assert.equal(waiting?.state, "waiting");
  assert.equal(completes, 0);
  assert.equal(failures, 0);
  assert.equal((await repository.getLatestAnalysis(owner, project.id))?.status, "waiting");
  assert.equal(await repository.claimAnalysis("must-not-claim-human-wait", 60_000, ["website"]), undefined);

  await repository.resumeAnalysisAfterAuthentication(owner, {
    runId: run.id,
    checkpointReference: `urn:sha256:${"a".repeat(64)}`,
    authenticationEvidenceReference: `urn:sha256:${"b".repeat(64)}`,
    sourceSnapshotId: waiting!.sourceSnapshotId,
    sourceIdentityHash,
    targetOriginDigest: createHash("sha256").update("https://widgets.example").digest("hex"),
    idempotencyKey: "resume-authentication-runner-test",
    inputHash: "c".repeat(64),
  });
  const completed = await processNextAnalysis(repository, {
    workerId: "authentication-resume-fresh-worker",
    analyze: async (source) => {
      assert.equal(source.authenticationCheckpoint?.checkpointReference, `urn:sha256:${"a".repeat(64)}`);
      assert.equal(source.authenticationCheckpoint?.authenticationEvidenceReference, `urn:sha256:${"b".repeat(64)}`);
      return fixtureAnalysisResult();
    },
  });
  assert.equal(completed?.status, "succeeded");
  assert.equal(completes, 1);
  assert.equal(failures, 0);
});

test("worker reconciles an externally created checkpoint when the database wait commit fails", async () => {
  const repository = new InMemoryControlPlaneRepository(() => new Date("2026-09-01T12:00:00.000Z"));
  await enqueue(repository, "website", "https://widgets.example/");
  const originalWait = repository.waitAnalysisForAuthentication.bind(repository);
  let reconciliations = 0;
  let simulateAmbiguousCommit = false;
  repository.waitAnalysisForAuthentication = async (...args) => {
    if (simulateAmbiguousCommit) await originalWait(...args);
    throw new Error("DATABASE_WAIT_COMMIT_FAILED");
  };
  const analyze = Object.assign(async (source: ClaimedAnalysisRunRecord) => ({
    disposition: "waiting_for_authentication" as const,
    capabilities: [] as [], diagnostics: [] as [], evidence: [] as [],
    checkpointReference: `urn:sha256:${"c".repeat(64)}`,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: computeSourceIdentityHash("website", "https://widgets.example/", { kind: "website" }),
    targetOriginDigest: createHash("sha256").update("https://widgets.example").digest("hex"),
    expiresAt: "2026-09-01T12:09:00.000Z",
  }), {
    reconcileAuthenticationCheckpoint: async () => { reconciliations += 1; },
  });
  const failed = await processNextAnalysis(repository, { workerId: "wait-commit-failure", analyze });
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.errorCode, "DATABASE_WAIT_COMMIT_FAILED");
  assert.equal(reconciliations, 1);

  const second = new InMemoryControlPlaneRepository(() => new Date("2026-09-01T12:00:00.000Z"));
  const { project, run } = await enqueue(second, "website", "https://widgets.example/");
  const secondWait = second.waitAnalysisForAuthentication.bind(second);
  second.waitAnalysisForAuthentication = async (...args) => { await secondWait(...args); throw new Error("DATABASE_RESPONSE_LOST"); };
  simulateAmbiguousCommit = true;
  await assert.rejects(processNextAnalysis(second, { workerId: "wait-ambiguous", analyze }), /LEASE_LOST/);
  assert.equal((await second.getLatestAnalysis(owner, project.id))?.status, "waiting");
  assert.equal((await second.getWebsiteAuthenticationWait(owner, run.id))?.state, "waiting");
  assert.equal(reconciliations, 2);
});
