import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  RepositoryError,
  type ClaimedAnalysisRunRecord,
  type ControlPlaneRepository,
  type RepositoryActor,
  type ResumeAnalysisAfterAuthenticationInput,
  type WaitAnalysisForAuthenticationInput,
} from "./control-plane.ts";
import { createPostgresRepository } from "./postgres.ts";

const connectionString = process.env.PAGE2WEBMCP_TEST_DATABASE_URL;
const explicitApplicationConnectionString = process.env.PAGE2WEBMCP_TEST_APP_DATABASE_URL;
const explicitWorkerConnectionString = process.env.PAGE2WEBMCP_TEST_WORKER_DATABASE_URL;
const applicationConnectionString = explicitApplicationConnectionString ?? connectionString;
const workerConnectionString = explicitWorkerConnectionString ?? connectionString;
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
  source: Pick<Awaited<ReturnType<typeof runningWebsite>>, "sourceSnapshotId" | "sourceIdentityHash">,
  checkpointReference: string,
  suffix: string,
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(),
): WaitAnalysisForAuthenticationInput {
  return {
    checkpointReference,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest: TARGET_ORIGIN_DIGEST,
    expiresAt,
    idempotencyKey: `authentication-wait-${suffix}`,
    inputHash: `authentication-wait-${suffix}`,
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
    assert.deepEqual(claimed?.authenticationCheckpoint, {
      checkpointReference,
      authenticationEvidenceReference: evidenceReference,
      sourceSnapshotId: source.sourceSnapshotId,
      sourceIdentityHash: source.sourceIdentityHash,
      targetOriginDigest: TARGET_ORIGIN_DIGEST,
      expiresAt: waitingInput.expiresAt,
    });
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
  } finally {
    await admin.end();
  }
});
