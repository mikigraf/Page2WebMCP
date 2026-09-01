import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryControlPlaneRepository,
  RepositoryError,
  type ClaimedAnalysisRunRecord,
  type ControlPlaneRepository,
  type RepositoryActor,
  type ResumeAnalysisAfterAuthenticationInput,
  type WaitAnalysisForAuthenticationInput,
} from "./control-plane.ts";

const owner: RepositoryActor = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role: "owner",
};
const editor: RepositoryActor = {
  id: "33333333-3333-3333-3333-333333333333",
  organizationId: owner.organizationId,
  role: "editor",
};
const viewer: RepositoryActor = {
  id: "44444444-4444-4444-4444-444444444444",
  organizationId: owner.organizationId,
  role: "viewer",
};
const outsider: RepositoryActor = {
  id: "22222222-2222-2222-2222-222222222222",
  organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  role: "owner",
};

const TARGET_ORIGIN_DIGEST = "57522ad7956a69fe9a8100d7088fe09afc3a63de516de9f548c69862a5ff64ec";
const CHECKPOINT_REFERENCE = `urn:sha256:${"a".repeat(64)}`;
const AUTHENTICATION_EVIDENCE_REFERENCE = `urn:sha256:${"b".repeat(64)}`;

async function runningWebsite(
  repository: ControlPlaneRepository,
  suffix: string,
): Promise<Readonly<{
  projectId: string;
  runId: string;
  claim: ClaimedAnalysisRunRecord;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
}>> {
  const project = await repository.createProject(owner, {
    name: `Authentication wait ${suffix}`,
    sourceType: "website",
    url: "https://widgets.example",
    idempotencyKey: `authentication-project-${suffix}`,
    inputHash: `authentication-project-${suffix}`,
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: `authentication-analysis-${suffix}`,
    inputHash: `authentication-analysis-${suffix}`,
  });
  const snapshot = (await repository.listSourceSnapshots(owner, project.id))[0];
  assert.ok(snapshot);
  const claim = await repository.claimAnalysis(`authentication-worker-${suffix}`, 60_000, ["website"]);
  assert.equal(claim?.id, run.id);
  return {
    projectId: project.id,
    runId: run.id,
    claim: claim!,
    sourceSnapshotId: snapshot.id,
    sourceIdentityHash: snapshot.sourceIdentityHash,
  };
}

function waitInput(
  source: Pick<Awaited<ReturnType<typeof runningWebsite>>, "sourceSnapshotId" | "sourceIdentityHash">,
  expiresAt: string,
  overrides: Partial<WaitAnalysisForAuthenticationInput> = {},
): WaitAnalysisForAuthenticationInput {
  return {
    checkpointReference: CHECKPOINT_REFERENCE,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest: TARGET_ORIGIN_DIGEST,
    expiresAt,
    idempotencyKey: "authentication-wait-command",
    inputHash: "authentication-wait-command",
    ...overrides,
  };
}

function resumeInput(
  source: Pick<Awaited<ReturnType<typeof runningWebsite>>, "runId" | "sourceSnapshotId" | "sourceIdentityHash">,
  overrides: Partial<ResumeAnalysisAfterAuthenticationInput> = {},
): ResumeAnalysisAfterAuthenticationInput {
  return {
    runId: source.runId,
    checkpointReference: CHECKPOINT_REFERENCE,
    authenticationEvidenceReference: AUTHENTICATION_EVIDENCE_REFERENCE,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest: TARGET_ORIGIN_DIGEST,
    idempotencyKey: "authentication-resume-command",
    inputHash: "authentication-resume-command",
    ...overrides,
  };
}

test("website authentication wait atomically releases both leases and is idempotent", async () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const source = await runningWebsite(repository, "atomic-wait");
  const input = waitInput(source, "2026-09-01T12:05:00.000Z");

  const waiting = await repository.waitAnalysisForAuthentication(
    "authentication-worker-atomic-wait",
    source.runId,
    input,
    source.claim.leaseGeneration,
  );

  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.workflowTaskId, source.claim.workflowTaskId);
  assert.equal(waiting.checkpointReference, CHECKPOINT_REFERENCE);
  assert.equal(waiting.authenticationEvidenceReference, undefined);
  assert.equal((await repository.getAnalysis(owner, source.runId)).status, "waiting");
  assert.equal((await repository.getProject(owner, source.projectId)).status, "analyzing");
  const workflow = await repository.getWorkflowRun(owner, source.runId);
  assert.equal(workflow.status, "waiting");
  const task = (await repository.listWorkflowTasks(owner, source.runId))[0];
  assert.equal(task?.status, "waiting");
  assert.equal(task?.checkpointReference, CHECKPOINT_REFERENCE);
  assert.equal(task?.waitReason, "external_authentication");
  assert.equal(task?.leaseOwner, undefined);
  assert.equal(task?.leaseExpiresAt, undefined);
  assert.equal(await repository.claimAnalysis("another-worker", 60_000, ["website"]), undefined);
  assert.deepEqual(await repository.waitAnalysisForAuthentication(
    "authentication-worker-atomic-wait",
    source.runId,
    input,
    source.claim.leaseGeneration,
  ), waiting);
  await assert.rejects(repository.waitAnalysisForAuthentication(
    "authentication-worker-atomic-wait",
    source.runId,
    { ...input, inputHash: "changed-wait-command" },
    source.claim.leaseGeneration,
  ), (error: unknown) => error instanceof RepositoryError && error.code === "IDEMPOTENCY_CONFLICT");
  assert.equal((await repository.listWorkflowEvents(owner, source.runId))
    .filter(({ type }) => type === "task.waiting").length, 1);
});

test("website authentication resume requires exact evidence and returns it on the next claim", async () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const source = await runningWebsite(repository, "authorized-resume");
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-authorized-resume",
    source.runId,
    waitInput(source, "2026-09-01T12:05:00.000Z"),
    source.claim.leaseGeneration,
  );

  await assert.rejects(repository.getWebsiteAuthenticationWait(outsider, source.runId), (error: unknown) =>
    error instanceof RepositoryError && error.code === "NOT_FOUND");
  assert.equal((await repository.getWebsiteAuthenticationWait(viewer, source.runId))?.state, "waiting");
  await assert.rejects(repository.resumeAnalysisAfterAuthentication(viewer, resumeInput(source)), (error: unknown) =>
    error instanceof RepositoryError && error.code === "FORBIDDEN");
  await assert.rejects(repository.resumeAnalysisAfterAuthentication(editor, resumeInput(source, {
    authenticationEvidenceReference: "missing" as never,
  })), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  await assert.rejects(repository.resumeAnalysisAfterAuthentication(editor, resumeInput(source, {
    sourceIdentityHash: "c".repeat(64),
  })), (error: unknown) => error instanceof RepositoryError && error.code === "SOURCE_SNAPSHOT_STALE");

  const consumed = await repository.resumeAnalysisAfterAuthentication(editor, resumeInput(source));
  assert.equal(consumed.state, "consumed");
  assert.equal(consumed.authenticationEvidenceReference, AUTHENTICATION_EVIDENCE_REFERENCE);
  assert.ok(consumed.consumedAt);
  assert.equal((await repository.getAnalysis(owner, source.runId)).status, "queued");
  assert.equal((await repository.getWorkflowRun(owner, source.runId)).status, "queued");
  assert.deepEqual(await repository.resumeAnalysisAfterAuthentication(editor, resumeInput(source)), consumed);
  const claim = await repository.claimAnalysis("authentication-resumed-worker", 60_000, ["website"]);
  assert.equal(claim?.id, source.runId);
  assert.deepEqual(claim?.authenticationCheckpoint, {
    checkpointReference: CHECKPOINT_REFERENCE,
    authenticationEvidenceReference: AUTHENTICATION_EVIDENCE_REFERENCE,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest: TARGET_ORIGIN_DIGEST,
    expiresAt: "2026-09-01T12:05:00.000Z",
  });
  assert.equal((await repository.listWorkflowEvents(owner, source.runId))
    .filter(({ type }) => type === "task.resumed").length, 1);
});

test("invalid checkpoint binding leaves the running analysis untouched", async () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const source = await runningWebsite(repository, "rollback");

  await assert.rejects(repository.waitAnalysisForAuthentication(
    "authentication-worker-rollback",
    source.runId,
    waitInput(source, "2026-09-01T12:05:00.000Z", { targetOriginDigest: "d".repeat(64) }),
    source.claim.leaseGeneration,
  ), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");

  const run = await repository.getAnalysis(owner, source.runId);
  const task = (await repository.listWorkflowTasks(owner, source.runId))[0];
  assert.equal(run.status, "running");
  assert.equal(run.leaseOwner, "authentication-worker-rollback");
  assert.equal(task?.status, "running");
  assert.equal(task?.leaseOwner, "authentication-worker-rollback");
  assert.equal(await repository.getWebsiteAuthenticationWait(owner, source.runId), undefined);
});

test("completion, permanent failure, cancellation, and expiry close authentication checkpoints", async () => {
  let now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);

  const completedSource = await runningWebsite(repository, "completed");
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-completed",
    completedSource.runId,
    waitInput(completedSource, "2026-09-01T12:05:00.000Z"),
    completedSource.claim.leaseGeneration,
  );
  await repository.resumeAnalysisAfterAuthentication(owner, resumeInput(completedSource));
  const completedClaim = await repository.claimAnalysis("authentication-terminal-complete", 60_000, ["website"]);
  assert.equal(completedClaim?.id, completedSource.runId);
  await repository.completeAnalysis("authentication-terminal-complete", completedSource.runId, {
    capabilities: [],
    diagnostics: [{ code: "NO_SUPPORTED_OPERATIONS", operationKey: "website" }],
    evidence: [{
      source: "runtime",
      content: "{}",
      reference: "urn:sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    }],
  }, completedClaim!.leaseGeneration);
  assert.equal((await repository.getWebsiteAuthenticationWait(owner, completedSource.runId))?.state, "completed");

  const failedSource = await runningWebsite(repository, "failed");
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-failed",
    failedSource.runId,
    waitInput(failedSource, "2026-09-01T12:05:00.000Z", {
      checkpointReference: `urn:sha256:${"c".repeat(64)}`,
      idempotencyKey: "authentication-wait-failed",
      inputHash: "authentication-wait-failed",
    }),
    failedSource.claim.leaseGeneration,
  );
  await repository.resumeAnalysisAfterAuthentication(owner, resumeInput(failedSource, {
    checkpointReference: `urn:sha256:${"c".repeat(64)}`,
    idempotencyKey: "authentication-resume-failed",
    inputHash: "authentication-resume-failed",
  }));
  const failedClaim = await repository.claimAnalysis("authentication-terminal-fail", 60_000, ["website"]);
  assert.equal(failedClaim?.id, failedSource.runId);
  await repository.failAnalysis(
    "authentication-terminal-fail",
    failedSource.runId,
    "TERMINAL",
    false,
    failedClaim!.leaseGeneration,
  );
  assert.equal((await repository.getWebsiteAuthenticationWait(owner, failedSource.runId))?.state, "failed");

  const cancelledSource = await runningWebsite(repository, "cancelled");
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-cancelled",
    cancelledSource.runId,
    waitInput(cancelledSource, "2026-09-01T12:05:00.000Z", {
      checkpointReference: `urn:sha256:${"d".repeat(64)}`,
      idempotencyKey: "authentication-wait-cancelled",
      inputHash: "authentication-wait-cancelled",
    }),
    cancelledSource.claim.leaseGeneration,
  );
  await repository.cancelWorkflow(owner, {
    runId: cancelledSource.runId,
    idempotencyKey: "authentication-cancel-command",
    inputHash: "authentication-cancel-command",
  });
  assert.equal((await repository.getWebsiteAuthenticationWait(owner, cancelledSource.runId))?.state, "cancelled");

  const expiredSource = await runningWebsite(repository, "expired");
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-expired",
    expiredSource.runId,
    waitInput(expiredSource, "2026-09-01T12:01:00.000Z", {
      checkpointReference: `urn:sha256:${"e".repeat(64)}`,
      idempotencyKey: "authentication-wait-expired",
      inputHash: "authentication-wait-expired",
    }),
    expiredSource.claim.leaseGeneration,
  );
  now = new Date("2026-09-01T12:01:00.001Z");
  assert.equal(await repository.reconcileWorkflows("authentication-reconciler"), 1);
  assert.equal((await repository.getWebsiteAuthenticationWait(owner, expiredSource.runId))?.state, "expired");
  assert.equal((await repository.getAnalysis(owner, expiredSource.runId)).status, "failed");
  assert.equal(await repository.claimAnalysis("authentication-after-expiry", 60_000, ["website"]), undefined);
  assert.equal((await repository.listWorkflowEvents(owner, expiredSource.runId))
    .filter(({ type }) => type === "task.reconciled").length, 1);
});

test("terminal website authentication cleanup is leased, restart-safe, and idempotent", async () => {
  let now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now, { random: () => 0 });
  const source = await runningWebsite(repository, "durable-cleanup");
  const checkpointReference = `urn:sha256:${"f".repeat(64)}`;
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-durable-cleanup",
    source.runId,
    waitInput(source, "2026-09-01T12:05:00.000Z", {
      checkpointReference,
      idempotencyKey: "authentication-wait-durable-cleanup",
      inputHash: "authentication-wait-durable-cleanup",
    }),
    source.claim.leaseGeneration,
  );
  await repository.cancelWorkflow(owner, {
    runId: source.runId,
    idempotencyKey: "authentication-cancel-durable-cleanup",
    inputHash: "authentication-cancel-durable-cleanup",
  });

  const first = await repository.claimWebsiteAuthenticationCleanup("cleanup-worker-a", 1_000);
  assert.ok(first);
  assert.deepEqual({
    analysisRunId: first.analysisRunId,
    checkpointReference: first.checkpointReference,
    cleanupIdempotencyKey: first.cleanupIdempotencyKey,
    terminalState: first.terminalState,
    outcome: first.outcome,
    attempts: first.attempts,
    leaseGeneration: first.leaseGeneration,
  }, {
    analysisRunId: source.runId,
    checkpointReference,
    cleanupIdempotencyKey: `website-auth-cleanup:${"f".repeat(64)}`,
    terminalState: "cancelled",
    outcome: "cancelled",
    attempts: 1,
    leaseGeneration: 1,
  });
  assert.equal(await repository.claimWebsiteAuthenticationCleanup("cleanup-worker-b", 1_000), undefined);

  now = new Date("2026-09-01T12:00:01.001Z");
  const recovered = await repository.claimWebsiteAuthenticationCleanup("cleanup-worker-b", 1_000);
  assert.ok(recovered);
  assert.equal(recovered.cleanupIdempotencyKey, first.cleanupIdempotencyKey);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.leaseGeneration, 2);
  await assert.rejects(
    repository.completeWebsiteAuthenticationCleanup(
      "cleanup-worker-a", source.runId, first.leaseGeneration,
    ),
    (error: unknown) => error instanceof RepositoryError && error.code === "LEASE_LOST",
  );

  await repository.retryWebsiteAuthenticationCleanup(
    "cleanup-worker-b", source.runId, recovered.leaseGeneration, "GATEWAY_TIMEOUT",
  );
  const retried = await repository.claimWebsiteAuthenticationCleanup("cleanup-worker-c", 1_000);
  assert.ok(retried);
  assert.equal(retried.cleanupIdempotencyKey, first.cleanupIdempotencyKey);
  assert.equal(retried.attempts, 3);
  await repository.completeWebsiteAuthenticationCleanup(
    "cleanup-worker-c", source.runId, retried.leaseGeneration,
  );
  assert.equal(await repository.claimWebsiteAuthenticationCleanup("cleanup-worker-d", 1_000), undefined);
});

test("an exhausted resumed analysis lease queues terminal authentication cleanup", async () => {
  let now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now, { random: () => 0 });
  const source = await runningWebsite(repository, "exhausted-cleanup");
  const checkpointReference = `urn:sha256:${"0".repeat(64)}`;
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-exhausted-cleanup",
    source.runId,
    waitInput(source, "2026-09-01T12:05:00.000Z", {
      checkpointReference,
      idempotencyKey: "authentication-wait-exhausted-cleanup",
      inputHash: "authentication-wait-exhausted-cleanup",
    }),
    source.claim.leaseGeneration,
  );
  await repository.resumeAnalysisAfterAuthentication(owner, resumeInput(source, {
    checkpointReference,
    idempotencyKey: "authentication-resume-exhausted-cleanup",
    inputHash: "authentication-resume-exhausted-cleanup",
  }));
  const second = await repository.claimAnalysis("authentication-exhausted-second", 1_000, ["website"]);
  assert.ok(second);
  await repository.failAnalysis(
    "authentication-exhausted-second", source.runId, "TRANSIENT", true, second.leaseGeneration,
  );
  now = new Date("2026-09-01T12:00:01.000Z");
  const third = await repository.claimAnalysis("authentication-exhausted-third", 1_000, ["website"]);
  assert.ok(third);
  now = new Date("2026-09-01T12:00:02.001Z");
  assert.equal(await repository.claimAnalysis("authentication-exhausted-reconciler", 1_000, ["website"]), undefined);
  assert.equal((await repository.getWebsiteAuthenticationWait(owner, source.runId))?.state, "failed");
  const cleanup = await repository.claimWebsiteAuthenticationCleanup("authentication-exhausted-cleanup", 1_000);
  assert.ok(cleanup);
  assert.equal(cleanup.analysisRunId, source.runId);
  assert.equal(cleanup.terminalState, "failed");
  assert.equal(cleanup.outcome, "failed");
});

test("terminal authentication cleanup stops after three failures and remains diagnosable", async () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now, { random: () => 0 });
  const source = await runningWebsite(repository, "cleanup-budget");
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-cleanup-budget",
    source.runId,
    waitInput(source, "2026-09-01T12:05:00.000Z", {
      checkpointReference: `urn:sha256:${"1".repeat(64)}`,
      idempotencyKey: "authentication-wait-cleanup-budget",
      inputHash: "authentication-wait-cleanup-budget",
    }),
    source.claim.leaseGeneration,
  );
  await repository.cancelWorkflow(owner, {
    runId: source.runId,
    idempotencyKey: "authentication-cancel-cleanup-budget",
    inputHash: "authentication-cancel-cleanup-budget",
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const cleanup = await repository.claimWebsiteAuthenticationCleanup(`cleanup-budget-${attempt}`, 1_000);
    assert.ok(cleanup);
    assert.equal(cleanup.attempts, attempt);
    await repository.retryWebsiteAuthenticationCleanup(
      `cleanup-budget-${attempt}`,
      source.runId,
      cleanup.leaseGeneration,
      "GATEWAY_TIMEOUT",
    );
  }
  assert.equal(await repository.claimWebsiteAuthenticationCleanup("cleanup-budget-4", 1_000), undefined);
  const checkpoint = await repository.getWebsiteAuthenticationWait(owner, source.runId);
  assert.equal(checkpoint?.cleanupStatus, "failed");
  assert.equal(checkpoint?.cleanupAttempts, 3);
  assert.equal(checkpoint?.cleanupErrorCode, "GATEWAY_TIMEOUT");
  assert.equal(checkpoint?.cleanupCompletedAt, undefined);
});

test("a permanent authentication cleanup failure is terminal on its first attempt", async () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now, { random: () => 0 });
  const source = await runningWebsite(repository, "cleanup-permanent");
  await repository.waitAnalysisForAuthentication(
    "authentication-worker-cleanup-permanent",
    source.runId,
    waitInput(source, "2026-09-01T12:05:00.000Z", {
      checkpointReference: `urn:sha256:${"2".repeat(64)}`,
      idempotencyKey: "authentication-wait-cleanup-permanent",
      inputHash: "authentication-wait-cleanup-permanent",
    }),
    source.claim.leaseGeneration,
  );
  await repository.cancelWorkflow(owner, {
    runId: source.runId,
    idempotencyKey: "authentication-cancel-cleanup-permanent",
    inputHash: "authentication-cancel-cleanup-permanent",
  });
  const cleanup = await repository.claimWebsiteAuthenticationCleanup("cleanup-permanent-1", 1_000);
  assert.ok(cleanup);
  await repository.retryWebsiteAuthenticationCleanup(
    "cleanup-permanent-1",
    source.runId,
    cleanup.leaseGeneration,
    "WEBSITE_CONTROL_REJECTED",
    false,
  );
  assert.equal(await repository.claimWebsiteAuthenticationCleanup("cleanup-permanent-2", 1_000), undefined);
  const checkpoint = await repository.getWebsiteAuthenticationWait(owner, source.runId);
  assert.equal(checkpoint?.cleanupStatus, "failed");
  assert.equal(checkpoint?.cleanupAttempts, 1);
  assert.equal(checkpoint?.cleanupErrorCode, "WEBSITE_CONTROL_REJECTED");
});
