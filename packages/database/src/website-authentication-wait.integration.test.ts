import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  RepositoryError,
  type ClaimedAnalysisRunRecord,
  type ControlPlaneRepository,
  type RepositoryActor,
  type ResumeAnalysisAfterAuthenticationInput,
  type TerminateAnalysisAuthenticationInput,
  type WaitAnalysisForAuthenticationInput,
} from "./control-plane.ts";
import { createPostgresRepository } from "./postgres.ts";
import { websiteSuspensionEvidenceFixture } from "../../../test-support/website-suspension-evidence.ts";

const explicitApplicationConnectionString = process.env.PAGE2WEBMCP_TEST_APP_DATABASE_URL;
const explicitWorkerConnectionString = process.env.PAGE2WEBMCP_TEST_WORKER_DATABASE_URL;
const applicationConnectionString = explicitApplicationConnectionString;
const workerConnectionString = explicitWorkerConnectionString;
const adminConnectionString = process.env.PAGE2WEBMCP_TEST_ADMIN_DATABASE_URL;
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

test("Postgres website authentication split-role topology cannot collapse to one login", {
  skip: !explicitApplicationConnectionString && !explicitWorkerConnectionString,
}, async () => {
  assert.ok(explicitApplicationConnectionString);
  assert.ok(explicitWorkerConnectionString);
  assert.ok(adminConnectionString);
  assert.notEqual(explicitApplicationConnectionString, explicitWorkerConnectionString);
  const application = new pg.Client({ connectionString: explicitApplicationConnectionString });
  const worker = new pg.Client({ connectionString: explicitWorkerConnectionString });
  const admin = new pg.Client({ connectionString: adminConnectionString });
  try {
    await Promise.all([application.connect(), worker.connect(), admin.connect()]);
    const [applicationIdentity, workerIdentity, adminIdentity] = await Promise.all([
      application.query<{ current_user: string; session_user: string }>("select current_user, session_user"),
      worker.query<{ current_user: string; session_user: string }>("select current_user, session_user"),
      admin.query<{ current_user: string; session_user: string }>("select current_user, session_user"),
    ]);
    assert.deepEqual(applicationIdentity.rows[0], {
      current_user: "page2webmcp_app",
      session_user: "page2webmcp_app_local",
    });
    assert.deepEqual(workerIdentity.rows[0], {
      current_user: "page2webmcp_worker",
      session_user: "page2webmcp_worker_local",
    });
    assert.deepEqual(adminIdentity.rows[0], { current_user: "postgres", session_user: "postgres" });
  } finally {
    await Promise.allSettled([application.end(), worker.end(), admin.end()]);
  }
});

async function runningWebsite(
  applicationRepository: ControlPlaneRepository,
  workerRepository: ControlPlaneRepository,
  suffix: string,
): Promise<Readonly<{
  projectId: string;
  runId: string;
  claim: ClaimedAnalysisRunRecord;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  workerId: string;
}>> {
  const unique = `${suffix}-${randomUUID()}`;
  const project = await applicationRepository.createProject(owner, {
    name: `Postgres authentication ${unique}`,
    sourceType: "website",
    url: "https://widgets.example",
    idempotencyKey: `authentication-project-${unique}`,
    inputHash: `authentication-project-${unique}`,
  });
  const run = await applicationRepository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: `authentication-analysis-${unique}`,
    inputHash: `authentication-analysis-${unique}`,
  });
  const snapshot = (await applicationRepository.listSourceSnapshots(owner, project.id))[0];
  assert.ok(snapshot);
  const workerId = `authentication-worker-${unique}`;
  const claim = await workerRepository.claimAnalysis(workerId, 60_000, ["website"]);
  assert.equal(claim?.id, run.id);
  assert.equal(claim?.sourceSnapshotId, snapshot.id);
  return {
    projectId: project.id,
    runId: run.id,
    claim: claim!,
    sourceSnapshotId: snapshot.id,
    sourceIdentityHash: snapshot.sourceIdentityHash,
    workerId,
  };
}

function waitInput(
  source: Pick<Awaited<ReturnType<typeof runningWebsite>>, "sourceSnapshotId" | "sourceIdentityHash" | "claim" | "workerId">,
  checkpointReference: string,
  suffix: string,
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(),
): WaitAnalysisForAuthenticationInput {
  const command = {
    checkpointReference,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest: TARGET_ORIGIN_DIGEST,
    expiresAt,
    idempotencyKey: `authentication-wait-${suffix}`,
    inputHash: `authentication-wait-${suffix}`,
  };
  return {
    ...command,
    suspensionEvidence: websiteSuspensionEvidenceFixture({
      checkpointReference: command.checkpointReference,
      sourceSnapshotId: command.sourceSnapshotId,
      sourceIdentityHash: command.sourceIdentityHash,
      targetOriginDigest: command.targetOriginDigest,
      expiresAt: command.expiresAt,
      workerId: source.workerId,
      leaseGeneration: source.claim.leaseGeneration,
    }),
  };
}

function resumeInput(
  source: Pick<Awaited<ReturnType<typeof runningWebsite>>, "runId" | "sourceSnapshotId" | "sourceIdentityHash">,
  checkpointReference: string,
  evidenceReference: string,
  suffix: string,
): ResumeAnalysisAfterAuthenticationInput {
  return {
    runId: source.runId,
    checkpointReference,
    authenticationEvidenceReference: evidenceReference,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest: TARGET_ORIGIN_DIGEST,
    idempotencyKey: `authentication-resume-${suffix}`,
    inputHash: `authentication-resume-${suffix}`,
  };
}

function terminateInput(
  source: Pick<Awaited<ReturnType<typeof runningWebsite>>, "runId" | "sourceSnapshotId" | "sourceIdentityHash">,
  checkpointReference: string,
  expiresAt: string,
  suffix: string,
): TerminateAnalysisAuthenticationInput {
  return {
    runId: source.runId,
    checkpointReference,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest: TARGET_ORIGIN_DIGEST,
    expiresAt,
    terminalState: "failed",
    idempotencyKey: `authentication-terminate-${suffix}`,
    inputHash: `authentication-terminate-${suffix}`,
  };
}

test("Postgres website authentication wait and resume are four-record atomic and exactly claimed", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  const applicationRepository = createPostgresRepository({ connectionString: applicationConnectionString!, maxConnections: 2 });
  const workerRepository = createPostgresRepository({ connectionString: workerConnectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let projectId: string | undefined;
  try {
    const source = await runningWebsite(applicationRepository, workerRepository, "atomic");
    projectId = source.projectId;
    const checkpointReference = `urn:sha256:${"1".repeat(64)}`;
    const evidenceReference = `urn:sha256:${"2".repeat(64)}`;
    const waitingInput = waitInput(source, checkpointReference, "atomic");

    await assert.rejects(workerRepository.waitAnalysisForAuthentication(source.workerId, source.runId, {
      ...waitingInput,
      targetOriginDigest: "3".repeat(64),
    }, source.claim.leaseGeneration), (error: unknown) => error instanceof RepositoryError
      && error.code === "INVALID_STATE");
    const untouched = await admin.query(
      "select job.status as job_status, analysis.status as analysis_status, task.status as task_status, " +
      "workflow.status as workflow_status, job.lease_owner as job_lease_owner, task.lease_owner as task_lease_owner " +
      "from private.analysis_jobs job join public.analysis_runs analysis on analysis.id = job.analysis_run_id " +
      "join public.workflow_runs workflow on workflow.id = job.analysis_run_id " +
      "join private.workflow_tasks task on task.workflow_run_id = workflow.id and task.phase = 'analysis' " +
      "where job.analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual(untouched.rows[0], {
      job_status: "running",
      analysis_status: "running",
      task_status: "running",
      workflow_status: "running",
      job_lease_owner: source.workerId,
      task_lease_owner: source.workerId,
    });

    const waiting = await workerRepository.waitAnalysisForAuthentication(
      source.workerId,
      source.runId,
      waitingInput,
      source.claim.leaseGeneration,
    );
    assert.equal(waiting.state, "waiting");
    assert.deepEqual(await workerRepository.waitAnalysisForAuthentication(
      source.workerId,
      source.runId,
      waitingInput,
      source.claim.leaseGeneration,
    ), waiting);
    await assert.rejects(workerRepository.waitAnalysisForAuthentication(
      source.workerId,
      source.runId,
      {
        ...waitingInput,
        suspensionEvidence: {
          ...waitingInput.suspensionEvidence,
          ownershipDecisionDigest: "f".repeat(64),
        },
      },
      source.claim.leaseGeneration,
    ), (error: unknown) => error instanceof RepositoryError && error.code === "IDEMPOTENCY_CONFLICT");
    const fourWaiting = await admin.query(
      "select job.status as job_status, analysis.status as analysis_status, task.status as task_status, " +
      "workflow.status as workflow_status, job.lease_owner, job.lease_expires_at, " +
      "task.lease_owner as task_lease_owner, task.lease_expires_at as task_lease_expires_at " +
      "from private.analysis_jobs job join public.analysis_runs analysis on analysis.id = job.analysis_run_id " +
      "join public.workflow_runs workflow on workflow.id = job.analysis_run_id " +
      "join private.workflow_tasks task on task.workflow_run_id = workflow.id and task.phase = 'analysis' " +
      "where job.analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual(fourWaiting.rows[0], {
      job_status: "waiting", analysis_status: "waiting", task_status: "waiting", workflow_status: "waiting",
      lease_owner: null, lease_expires_at: null, task_lease_owner: null, task_lease_expires_at: null,
    });

    await assert.rejects(applicationRepository.getWebsiteAuthenticationWait(outsider, source.runId), (error: unknown) =>
      error instanceof RepositoryError && error.code === "NOT_FOUND");
    assert.equal((await applicationRepository.getWebsiteAuthenticationWait(viewer, source.runId))?.state, "waiting");
    const resume = resumeInput(source, checkpointReference, evidenceReference, "atomic");
    await assert.rejects(applicationRepository.resumeAnalysisAfterAuthentication(viewer, resume), (error: unknown) =>
      error instanceof RepositoryError && error.code === "FORBIDDEN");
    await assert.rejects(applicationRepository.resumeAnalysisAfterAuthentication(editor, {
      ...resume,
      sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
    }), (error: unknown) => error instanceof RepositoryError && error.code === "SOURCE_SNAPSHOT_STALE");

    const consumed = await applicationRepository.resumeAnalysisAfterAuthentication(editor, resume);
    assert.equal(consumed.state, "consumed");
    assert.equal(consumed.authenticationEvidenceReference, evidenceReference);
    assert.deepEqual(await applicationRepository.resumeAnalysisAfterAuthentication(editor, resume), consumed);
    const fourQueued = await admin.query(
      "select job.status as job_status, analysis.status as analysis_status, task.status as task_status, " +
      "workflow.status as workflow_status from private.analysis_jobs job " +
      "join public.analysis_runs analysis on analysis.id = job.analysis_run_id " +
      "join public.workflow_runs workflow on workflow.id = job.analysis_run_id " +
      "join private.workflow_tasks task on task.workflow_run_id = workflow.id and task.phase = 'analysis' " +
      "where job.analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual(fourQueued.rows[0], {
      job_status: "queued", analysis_status: "queued", task_status: "queued", workflow_status: "queued",
    });
    const claimed = await workerRepository.claimAnalysis("authentication-postgres-resumed", 60_000, ["website"]);
    assert.equal(claimed?.id, source.runId);
    assert.deepEqual({
      ...claimed?.authenticationCheckpoint,
      liveReceiptEvidence: undefined,
    }, {
      checkpointReference,
      authenticationEvidenceReference: evidenceReference,
      sourceSnapshotId: source.sourceSnapshotId,
      sourceIdentityHash: source.sourceIdentityHash,
      targetOriginDigest: TARGET_ORIGIN_DIGEST,
      expiresAt: waitingInput.expiresAt,
      liveReceiptEvidence: undefined,
    });
    assert.ok(claimed?.authenticationCheckpoint?.liveReceiptEvidence);
    assert.equal(claimed.authenticationCheckpoint.liveReceiptEvidence.restartVerified, false);
    assert.equal(claimed.authenticationCheckpoint.resultCheckpoint, undefined);
    assert.doesNotMatch(JSON.stringify(claimed.authenticationCheckpoint.liveReceiptEvidence),
      /authentication-postgres-resumed|secretref:|https?:\/\/|wss?:\/\//);
  } finally {
    if (projectId) await admin.query("delete from public.projects where id = $1", [projectId]);
    await applicationRepository.close();
    await workerRepository.close();
    await admin.end();
  }
});

test("Postgres authentication termination enforces tenant, role, and immutable checkpoint bindings", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  assert.notEqual(applicationConnectionString, workerConnectionString);
  const applicationRepository = createPostgresRepository({
    connectionString: applicationConnectionString!, maxConnections: 2,
  });
  const workerRepository = createPostgresRepository({ connectionString: workerConnectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let projectId: string | undefined;
  try {
    const source = await runningWebsite(applicationRepository, workerRepository, "terminal-denials");
    projectId = source.projectId;
    const checkpointReference = `urn:sha256:${"a".repeat(64)}`;
    const waitingInput = waitInput(source, checkpointReference, "terminal-denials");
    await workerRepository.waitAnalysisForAuthentication(
      source.workerId, source.runId, waitingInput, source.claim.leaseGeneration,
    );
    const terminalInput = terminateInput(
      source, checkpointReference, waitingInput.expiresAt, "terminal-denials",
    );

    await assert.rejects(
      applicationRepository.terminateAnalysisAuthentication(viewer, terminalInput),
      (error: unknown) => error instanceof RepositoryError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      applicationRepository.terminateAnalysisAuthentication(outsider, terminalInput),
      (error: unknown) => error instanceof RepositoryError && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      applicationRepository.terminateAnalysisAuthentication(editor, {
        ...terminalInput,
        sourceSnapshotId: "99999999-9999-4999-8999-999999999999",
      }),
      (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE",
    );

    const durable = await admin.query(
      "select checkpoint.state, checkpoint.cleanup_status, job.status as job_status, " +
      "task.status as task_status, workflow.status as workflow_status " +
      "from private.website_authentication_checkpoints checkpoint " +
      "join private.analysis_jobs job on job.analysis_run_id = checkpoint.analysis_run_id " +
      "join private.workflow_tasks task on task.workflow_run_id = checkpoint.analysis_run_id " +
      "and task.phase = 'analysis' " +
      "join public.workflow_runs workflow on workflow.id = checkpoint.analysis_run_id " +
      "where checkpoint.analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual(durable.rows[0], {
      state: "waiting",
      cleanup_status: null,
      job_status: "waiting",
      task_status: "waiting",
      workflow_status: "waiting",
    });
  } finally {
    if (projectId) await admin.query("delete from public.projects where id = $1", [projectId]);
    await applicationRepository.close();
    await workerRepository.close();
    await admin.end();
  }
});

test("Postgres authentication termination is atomic, replay-safe, and queues exact worker cleanup", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  assert.notEqual(applicationConnectionString, workerConnectionString);
  const applicationRepository = createPostgresRepository({
    connectionString: applicationConnectionString!, maxConnections: 2,
  });
  const workerRepository = createPostgresRepository({ connectionString: workerConnectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let projectId: string | undefined;
  try {
    const source = await runningWebsite(applicationRepository, workerRepository, "terminal-transition");
    projectId = source.projectId;
    const checkpointReference = `urn:sha256:${"b".repeat(64)}`;
    const waitingInput = waitInput(source, checkpointReference, "terminal-transition");
    await workerRepository.waitAnalysisForAuthentication(
      source.workerId, source.runId, waitingInput, source.claim.leaseGeneration,
    );
    const terminalInput = terminateInput(
      source, checkpointReference, waitingInput.expiresAt, "terminal-transition",
    );

    const terminal = await applicationRepository.terminateAnalysisAuthentication(editor, terminalInput);
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.cleanupStatus, "pending");
    assert.equal(terminal.cleanupAttempts, 0);
    assert.deepEqual(await applicationRepository.terminateAnalysisAuthentication(editor, terminalInput), terminal);

    const durable = await admin.query(
      "select checkpoint.state, checkpoint.cleanup_status, checkpoint.cleanup_attempts, " +
      "checkpoint.cleanup_idempotency_key, checkpoint.cleanup_available_at is not null as cleanup_available, " +
      "job.status as job_status, analysis.status as analysis_status, analysis.error_code as analysis_error_code, " +
      "task.status as task_status, task.error_code as task_error_code, " +
      "workflow.status as workflow_status, workflow.error_code as workflow_error_code, project.status as project_status " +
      "from private.website_authentication_checkpoints checkpoint " +
      "join private.analysis_jobs job on job.analysis_run_id = checkpoint.analysis_run_id " +
      "join public.analysis_runs analysis on analysis.id = checkpoint.analysis_run_id " +
      "join private.workflow_tasks task on task.workflow_run_id = checkpoint.analysis_run_id " +
      "and task.phase = 'analysis' " +
      "join public.workflow_runs workflow on workflow.id = checkpoint.analysis_run_id " +
      "join public.projects project on project.id = checkpoint.project_id " +
      "where checkpoint.analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual(durable.rows[0], {
      state: "failed",
      cleanup_status: "pending",
      cleanup_attempts: 0,
      cleanup_idempotency_key: `website-auth-cleanup:${"b".repeat(64)}`,
      cleanup_available: true,
      job_status: "failed",
      analysis_status: "failed",
      analysis_error_code: "AUTHENTICATION_HANDOFF_FAILED",
      task_status: "failed",
      task_error_code: "AUTHENTICATION_HANDOFF_FAILED",
      workflow_status: "failed",
      workflow_error_code: "AUTHENTICATION_HANDOFF_FAILED",
      project_status: "failed",
    });

    await assert.rejects(
      applicationRepository.claimWebsiteAuthenticationCleanup("postgres-terminal-app-role", 60_000),
      (error: unknown) => error instanceof RepositoryError && error.code === "FORBIDDEN",
    );
    const cleanup = await workerRepository.claimWebsiteAuthenticationCleanup(
      "postgres-terminal-cleanup-worker", 60_000,
    );
    assert.ok(cleanup);
    assert.equal(cleanup.analysisRunId, source.runId);
    assert.equal(cleanup.organizationId, owner.organizationId);
    assert.equal(cleanup.projectId, source.projectId);
    assert.equal(cleanup.sourceSnapshotId, source.sourceSnapshotId);
    assert.equal(cleanup.sourceIdentityHash, source.sourceIdentityHash);
    assert.equal(cleanup.checkpointReference, checkpointReference);
    assert.equal(cleanup.targetOriginDigest, TARGET_ORIGIN_DIGEST);
    assert.equal(cleanup.terminalState, "failed");
    assert.equal(cleanup.outcome, "failed");
    assert.equal(cleanup.cleanupIdempotencyKey, `website-auth-cleanup:${"b".repeat(64)}`);
    assert.equal(cleanup.attempts, 1);
    assert.equal(cleanup.leaseOwner, "postgres-terminal-cleanup-worker");
  } finally {
    if (projectId) await admin.query("delete from public.projects where id = $1", [projectId]);
    await applicationRepository.close();
    await workerRepository.close();
    await admin.end();
  }
});

test("Postgres terminal paths and expired reconciliation close authentication state once", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  const applicationRepository = createPostgresRepository({ connectionString: applicationConnectionString!, maxConnections: 2 });
  const workerRepository = createPostgresRepository({ connectionString: workerConnectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  const projectIds: string[] = [];
  try {
    const cancelled = await runningWebsite(applicationRepository, workerRepository, "cancelled");
    projectIds.push(cancelled.projectId);
    const cancelledReference = `urn:sha256:${"4".repeat(64)}`;
    await workerRepository.waitAnalysisForAuthentication(
      cancelled.workerId,
      cancelled.runId,
      waitInput(cancelled, cancelledReference, "cancelled"),
      cancelled.claim.leaseGeneration,
    );
    await applicationRepository.cancelWorkflow(owner, {
      runId: cancelled.runId,
      idempotencyKey: "authentication-postgres-cancel",
      inputHash: "authentication-postgres-cancel",
    });
    assert.equal((await applicationRepository.getWebsiteAuthenticationWait(owner, cancelled.runId))?.state, "cancelled");

    const failed = await runningWebsite(applicationRepository, workerRepository, "failed");
    projectIds.push(failed.projectId);
    const failedReference = `urn:sha256:${"5".repeat(64)}`;
    await workerRepository.waitAnalysisForAuthentication(
      failed.workerId,
      failed.runId,
      waitInput(failed, failedReference, "failed"),
      failed.claim.leaseGeneration,
    );
    await applicationRepository.resumeAnalysisAfterAuthentication(owner, resumeInput(
      failed, failedReference, `urn:sha256:${"6".repeat(64)}`, "failed",
    ));
    const failedClaim = await workerRepository.claimAnalysis("authentication-postgres-failure", 60_000, ["website"]);
    assert.equal(failedClaim?.id, failed.runId);
    await workerRepository.failAnalysis(
      "authentication-postgres-failure", failed.runId, "TERMINAL", false, failedClaim!.leaseGeneration,
    );
    assert.equal((await applicationRepository.getWebsiteAuthenticationWait(owner, failed.runId))?.state, "failed");

    const expired = await runningWebsite(applicationRepository, workerRepository, "expired");
    projectIds.push(expired.projectId);
    await workerRepository.waitAnalysisForAuthentication(
      expired.workerId,
      expired.runId,
      waitInput(expired, `urn:sha256:${"7".repeat(64)}`, "expired", new Date(Date.now() + 250).toISOString()),
      expired.claim.leaseGeneration,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await workerRepository.reconcileWorkflows("authentication-postgres-reconciler"), 1);
    assert.equal((await applicationRepository.getWebsiteAuthenticationWait(owner, expired.runId))?.state, "expired");
    assert.equal((await applicationRepository.getAnalysis(owner, expired.runId)).status, "failed");
    assert.equal((await applicationRepository.listWorkflowEvents(owner, expired.runId))
      .filter(({ type }) => type === "task.reconciled").length, 1);
    assert.equal(await workerRepository.reconcileWorkflows("authentication-postgres-reconciler"), 0);
  } finally {
    for (const projectId of projectIds) await admin.query("delete from public.projects where id = $1", [projectId]);
    await applicationRepository.close();
    await workerRepository.close();
    await admin.end();
  }
});

test("Postgres terminal website authentication cleanup survives lease loss and retries exactly", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  const applicationRepository = createPostgresRepository({ connectionString: applicationConnectionString!, maxConnections: 2 });
  const workerRepository = createPostgresRepository({ connectionString: workerConnectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let projectId: string | undefined;
  try {
    const source = await runningWebsite(applicationRepository, workerRepository, "cleanup-lease");
    projectId = source.projectId;
    const checkpointReference = `urn:sha256:${"8".repeat(64)}`;
    await workerRepository.waitAnalysisForAuthentication(
      source.workerId,
      source.runId,
      waitInput(source, checkpointReference, "cleanup-lease"),
      source.claim.leaseGeneration,
    );
    await applicationRepository.cancelWorkflow(owner, {
      runId: source.runId,
      idempotencyKey: "authentication-postgres-cleanup-cancel",
      inputHash: "authentication-postgres-cleanup-cancel",
    });

    const first = await workerRepository.claimWebsiteAuthenticationCleanup("postgres-cleanup-a", 1_000);
    assert.ok(first);
    assert.equal(first.analysisRunId, source.runId);
    assert.equal(first.cleanupIdempotencyKey, `website-auth-cleanup:${"8".repeat(64)}`);
    assert.equal(first.terminalState, "cancelled");
    assert.equal(first.outcome, "cancelled");
    assert.equal(first.leaseGeneration, 1);
    assert.equal(await workerRepository.claimWebsiteAuthenticationCleanup("postgres-cleanup-b", 1_000), undefined);

    await admin.query(
      "update private.website_authentication_checkpoints " +
      "set cleanup_lease_expires_at = now() - interval '1 millisecond' where analysis_run_id = $1",
      [source.runId],
    );
    const recovered = await workerRepository.claimWebsiteAuthenticationCleanup("postgres-cleanup-b", 1_000);
    assert.ok(recovered);
    assert.equal(recovered.cleanupIdempotencyKey, first.cleanupIdempotencyKey);
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.leaseGeneration, 2);
    await assert.rejects(
      workerRepository.completeWebsiteAuthenticationCleanup(
        "postgres-cleanup-a", source.runId, first.leaseGeneration,
      ),
      (error: unknown) => error instanceof RepositoryError && error.code === "LEASE_LOST",
    );

    await workerRepository.retryWebsiteAuthenticationCleanup(
      "postgres-cleanup-b", source.runId, recovered.leaseGeneration, "GATEWAY_TIMEOUT",
    );
    const pending = await admin.query(
      "select cleanup_status, cleanup_idempotency_key, cleanup_last_error_code " +
      "from private.website_authentication_checkpoints where analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual(pending.rows[0], {
      cleanup_status: "pending",
      cleanup_idempotency_key: first.cleanupIdempotencyKey,
      cleanup_last_error_code: "GATEWAY_TIMEOUT",
    });
    await admin.query(
      "update private.website_authentication_checkpoints set cleanup_available_at = now() where analysis_run_id = $1",
      [source.runId],
    );
    const retried = await workerRepository.claimWebsiteAuthenticationCleanup("postgres-cleanup-c", 1_000);
    assert.ok(retried);
    assert.equal(retried.cleanupIdempotencyKey, first.cleanupIdempotencyKey);
    assert.equal(retried.attempts, 3);
    await workerRepository.completeWebsiteAuthenticationCleanup(
      "postgres-cleanup-c", source.runId, retried.leaseGeneration,
    );
    assert.equal(await workerRepository.claimWebsiteAuthenticationCleanup("postgres-cleanup-d", 1_000), undefined);
    const completed = await admin.query(
      "select cleanup_status, cleanup_completed_at, cleanup_lease_owner, cleanup_lease_expires_at " +
      "from private.website_authentication_checkpoints where analysis_run_id = $1",
      [source.runId],
    );
    assert.equal(completed.rows[0]?.cleanup_status, "succeeded");
    assert.ok(completed.rows[0]?.cleanup_completed_at);
    assert.equal(completed.rows[0]?.cleanup_lease_owner, null);
    assert.equal(completed.rows[0]?.cleanup_lease_expires_at, null);
  } finally {
    if (projectId) await admin.query("delete from public.projects where id = $1", [projectId]);
    await applicationRepository.close();
    await workerRepository.close();
    await admin.end();
  }
});

test("Postgres authentication cleanup stops after three failures with a durable diagnostic", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  const applicationRepository = createPostgresRepository({ connectionString: applicationConnectionString!, maxConnections: 2 });
  const workerRepository = createPostgresRepository({
    connectionString: workerConnectionString!, maxConnections: 2, random: () => 0,
  });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let projectId: string | undefined;
  try {
    const source = await runningWebsite(applicationRepository, workerRepository, "cleanup-budget");
    projectId = source.projectId;
    await workerRepository.waitAnalysisForAuthentication(
      source.workerId,
      source.runId,
      waitInput(source, `urn:sha256:${"9".repeat(64)}`, "cleanup-budget"),
      source.claim.leaseGeneration,
    );
    await applicationRepository.cancelWorkflow(owner, {
      runId: source.runId,
      idempotencyKey: "authentication-postgres-cleanup-budget-cancel",
      inputHash: "authentication-postgres-cleanup-budget-cancel",
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const cleanup = await workerRepository.claimWebsiteAuthenticationCleanup(
        `postgres-cleanup-budget-${attempt}`, 1_000,
      );
      assert.ok(cleanup);
      assert.equal(cleanup.attempts, attempt);
      await workerRepository.retryWebsiteAuthenticationCleanup(
        `postgres-cleanup-budget-${attempt}`,
        source.runId,
        cleanup.leaseGeneration,
        "GATEWAY_TIMEOUT",
      );
    }
    assert.equal(
      await workerRepository.claimWebsiteAuthenticationCleanup("postgres-cleanup-budget-4", 1_000),
      undefined,
    );
    const checkpoint = await applicationRepository.getWebsiteAuthenticationWait(owner, source.runId);
    assert.equal(checkpoint?.cleanupStatus, "failed");
    assert.equal(checkpoint?.cleanupAttempts, 3);
    assert.equal(checkpoint?.cleanupErrorCode, "GATEWAY_TIMEOUT");
    const durable = await admin.query(
      "select cleanup_status, cleanup_attempts, cleanup_last_error_code, cleanup_available_at " +
      "from private.website_authentication_checkpoints where analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual(durable.rows[0], {
      cleanup_status: "failed",
      cleanup_attempts: 3,
      cleanup_last_error_code: "GATEWAY_TIMEOUT",
      cleanup_available_at: null,
    });
  } finally {
    if (projectId) await admin.query("delete from public.projects where id = $1", [projectId]);
    await applicationRepository.close();
    await workerRepository.close();
    await admin.end();
  }
});

test("Postgres website authentication checkpoint table denies public and maintenance roles", {
  skip: !adminConnectionString,
}, async () => {
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  try {
    const result = await admin.query(
      "select c.relrowsecurity, c.relforcerowsecurity, " +
      "has_table_privilege('anon', c.oid, 'select') as anon_select, " +
      "has_table_privilege('authenticated', c.oid, 'select') as authenticated_select, " +
      "has_table_privilege('service_role', c.oid, 'select') as service_select, " +
      "has_table_privilege('page2webmcp_maintenance', c.oid, 'select') as maintenance_select, " +
      "has_table_privilege('page2webmcp_app', c.oid, 'select') as app_select, " +
      "has_table_privilege('page2webmcp_worker', c.oid, 'insert') as worker_insert " +
      "from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace " +
      "where n.nspname = 'private' and c.relname = 'website_authentication_checkpoints'",
    );
    assert.deepEqual(result.rows[0], {
      relrowsecurity: true,
      relforcerowsecurity: true,
      anon_select: false,
      authenticated_select: false,
      service_select: false,
      maintenance_select: false,
      app_select: true,
      worker_insert: true,
    });
    const columns = await admin.query(
      "select column_name from information_schema.columns " +
      "where table_schema = 'private' and table_name = 'website_authentication_checkpoints' order by column_name",
    );
    assert.equal(columns.rows.some(({ column_name }) =>
      /live_url|cdp_url|provider_session_id|cookie|credential|token|otp|raw_target_page|kms_secret/i.test(column_name)), false);
    const receipt = await admin.query(
      "select c.relrowsecurity, c.relforcerowsecurity, " +
      "has_table_privilege('anon', c.oid, 'select') as anon_select, " +
      "has_table_privilege('authenticated', c.oid, 'select') as authenticated_select, " +
      "has_table_privilege('service_role', c.oid, 'select') as service_select, " +
      "has_table_privilege('page2webmcp_maintenance', c.oid, 'select') as maintenance_select, " +
      "has_table_privilege('page2webmcp_app', c.oid, 'select') as app_select, " +
      "has_table_privilege('page2webmcp_worker', c.oid, 'select') as worker_select " +
      "from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace " +
      "where n.nspname = 'private' and c.relname = 'website_live_receipt_evidence'",
    );
    assert.deepEqual(receipt.rows[0], {
      relrowsecurity: true,
      relforcerowsecurity: true,
      anon_select: false,
      authenticated_select: false,
      service_select: false,
      maintenance_select: false,
      app_select: false,
      worker_select: true,
    });
  } finally {
    await admin.end();
  }
});

test("Postgres website receipt RLS exposes only the exact active analysis or cleanup lease", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  const applicationRepository = createPostgresRepository({ connectionString: applicationConnectionString!, maxConnections: 2 });
  const workerRepository = createPostgresRepository({ connectionString: workerConnectionString!, maxConnections: 2 });
  const worker = new pg.Client({ connectionString: workerConnectionString! });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let projectId: string | undefined;
  try {
    await worker.connect();
    const source = await runningWebsite(applicationRepository, workerRepository, "receipt-rls");
    projectId = source.projectId;
    const checkpointReference = `urn:sha256:${"d".repeat(64)}`;
    const waiting = waitInput(source, checkpointReference, "receipt-rls");
    await workerRepository.waitAnalysisForAuthentication(
      source.workerId, source.runId, waiting, source.claim.leaseGeneration,
    );
    await applicationRepository.resumeAnalysisAfterAuthentication(owner, resumeInput(
      source, checkpointReference, `urn:sha256:${"e".repeat(64)}`, "receipt-rls",
    ));
    const claimed = await workerRepository.claimAnalysis("receipt-rls-worker", 60_000, ["website"]);
    assert.equal(claimed?.id, source.runId);

    const visible = async (taskId: string, workerId: string, generation: number): Promise<number> => {
      await worker.query("begin");
      try {
        await worker.query(
          "select set_config('page2webmcp.workflow_task_id', $1, true), " +
          "set_config('page2webmcp.worker_id', $2, true), " +
          "set_config('page2webmcp.lease_generation', $3, true)",
          [taskId, workerId, String(generation)],
        );
        const result = await worker.query(
          "select count(*)::integer as count from private.website_live_receipt_evidence where analysis_run_id = $1",
          [source.runId],
        );
        await worker.query("rollback");
        return Number(result.rows[0]?.count);
      } catch (error) {
        await worker.query("rollback");
        throw error;
      }
    };

    assert.equal(await visible(claimed!.workflowTaskId, "wrong-worker", claimed!.leaseGeneration), 0);
    assert.equal(await visible(claimed!.workflowTaskId, "receipt-rls-worker", claimed!.leaseGeneration + 1), 0);
    assert.equal(await visible(claimed!.workflowTaskId, "receipt-rls-worker", claimed!.leaseGeneration), 1);

    await workerRepository.failAnalysis(
      "receipt-rls-worker", source.runId, "TEST_TERMINAL_FAILURE", false, claimed!.leaseGeneration,
    );
    const cleanup = await workerRepository.claimWebsiteAuthenticationCleanup("receipt-cleanup-worker", 60_000);
    assert.equal(cleanup?.analysisRunId, source.runId);
    assert.equal(await visible(cleanup!.workflowTaskId, "wrong-cleanup-worker", cleanup!.leaseGeneration), 0);
    assert.equal(await visible(cleanup!.workflowTaskId, "receipt-cleanup-worker", cleanup!.leaseGeneration + 1), 0);
    assert.equal(await visible(randomUUID(), "receipt-cleanup-worker", cleanup!.leaseGeneration), 0);
    assert.equal(await visible(cleanup!.workflowTaskId, "receipt-cleanup-worker", cleanup!.leaseGeneration), 1);
  } finally {
    if (projectId) await admin.query("delete from public.projects where id = $1", [projectId]);
    await Promise.allSettled([worker.end(), applicationRepository.close(), workerRepository.close(), admin.end()]);
  }
});

test("Postgres authentication result checkpoint completes after lease recovery without duplicate persistence", {
  skip: !applicationConnectionString || !workerConnectionString || !adminConnectionString,
}, async () => {
  const applicationRepository = createPostgresRepository({ connectionString: applicationConnectionString!, maxConnections: 2 });
  const workerRepository = createPostgresRepository({ connectionString: workerConnectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let projectId: string | undefined;
  try {
    const source = await runningWebsite(applicationRepository, workerRepository, "result-checkpoint");
    projectId = source.projectId;
    const checkpointReference = `urn:sha256:${"6".repeat(64)}`;
    const waiting = waitInput(source, checkpointReference, "result-checkpoint");
    await workerRepository.waitAnalysisForAuthentication(
      source.workerId, source.runId, waiting, source.claim.leaseGeneration,
    );
    await applicationRepository.resumeAnalysisAfterAuthentication(owner, resumeInput(
      source, checkpointReference, `urn:sha256:${"7".repeat(64)}`, "result-checkpoint",
    ));
    const workerB = await workerRepository.claimAnalysis("result-checkpoint-worker-b", 60_000, ["website"]);
    assert.equal(workerB?.id, source.runId);
    const result = {
      capabilities: [],
      diagnostics: [{ code: "NO_SUPPORTED_OPERATIONS", operationKey: "website" }],
      evidence: [{ source: "runtime" as const, content: "{}",
        reference: "urn:sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" }],
    };
    const checkpoint = await workerRepository.checkpointWebsiteAuthenticationResult(
      "result-checkpoint-worker-b", source.runId, result, workerB!.leaseGeneration,
    );
    assert.doesNotMatch(JSON.stringify(checkpoint), /https?:|secretref:|result-checkpoint-worker-b/);
    const persisted = await admin.query(
      "select ownership_decision_digest, result_checkpoint_hash, result_checkpoint_output_reference, " +
      "result_checkpoint_worker_identity_digest, result_checkpoint_lease_generation, result_checkpointed_at, " +
      "job.status as job_status, task.status as task_status " +
      "from private.website_live_receipt_evidence evidence " +
      "join private.analysis_jobs job on job.analysis_run_id = evidence.analysis_run_id " +
      "join private.workflow_tasks task on task.id = evidence.workflow_task_id " +
      "where evidence.analysis_run_id = $1",
      [source.runId],
    );
    assert.equal(persisted.rows[0]?.ownership_decision_digest, "a".repeat(64));
    assert.equal(persisted.rows[0]?.result_checkpoint_hash, checkpoint.resultHash);
    assert.equal(persisted.rows[0]?.result_checkpoint_output_reference, checkpoint.outputReference);
    assert.equal(persisted.rows[0]?.result_checkpoint_worker_identity_digest,
      createHash("sha256").update("result-checkpoint-worker-b").digest("hex"));
    assert.equal(Number(persisted.rows[0]?.result_checkpoint_lease_generation), workerB!.leaseGeneration);
    assert.ok(persisted.rows[0]?.result_checkpointed_at);
    assert.equal(persisted.rows[0]?.job_status, "running");
    assert.equal(persisted.rows[0]?.task_status, "running");

    await admin.query(
      "update private.analysis_jobs set lease_expires_at = now() - interval '1 millisecond' where analysis_run_id = $1",
      [source.runId],
    );
    await admin.query(
      "update private.workflow_tasks set lease_expires_at = now() - interval '1 millisecond' " +
      "where workflow_run_id = $1 and phase = 'analysis'",
      [source.runId],
    );
    const workerC = await workerRepository.claimAnalysis("result-checkpoint-worker-c", 60_000, ["website"]);
    assert.equal(workerC?.authenticationCheckpoint?.resultCheckpoint?.resultHash, checkpoint.resultHash);
    await workerRepository.completeCheckpointedWebsiteAuthenticationAnalysis(
      "result-checkpoint-worker-c", source.runId, checkpoint.resultHash, workerC!.leaseGeneration,
    );
    const completed = await admin.query(
      "select completion_worker_identity_digest, completion_lease_generation, restart_verified, " +
      "resume_acknowledged_at from private.website_live_receipt_evidence where analysis_run_id = $1",
      [source.runId],
    );
    assert.deepEqual({
      ...completed.rows[0],
      completion_lease_generation: Number(completed.rows[0]?.completion_lease_generation),
      resume_acknowledged_at: Boolean(completed.rows[0]?.resume_acknowledged_at),
    }, {
      completion_worker_identity_digest: createHash("sha256").update("result-checkpoint-worker-c").digest("hex"),
      completion_lease_generation: workerC!.leaseGeneration,
      restart_verified: true,
      resume_acknowledged_at: true,
    });
    assert.equal((await applicationRepository.getAnalysisResult(owner, source.runId))?.evidence.length, 1);
    const counts = await admin.query(
      "select (select count(*)::integer from public.analysis_evidence where analysis_run_id = $1) as evidence, " +
      "(select count(*)::integer from public.workflow_evidence where workflow_run_id = $1) as links",
      [source.runId],
    );
    assert.deepEqual(counts.rows[0], { evidence: 1, links: 1 });
  } finally {
    if (projectId) await admin.query("delete from public.projects where id = $1", [projectId]);
    await Promise.allSettled([applicationRepository.close(), workerRepository.close(), admin.end()]);
  }
});
