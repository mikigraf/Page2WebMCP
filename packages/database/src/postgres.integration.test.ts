import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { compileWebMcpRelease } from "../../compiler/src/compiler.ts";
import { acmeCapabilityPlans } from "../../../apps/acme-support/src/capability-plans.ts";
import { createPostgresRepository } from "./postgres.ts";
import {
  capabilityStateDigest,
  RepositoryError,
  type RepositoryActor
} from "./control-plane.ts";

const connectionString = process.env.PAGE2WEBMCP_TEST_DATABASE_URL;
const adminConnectionString = process.env.PAGE2WEBMCP_TEST_ADMIN_DATABASE_URL;

function releaseCandidate(code: string, allowedOrigin = "https://acme.example") {
  return {
    code,
    contentHash: createHash("sha256").update(Buffer.from(code)).digest("hex"),
    allowedOrigin,
    manifest: { version: 1 }
  };
}

test("Postgres repository persists and recovers the fixture lifecycle", { skip: !connectionString }, async () => {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const role = await pool.query(
    "select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = current_user"
  );
  assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, rolinherit: false });
  await assert.rejects(pool.query("select * from public.projects"), (error: unknown) =>
    error instanceof pg.DatabaseError && error.code === "42501");
  await pool.end();

  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 2 });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner"
  };
  try {
    const project = await repository.createProject(actor, {
      name: "Acme Support",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "postgres-project",
      inputHash: "postgres-project"
    });
    assert.equal((await repository.createProject(actor, {
      name: "Acme Support",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "postgres-project",
      inputHash: "postgres-project"
    })).id, project.id);
    assert.equal((await repository.listProjects(actor)).some((item) => item.id === project.id), true);

    const run = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-analysis",
      inputHash: "analysis-input"
    });
    const duplicate = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-analysis",
      inputHash: "analysis-input"
    });
    assert.equal(duplicate.id, run.id);
    const claimed = await repository.claimAnalysis("postgres-worker", 60_000);
    assert.equal(claimed?.id, run.id);
    assert.equal(claimed?.sourceType, "website");
    assert.equal(claimed?.sourceUrl, "https://acme.example");

    const completed = await repository.completeAnalysis("postgres-worker", run.id, {
      capabilities: [
        { stableName: "find_order", riskTier: "R0", status: "proposed" },
        { stableName: "delete_account", riskTier: "R3", status: "blocked" }
      ],
      evidence: [{ source: "openapi", path: "/api/orders" }],
      release: {
        code: "export const persisted = true;",
        contentHash: "candidate",
        allowedOrigin: "https://acme.example",
        manifest: { version: 1 }
      }
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.leaseOwner, undefined);
    assert.equal(completed.leaseExpiresAt, undefined);
    assert.equal((await repository.getAnalysis(actor, run.id)).status, "succeeded");
    assert.equal((await repository.listCapabilities(actor, project.id)).length, 2);

    const capabilityDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, run.id));
    const verificationInput = {
      analysisRunId: run.id,
      capabilityStateDigest: capabilityDigest,
      candidate: releaseCandidate("export const persisted = true;"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    };
    const verification = await repository.saveVerification(actor, project.id, verificationInput);
    const release = await repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: capabilityDigest,
      candidateContentHash: verification.candidateContentHash,
      idempotencyKey: "postgres-publish",
      inputHash: "publish-input"
    });
    assert.equal(release.capabilityStateDigest, capabilityDigest);
    assert.equal((await repository.saveVerification(actor, project.id, verificationInput)).id, verification.id);
    await assert.rejects(repository.saveVerification(actor, project.id, {
      ...verificationInput,
      candidate: releaseCandidate("export const changedAfterPublish = true;")
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CANDIDATE_CHANGED"));
    assert.equal((await repository.getReleaseArtifact(release.contentHash)).code, "export const persisted = true;");
    assert.equal((await repository.listAuditEvents(actor)).some((event) => event.action === "release.published"), true);

    const secondRun = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-analysis-two",
      inputHash: "analysis-input-two"
    });
    assert.equal((await repository.claimAnalysis("postgres-worker-two", 60_000))?.id, secondRun.id);
    await repository.completeAnalysis("postgres-worker-two", secondRun.id, {
      capabilities: [{ stableName: "find_order", riskTier: "R0", status: "proposed" }],
      evidence: [{ source: "runtime", path: "/api/orders" }],
      release: {
        code: "export const persisted = true;",
        contentHash: "untrusted-candidate-hash",
        allowedOrigin: "https://acme.example"
      }
    });
    const secondDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, secondRun.id));
    const secondVerification = await repository.saveVerification(actor, project.id, {
      analysisRunId: secondRun.id,
      capabilityStateDigest: secondDigest,
      candidate: releaseCandidate("export const persisted = true;"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    });
    const secondRelease = await repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: secondRun.id,
      capabilityStateDigest: secondDigest,
      candidateContentHash: secondVerification.candidateContentHash,
      idempotencyKey: "postgres-publish-two",
      inputHash: "publish-input-two"
    });
    assert.equal(secondRelease.capabilityStateDigest, secondDigest);
    assert.notEqual(secondRelease.id, release.id);
    assert.equal(secondRelease.contentHash, release.contentHash);
    assert.notEqual(secondRelease.analysisRunId, release.analysisRunId);

    const failedRun = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-analysis-failed",
      inputHash: "analysis-input-failed"
    });
    assert.equal((await repository.claimAnalysis("postgres-worker-failed", 60_000))?.id, failedRun.id);
    const failed = await repository.failAnalysis("postgres-worker-failed", failedRun.id, "TERMINAL", false);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "TERMINAL");
    assert.equal(failed.leaseOwner, undefined);

    const outsider: RepositoryActor = {
      id: "22222222-2222-2222-2222-222222222222",
      organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      role: "owner"
    };
    await assert.rejects(repository.getProject(outsider, project.id), (error: unknown) =>
      error instanceof RepositoryError && error.code === "NOT_FOUND");

    const forgedViewer: RepositoryActor = {
      id: "44444444-4444-4444-4444-444444444444",
      organizationId: actor.organizationId,
      role: "owner"
    };
    await assert.rejects(
      repository.createProject(forgedViewer, {
        name: "Forbidden",
        sourceType: "website",
        url: "https://acme.example",
        idempotencyKey: "forged-project",
        inputHash: "forged-project"
      }),
      (error: unknown) => error instanceof RepositoryError && error.code === "FORBIDDEN"
    );
  } finally {
    await repository.close();
  }
});

test("Postgres queue exhaustion and stale release gates match the in-memory contract", {
  skip: !connectionString || !adminConnectionString
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString, max: 1 });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner"
  };
  try {
    const project = await repository.createProject(actor, {
      name: "Recovery",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "recovery-project",
      inputHash: "recovery-project"
    });
    await admin.query(
      "update private.idempotency_keys set expires_at = now() - interval '1 second' " +
      "where organization_id = $1 and actor_id = $2 and operation = 'project' and idempotency_key = $3",
      [actor.organizationId, actor.id, "recovery-project"]
    );
    const afterExpiry = await repository.createProject(actor, {
      name: "Recovery",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "recovery-project",
      inputHash: "recovery-project"
    });
    assert.notEqual(afterExpiry.id, project.id);
    const otherOrganization: RepositoryActor = {
      id: "22222222-2222-2222-2222-222222222222",
      organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      role: "owner"
    };
    const scopedProject = await repository.createProject(otherOrganization, {
      name: "Recovery B",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "recovery-project",
      inputHash: "recovery-project"
    });
    assert.equal(scopedProject.organizationId, otherOrganization.organizationId);
    const run = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "queue-recovery",
      inputHash: "queue-recovery"
    });
    await assert.rejects(
      repository.enqueueAnalysis(actor, {
        projectId: project.id,
        idempotencyKey: "queue-conflict",
        inputHash: "queue-conflict"
      }),
      (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE"
    );
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal((await repository.claimAnalysis(`recovery-${attempt}`, 1_000))?.id, run.id);
      await admin.query(
        "update private.analysis_jobs set lease_expires_at = now() - interval '1 second' where analysis_run_id = $1",
        [run.id]
      );
      await assert.rejects(repository.heartbeatAnalysis(`recovery-${attempt}`, run.id, 1_000), (error: unknown) =>
        error instanceof RepositoryError && error.code === "LEASE_LOST");
    }
    assert.equal(await repository.claimAnalysis("recovery-4", 1_000), undefined);
    assert.equal((await repository.getAnalysis(actor, run.id)).status, "failed");
    assert.equal((await repository.getProject(actor, project.id)).status, "failed");

    const publishProject = await repository.createProject(actor, {
      name: "Stale gate",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "stale-project",
      inputHash: "stale-project"
    });
    const publishRun = await repository.enqueueAnalysis(actor, {
      projectId: publishProject.id,
      idempotencyKey: "stale-analysis",
      inputHash: "stale-analysis"
    });
    assert.equal((await repository.claimAnalysis("stale-worker", 60_000))?.id, publishRun.id);
    await repository.completeAnalysis("stale-worker", publishRun.id, {
      capabilities: [
        { stableName: "create_support_ticket", riskTier: "R1", status: "proposed" },
        { stableName: "find_order", riskTier: "R0", status: "proposed" }
      ],
      evidence: [{ source: "runtime", path: "/api/orders" }],
      release: { code: "export const stale = true;", contentHash: "ignored", allowedOrigin: "https://acme.example" }
    });
    const initialCapabilities = await repository.listAnalysisCapabilities(actor, publishRun.id);
    const capability = initialCapabilities.find((item) => item.stableName === "create_support_ticket");
    const blockedCapability = initialCapabilities.find((item) => item.stableName === "find_order");
    assert.ok(capability);
    assert.ok(blockedCapability);
    const staleDigest = capabilityStateDigest(initialCapabilities);
    const verification = await repository.saveVerification(actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: staleDigest,
      candidate: releaseCandidate("export const stale = true;"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    });
    await repository.reviewCapability(actor, capability.id, { action: "block", expectedVersion: 1 });
    await assert.rejects(repository.publishRelease(actor, {
      projectId: publishProject.id,
      analysisRunId: publishRun.id,
      capabilityStateDigest: staleDigest,
      candidateContentHash: verification.candidateContentHash,
      idempotencyKey: "stale-publish",
      inputHash: "stale-publish"
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CAPABILITIES_CHANGED"));

    const reviewedDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, publishRun.id));
    await assert.rejects(repository.saveVerification(actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidate: { ...releaseCandidate("export const mismatch = true;"), contentHash: "0".repeat(64) },
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CANDIDATE_HASH_MISMATCH"));

    const firstCandidate = await repository.saveVerification(actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidate: releaseCandidate("export const subset = 'first';"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    });
    const latestCandidate = await repository.saveVerification(actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidate: releaseCandidate("export const subset = 'latest';"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    });
    await admin.query(
      "update public.analysis_evidence set expires_at = now() - interval '1 second' " +
      "where analysis_run_id = $1 and organization_id = $2",
      [publishRun.id, actor.organizationId]
    );
    await assert.rejects(repository.publishRelease(actor, {
      projectId: publishProject.id,
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidateContentHash: latestCandidate.candidateContentHash,
      idempotencyKey: "publish-expired-evidence",
      inputHash: "publish-expired-evidence"
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("EVIDENCE_MISSING_OR_EXPIRED"));
    await admin.query(
      "update public.analysis_evidence set expires_at = now() + interval '1 day' " +
      "where analysis_run_id = $1 and organization_id = $2",
      [publishRun.id, actor.organizationId]
    );
    await assert.rejects(repository.publishRelease(actor, {
      projectId: publishProject.id,
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidateContentHash: firstCandidate.candidateContentHash,
      idempotencyKey: "publish-old-subset",
      inputHash: "publish-old-subset"
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CANDIDATE_CHANGED"));
    const subsetRelease = await repository.publishRelease(actor, {
      projectId: publishProject.id,
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidateContentHash: latestCandidate.candidateContentHash,
      idempotencyKey: "publish-latest-subset",
      inputHash: "publish-latest-subset"
    });
    assert.equal(subsetRelease.code, "export const subset = 'latest';");
  } finally {
    await repository.close();
    await admin.end();
  }
});

test("Postgres preserves the worker candidate across capability changes and publishes the freshly verified candidate", {
  skip: !connectionString || !adminConnectionString
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString, max: 1 });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner"
  };
  const fixturePlans = acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name !== "get_order_status");
  const source = compileWebMcpRelease(fixturePlans);
  const subset = compileWebMcpRelease(fixturePlans.filter((plan) => plan.tool.name === "find_order"));

  try {
    const project = await repository.createProject(actor, {
      name: "Immutable source recovery",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "immutable-source-project",
      inputHash: "immutable-source-project"
    });
    const run = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "immutable-source-analysis",
      inputHash: "immutable-source-analysis"
    });
    assert.equal((await repository.claimAnalysis("immutable-source-worker", 60_000))?.id, run.id);
    await repository.completeAnalysis("immutable-source-worker", run.id, {
      capabilities: [
        { stableName: "find_order", riskTier: "R0", status: "proposed" },
        { stableName: "create_support_ticket", riskTier: "R1", status: "proposed" }
      ],
      evidence: [{ source: "runtime", path: "/api/orders" }],
      release: source
    });
    const ticket = (await repository.listAnalysisCapabilities(actor, run.id))
      .find((capability) => capability.stableName === "create_support_ticket");
    assert.ok(ticket);
    const blocked = await repository.reviewCapability(actor, ticket.id, {
      action: "block",
      expectedVersion: ticket.version
    });
    const blockedDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, run.id));
    const subsetVerification = await repository.saveVerification(actor, project.id, {
      analysisRunId: run.id,
      capabilityStateDigest: blockedDigest,
      candidate: subset,
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    });

    assert.equal((await repository.getAnalysisResult(actor, run.id))?.release.code, source.code);
    await repository.reviewCapability(actor, blocked.id, {
      action: "approve",
      expectedVersion: blocked.version
    });
    await assert.rejects(repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: blockedDigest,
      candidateContentHash: subsetVerification.candidateContentHash,
      idempotencyKey: "immutable-source-publish",
      inputHash: "immutable-source-publish-stale"
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CAPABILITIES_CHANGED"));

    const approvedDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, run.id));
    const fullVerification = await repository.saveVerification(actor, project.id, {
      analysisRunId: run.id,
      capabilityStateDigest: approvedDigest,
      candidate: source,
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    });
    const release = await repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: approvedDigest,
      candidateContentHash: fullVerification.candidateContentHash,
      idempotencyKey: "immutable-source-publish",
      inputHash: "immutable-source-publish-fresh"
    });
    assert.equal(release.code, source.code);
    assert.equal(release.contentHash, source.contentHash);

    const storedSource = await admin.query(
      "select release_code, release_hash, allowed_origin, release_manifest from public.analysis_runs where id = $1",
      [run.id]
    );
    assert.equal(storedSource.rows[0]?.release_code, source.code);
    assert.equal(storedSource.rows[0]?.release_hash, source.contentHash);
    assert.deepEqual(storedSource.rows[0]?.release_manifest, source.manifest);
    const storedCandidates = await admin.query(
      "select candidate_code, candidate_content_hash, candidate_allowed_origin, candidate_manifest " +
      "from public.verification_runs where analysis_run_id = $1 order by revision",
      [run.id]
    );
    assert.deepEqual(storedCandidates.rows.map((row) => ({
      code: row.candidate_code,
      contentHash: row.candidate_content_hash,
      allowedOrigin: row.candidate_allowed_origin,
      manifest: row.candidate_manifest
    })), [
      { code: subset.code, contentHash: subset.contentHash, allowedOrigin: subset.allowedOrigin, manifest: subset.manifest },
      { code: source.code, contentHash: source.contentHash, allowedOrigin: source.allowedOrigin, manifest: source.manifest }
    ]);
  } finally {
    await repository.close();
    await admin.end();
  }
});

test("publication evidence locking serializes with retention cleanup", {
  skip: !connectionString || !adminConnectionString
}, async () => {
  const repository = createPostgresRepository({
    connectionString: connectionString!,
    maxConnections: 2,
    statementTimeoutMs: 10_000
  });
  const admin = new pg.Pool({ connectionString: adminConnectionString, max: 3 });
  const blocker = await admin.connect();
  const observer = await admin.connect();
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner"
  };
  let publication: Promise<unknown> | undefined;
  let blockerOpen = false;
  try {
    const project = await repository.createProject(actor, {
      name: "Retention race",
      sourceType: "website",
      url: "https://acme.example",
      idempotencyKey: "retention-race-project",
      inputHash: "retention-race-project"
    });
    const run = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "retention-race-analysis",
      inputHash: "retention-race-analysis"
    });
    assert.equal((await repository.claimAnalysis("retention-race-worker", 60_000))?.id, run.id);
    await repository.completeAnalysis("retention-race-worker", run.id, {
      capabilities: [{ stableName: "find_order", riskTier: "R0", status: "proposed" }],
      evidence: [{ source: "runtime", path: "/api/orders" }],
      release: releaseCandidate("export const retentionRace = true;")
    });
    const digest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, run.id));
    const verification = await repository.saveVerification(actor, project.id, {
      analysisRunId: run.id,
      capabilityStateDigest: digest,
      candidate: releaseCandidate("export const retentionRace = true;"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20
    });

    await blocker.query("begin");
    blockerOpen = true;
    await blocker.query("lock table public.releases in access exclusive mode");
    publication = repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: digest,
      candidateContentHash: verification.candidateContentHash,
      idempotencyKey: "retention-race-publish",
      inputHash: "retention-race-publish"
    });
    void publication.catch(() => undefined);

    const deadline = Date.now() + 1_500;
    let publishIsBlocked = false;
    while (Date.now() < deadline) {
      const activity = await observer.query(
        "select 1 from pg_stat_activity where usename = 'page2webmcp_test_runtime' " +
        "and wait_event_type = 'Lock' and query like '%public.releases%' limit 1"
      );
      if (activity.rows[0]) {
        publishIsBlocked = true;
        break;
      }
      await delay(20);
    }
    assert.equal(publishIsBlocked, true, "publish did not reach its evidence-to-insert critical section");

    await observer.query(
      "update public.analysis_evidence set expires_at = now() - interval '1 second' " +
      "where analysis_run_id = $1 and organization_id = $2",
      [run.id, actor.organizationId]
    );
    await observer.query("begin");
    await observer.query("set local role page2webmcp_maintenance");
    const duringPublish = await observer.query("select * from private.purge_expired_data(4)");
    await observer.query("commit");

    await blocker.query("commit");
    blockerOpen = false;
    const release = await publication;
    assert.equal(Number(duringPublish.rows[0].analysis_evidence_deleted), 0);
    assert.equal((release as { analysisRunId: string }).analysisRunId, run.id);

    await observer.query("begin");
    await observer.query("set local role page2webmcp_maintenance");
    const afterPublish = await observer.query("select * from private.purge_expired_data(4)");
    await observer.query("commit");
    assert.equal(Number(afterPublish.rows[0].analysis_evidence_deleted), 1);
    assert.equal((await repository.getReleaseArtifact(verification.candidateContentHash)).analysisRunId, run.id);
  } finally {
    if (blockerOpen) await blocker.query("rollback").catch(() => undefined);
    await publication?.catch(() => undefined);
    blocker.release();
    observer.release();
    await repository.close();
    await admin.end();
  }
});
