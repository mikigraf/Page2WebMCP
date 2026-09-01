import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { compileWebMcpRelease } from "../../compiler/src/compiler.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../../apps/acme-support/src/capability-plans.ts";
import type { CapabilityPlan } from "../../capability-ir/src/plan.ts";
import { createPostgresRepository } from "./postgres.ts";
import {
  capabilityStateDigest,
  RELEASE_VERIFICATION_CHECK_NAMES,
  RepositoryError,
  type CandidateRelease,
  type ControlPlaneRepository,
  type RepositoryActor,
  type VerificationRequest,
} from "./control-plane.ts";
import { computeSourceIdentityHash } from "./source-identity.ts";

function passedVerificationChecks() {
  return RELEASE_VERIFICATION_CHECK_NAMES.map((name) => ({ name, status: "passed" as const }));
}

const connectionString = process.env.PAGE2WEBMCP_TEST_DATABASE_URL;
const adminConnectionString = process.env.PAGE2WEBMCP_TEST_ADMIN_DATABASE_URL;

const canonicalFixturePlans = acmeCapabilityPlans("https://acme.example");

function plans(...names: string[]): CapabilityPlan[] {
  return names.map((name) => canonicalFixturePlans.find((plan) => plan.tool.name === name)!);
}

function capabilities(...names: string[]) {
  return plans(...names).map((plan) => ({ plan, status: "proposed" as const }));
}

function evidenceFor(selectedPlans: CapabilityPlan[]) {
  const references = new Set(selectedPlans.flatMap((plan) => plan.evidence.map(({ reference }) => reference)));
  return acmeCapabilityEvidence().filter(({ reference }) => references.has(reference));
}

function releaseCandidate(code: string, selectedPlans = plans("find_order"), allowedOrigin = "https://acme.example") {
  const compiled = compileWebMcpRelease(selectedPlans);
  return {
    code,
    contentHash: createHash("sha256").update(Buffer.from(code)).digest("hex"),
    allowedOrigin,
    manifest: compiled.manifest
  };
}

function hostedArtifactIdentity(contentHash: string) {
  const artifactUrl = `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${contentHash}.js`;
  return {
    artifactUrl,
    downloadUrl: `${artifactUrl}?download=page2webmcp-${contentHash}.js`,
    localOnly: false,
  } as const;
}

function verificationEvidence(candidate: CandidateRelease, mode: VerificationRequest["verificationMode"]) {
  const manifest = candidate.manifest as {
    releaseId: string;
    plans: ReadonlyArray<{ tool: { name: string } }>;
  };
  return {
    verifierIdentity: {
      protocolVersion: 1 as const,
      mode,
      webMcpImplementation: "native" as const,
      verifierOriginDigest: "b".repeat(64),
    },
    observation: {
      observedContentHash: candidate.contentHash,
      observedIntegrity: `sha384-${createHash("sha384").update(candidate.code).digest("base64")}`,
      observedReleaseId: manifest.releaseId,
      observedTargetOrigin: candidate.allowedOrigin,
      registeredTools: manifest.plans.map(({ tool }) => tool.name).sort(),
      trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: candidate.contentHash },
      controlPlaneRequestsDuringExecution: 0,
      modelRequestsDuringExecution: 0,
    },
  } as const;
}

function saveVerification(
  repository: Pick<ControlPlaneRepository, "saveVerification">,
  actor: RepositoryActor,
  projectId: string,
  input: Omit<VerificationRequest, "verifierIdentity" | "observation">,
) {
  return repository.saveVerification(actor, projectId, {
    ...input,
    ...verificationEvidence(input.candidate, input.verificationMode),
  });
}

test("Postgres personal organization provisioning converges and revoked sessions fail closed", {
  skip: !connectionString || !adminConnectionString
}, async () => {
  const userId = "66666666-6666-4666-8666-666666666666";
  const sessionId = "66666666-aaaa-4aaa-8aaa-666666666666";
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 5 });
  try {
    await admin.query(
      "insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now()) on conflict (id) do update set email_confirmed_at = now()",
      [userId, "concurrent@example.test"]
    );
    await admin.query(
      "insert into auth.sessions (id, user_id, not_after) values ($1, $2, now() + interval '1 hour') on conflict (id) do update set not_after = excluded.not_after",
      [sessionId, userId]
    );
    const actors = await Promise.all(Array.from({ length: 12 }, () =>
      repository.provisionPersonalOrganization({ id: userId, email: "concurrent@example.test" })));
    assert.equal(new Set(actors.map(({ organizationId }) => organizationId)).size, 1);
    assert.equal(actors.every(({ role }) => role === "owner"), true);
    assert.deepEqual(await repository.resolveActor(userId, undefined, sessionId), actors[0]);

    await admin.query("delete from auth.sessions where id = $1", [sessionId]);
    await assert.rejects(repository.resolveActor(userId, undefined, sessionId), (error: unknown) =>
      error instanceof RepositoryError && error.code === "SESSION_REVOKED");
  } finally {
    await admin.query("delete from public.memberships where user_id = $1", [userId]);
    await admin.query("delete from public.organizations where personal_owner_user_id = $1", [userId]);
    await admin.query("delete from auth.sessions where user_id = $1", [userId]);
    await admin.query("delete from auth.users where id = $1", [userId]);
    await repository.close();
    await admin.end();
  }
});

test("Postgres copies canonical OpenAPI verification context into an immutable analysis job", {
  skip: !connectionString || !adminConnectionString,
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
  };
  try {
    const configuration = {
      kind: "openapi" as const,
      targetOrigin: "https://configuration.widgets.example",
      testPageUrl: "https://configuration.widgets.example/checkout",
      environment: "staging" as const,
    };
    const project = await repository.createProject(actor, {
      name: "Postgres source configuration",
      sourceType: "openapi",
      url: "https://api.configuration.widgets.example/openapi.json",
      sourceConfiguration: configuration,
      idempotencyKey: "postgres-source-configuration-project",
      inputHash: "postgres-source-configuration-project",
    });
    assert.deepEqual((await repository.listProjectSources(actor, project.id))[0]?.sourceConfiguration, configuration);
    assert.deepEqual((await repository.getActiveProjectSource(actor, project.id)).sourceConfiguration, configuration);
    const run = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-source-configuration-analysis",
      inputHash: "postgres-source-configuration-analysis",
    });
    const stored = await admin.query(
      "select source_configuration from private.analysis_jobs where analysis_run_id = $1",
      [run.id],
    );
    assert.deepEqual(stored.rows[0]?.source_configuration, configuration);
    const claimed = await repository.claimAnalysis("postgres-source-configuration-worker", 60_000);
    assert.deepEqual(claimed?.sourceConfiguration, configuration);
    const sourceHash = createHash("sha256").update("postgres-openapi-document").digest("hex");
    const sourceArtifact = {
      contentHash: sourceHash,
      artifactReference: `urn:sha256:${sourceHash}`,
      finalUrl: "https://api.configuration.widgets.example/openapi.json",
      mimeType: "application/json",
      sizeBytes: Buffer.byteLength("postgres-openapi-document"),
    } as const;
    const sourceEvidence = JSON.stringify({ sourceDigest: sourceArtifact.artifactReference });
    await repository.completeAnalysis("postgres-source-configuration-worker", run.id, {
      capabilities: [],
      diagnostics: [{ code: "NO_SUPPORTED_OPERATIONS", operationKey: "document" }],
      evidence: [{ source: "openapi", content: sourceEvidence,
        reference: `urn:sha256:${createHash("sha256").update(sourceEvidence).digest("hex")}` }],
      providerProvenance: {
        mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false,
      },
      sourceArtifact,
    }, claimed!.leaseGeneration);
    assert.deepEqual((await repository.listSourceSnapshots(actor, project.id))[0]?.sourceArtifact, sourceArtifact);
    const frozen = await admin.query(
      "select content_hash, artifact_reference, source_artifact_metadata from public.source_snapshots " +
      "where project_id = $1",
      [project.id],
    );
    assert.deepEqual(frozen.rows[0], {
      content_hash: sourceArtifact.contentHash,
      artifact_reference: sourceArtifact.artifactReference,
      source_artifact_metadata: {
        finalUrl: sourceArtifact.finalUrl, mimeType: sourceArtifact.mimeType, sizeBytes: sourceArtifact.sizeBytes,
      },
    });
    await admin.query("delete from public.analysis_evidence where analysis_run_id = $1", [run.id]);
    assert.deepEqual((await repository.getAnalysisResult(actor, run.id))?.sourceArtifact, sourceArtifact);
    await assert.rejects(admin.query(
      "update public.source_snapshots set content_hash = $2 where project_id = $1",
      [project.id, "f".repeat(64)],
    ), (error: unknown) => (error as { code?: string }).code === "23514");
    await assert.rejects(admin.query(
      "update public.project_sources set source_configuration = $2::jsonb where project_id = $1 and active",
      [project.id, JSON.stringify({
        ...configuration,
        testPageUrl: `${configuration.testPageUrl}?session=secret`,
      })],
    ), (error: unknown) => (error as { code?: string }).code === "23514");
    assert.deepEqual((await repository.getActiveProjectSource(actor, project.id)).sourceConfiguration, configuration);
  } finally {
    await repository.close();
    await admin.end();
  }
});

test("Postgres GitHub workflow exposes exact reviewed material only under its live worker lease", {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 3 });
  const direct = new pg.Pool({ connectionString: connectionString!, max: 1 });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
  };
  try {
    const project = await repository.createProject(actor, {
      name: "Postgres reviewed GitHub binding",
      sourceType: "github",
      url: "https://github.com/bright-tools/postgres-widget",
      idempotencyKey: "postgres-github-binding-project",
      inputHash: "postgres-github-binding-project",
    });
    const analysis = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-github-binding-analysis",
      inputHash: "postgres-github-binding-analysis",
    });
    const analysisClaim = await repository.claimAnalysis("postgres-github-binding-analysis-worker", 60_000);
    assert.equal(analysisClaim?.id, analysis.id);
    await repository.completeAnalysis("postgres-github-binding-analysis-worker", analysis.id, {
      capabilities: capabilities("create_support_ticket"),
      diagnostics: [],
      evidence: evidenceFor(plans("create_support_ticket")),
      release: releaseCandidate("export const githubReviewed = true;", plans("create_support_ticket")),
    }, analysisClaim!.leaseGeneration);
    const [capability] = await repository.listAnalysisCapabilities(actor, analysis.id);
    assert.ok(capability);
    await repository.reviewCapability(actor, capability.id, { action: "approve", expectedVersion: capability.version });
    const workflow = await repository.startWorkflow(actor, {
      projectId: project.id,
      analysisRunId: analysis.id,
      idempotencyKey: "postgres-github-binding-workflow",
      inputHash: "postgres-github-binding-workflow",
    });
    assert.equal(workflow.reviewedAnalysisRunId, analysis.id);
    assert.equal(
      (await repository.getLatestReviewedWorkflowForAnalysis(actor, project.id, analysis.id))?.id,
      workflow.id,
    );
    const task = await repository.claimWorkflowTask("postgres-github-binding-worker");
    assert.ok(task);
    const directMaterialCounts = async (workerId?: string, leaseGeneration?: number) => {
      const client = await direct.connect();
      try {
        await client.query("begin");
        await client.query("set local role page2webmcp_worker");
        if (workerId !== undefined && leaseGeneration !== undefined) {
          await client.query(
            "select set_config('page2webmcp.workflow_task_id', $1, true), " +
            "set_config('page2webmcp.worker_id', $2, true), " +
            "set_config('page2webmcp.lease_generation', $3, true)",
            [task.id, workerId, String(leaseGeneration)],
          );
        }
        const counts = await client.query(
          "select " +
          "(select count(*)::integer from public.project_sources where project_id = $1) as sources, " +
          "(select count(*)::integer from public.source_snapshots where project_id = $1) as snapshots, " +
          "(select count(*)::integer from public.analysis_evidence where analysis_run_id = $2) as evidence, " +
          "(select count(*)::integer from public.capabilities where analysis_run_id = $2) as capabilities",
          [project.id, analysis.id],
        );
        return counts.rows[0] as { sources: number; snapshots: number; evidence: number; capabilities: number };
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    };
    assert.deepEqual(await directMaterialCounts(), { sources: 0, snapshots: 0, evidence: 0, capabilities: 0 });
    assert.deepEqual(await directMaterialCounts("different-worker", task.leaseGeneration),
      { sources: 0, snapshots: 0, evidence: 0, capabilities: 0 });
    assert.deepEqual(await directMaterialCounts("postgres-github-binding-worker", task.leaseGeneration + 1),
      { sources: 0, snapshots: 0, evidence: 0, capabilities: 0 });
    const authorizedCounts = await directMaterialCounts("postgres-github-binding-worker", task.leaseGeneration);
    assert.equal(authorizedCounts.sources, 1);
    assert.equal(authorizedCounts.snapshots, 1);
    assert.ok(authorizedCounts.evidence > 0);
    assert.equal(authorizedCounts.capabilities, 1);
    const material = await repository.getWorkflowExecutionMaterial(
      "postgres-github-binding-worker", task.id, task.leaseGeneration,
    );
    assert.equal(material.analysisRunId, analysis.id);
    assert.equal(material.sourceUrl, project.url);
    await assert.rejects(repository.getWorkflowExecutionMaterial(
      "postgres-github-binding-worker", task.id, task.leaseGeneration + 1,
    ), (error: unknown) => error instanceof RepositoryError && error.code === "LEASE_LOST");
    await repository.cancelWorkflow(actor, {
      runId: workflow.id,
      idempotencyKey: "postgres-github-binding-cancel",
      inputHash: "postgres-github-binding-cancel",
    });
    assert.deepEqual(await directMaterialCounts("postgres-github-binding-worker", task.leaseGeneration),
      { sources: 0, snapshots: 0, evidence: 0, capabilities: 0 });
  } finally {
    await repository.close();
    await direct.end();
  }
});

test("Postgres dedicated analysis claims leave other source types queued", {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 2 });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
  };
  try {
    const runs = new Map<string, string>();
    for (const [sourceType, url] of [
      ["website", "https://source-filter.widgets.example"],
      ["github", "https://github.com/bright-tools/source-filter"],
    ] as const) {
      const project = await repository.createProject(actor, {
        name: `Postgres ${sourceType} claim filter`, sourceType, url,
        idempotencyKey: `postgres-source-filter-project-${sourceType}`,
        inputHash: `postgres-source-filter-project-${sourceType}`,
      });
      const run = await repository.enqueueAnalysis(actor, {
        projectId: project.id,
        idempotencyKey: `postgres-source-filter-analysis-${sourceType}`,
        inputHash: `postgres-source-filter-analysis-${sourceType}`,
      });
      runs.set(sourceType, run.id);
    }
    const github = await repository.claimAnalysis("postgres-github-only-worker", 60_000, ["github"]);
    assert.equal(github?.id, runs.get("github"));
    assert.equal(github?.sourceType, "github");
    await repository.failAnalysis("postgres-github-only-worker", github!.id, "EXPECTED_TEST_CLEANUP", false,
      github!.leaseGeneration);
    const website = await repository.claimAnalysis("postgres-website-only-worker", 60_000, ["website"]);
    assert.equal(website?.id, runs.get("website"));
    assert.equal(website?.sourceType, "website");
    await repository.failAnalysis("postgres-website-only-worker", website!.id, "EXPECTED_TEST_CLEANUP", false,
      website!.leaseGeneration);
  } finally {
    await repository.close();
  }
});

test("Postgres analysis enqueue atomically pins the attested source and preserves accepted replay", {
  skip: !connectionString || !adminConnectionString,
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  let adminTransaction = false;
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
  };
  try {
    const project = await repository.createProject(actor, {
      name: "Postgres source-pinned website",
      sourceType: "website",
      url: "https://postgres-source-pinned.example/app",
      sourceConfiguration: { kind: "website" },
      idempotencyKey: "postgres-source-pinned-project",
      inputHash: "postgres-source-pinned-project",
    });
    const [source] = await repository.listProjectSources(actor, project.id);
    const [snapshot] = await repository.listSourceSnapshots(actor, project.id);
    const request = {
      projectId: project.id,
      idempotencyKey: "postgres-source-pinned-analysis",
      inputHash: "postgres-source-pinned-analysis",
    };
    assert.equal(await repository.getAnalysisReplay(actor, request), undefined);
    await assert.rejects(repository.enqueueAnalysis(actor, {
      ...request,
      expectedSource: {
        projectSourceId: source!.id,
        sourceSnapshotId: snapshot!.id,
        sourceIdentityHash: "0".repeat(64),
      },
    }), (error: unknown) => error instanceof RepositoryError && error.code === "SOURCE_SNAPSHOT_STALE");
    assert.equal(await repository.getLatestAnalysis(actor, project.id), undefined);

    const replacementUrl = "https://postgres-source-pinned.example/changed";
    const replacementConfiguration = { kind: "website" } as const;
    await admin.query("begin");
    adminTransaction = true;
    await admin.query("update public.project_sources set active = false where id = $1", [source!.id]);
    const replacement = await admin.query(
      "insert into public.project_sources " +
      "(organization_id, project_id, source_type, source_url, source_configuration, version, active) " +
      "values ($1, $2, 'website', $3, $4::jsonb, 2, true) returning id",
      [actor.organizationId, project.id, replacementUrl, JSON.stringify(replacementConfiguration)],
    );
    await admin.query(
      "insert into public.source_snapshots " +
      "(organization_id, project_id, project_source_id, source_identity_hash, is_fixture) " +
      "values ($1, $2, $3, $4, false)",
      [actor.organizationId, project.id, replacement.rows[0].id,
        computeSourceIdentityHash("website", replacementUrl, replacementConfiguration)],
    );
    const racingEnqueue = repository.enqueueAnalysis(actor, {
      ...request,
      expectedSource: {
        projectSourceId: source!.id,
        sourceSnapshotId: snapshot!.id,
        sourceIdentityHash: snapshot!.sourceIdentityHash,
      },
    }).then(
      (value) => ({ state: "resolved" as const, value }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    );
    assert.deepEqual(await Promise.race([
      racingEnqueue,
      delay(50).then(() => ({ state: "blocked" as const })),
    ]), { state: "blocked" }, "enqueue must serialize behind an in-flight active-source replacement");
    await admin.query("commit");
    adminTransaction = false;
    const raceOutcome = await racingEnqueue;
    assert.equal(raceOutcome.state, "rejected");
    if (raceOutcome.state === "rejected") {
      assert.ok(raceOutcome.error instanceof RepositoryError);
      assert.equal(raceOutcome.error.code, "SOURCE_SNAPSHOT_STALE");
    }
    assert.equal(await repository.getLatestAnalysis(actor, project.id), undefined);

    const activeSource = (await repository.listProjectSources(actor, project.id)).find(({ active }) => active)!;
    const activeSnapshot = (await repository.listSourceSnapshots(actor, project.id))
      .find(({ projectSourceId }) => projectSourceId === activeSource.id)!;
    const accepted = await repository.enqueueAnalysis(actor, {
      ...request,
      expectedSource: {
        projectSourceId: activeSource.id,
        sourceSnapshotId: activeSnapshot.id,
        sourceIdentityHash: activeSnapshot.sourceIdentityHash,
      },
    });
    assert.equal((await repository.getAnalysisReplay(actor, request))?.id, accepted.id);
    await assert.rejects(repository.getAnalysisReplay(actor, {
      ...request,
      inputHash: "different-input",
    }), (error: unknown) => error instanceof RepositoryError && error.code === "IDEMPOTENCY_CONFLICT");
    await repository.cancelWorkflow(actor, {
      runId: accepted.id,
      idempotencyKey: "postgres-source-pinned-cleanup",
      inputHash: "postgres-source-pinned-cleanup",
    });
  } finally {
    if (adminTransaction) await admin.query("rollback");
    await admin.end();
    await repository.close();
  }
});

test("Postgres source replacement cannot commit after analysis locks an attested source", {
  skip: !connectionString || !adminConnectionString,
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 3 });
  const queueLock = await admin.connect();
  const replacement = await admin.connect();
  let queueLockTransaction = false;
  let replacementTransaction = false;
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
  };
  try {
    const project = await repository.createProject(actor, {
      name: "Postgres commit-ordered source",
      sourceType: "website",
      url: "https://postgres-commit-ordered.example/app",
      sourceConfiguration: { kind: "website" },
      idempotencyKey: "postgres-commit-ordered-project",
      inputHash: "postgres-commit-ordered-project",
    });
    const [source] = await repository.listProjectSources(actor, project.id);
    const [snapshot] = await repository.listSourceSnapshots(actor, project.id);

    await queueLock.query("begin");
    queueLockTransaction = true;
    await queueLock.query("lock table private.analysis_jobs in access exclusive mode");
    const enqueue = repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-commit-ordered-analysis",
      inputHash: "postgres-commit-ordered-analysis",
      expectedSource: {
        projectSourceId: source!.id,
        sourceSnapshotId: snapshot!.id,
        sourceIdentityHash: snapshot!.sourceIdentityHash,
      },
    });

    let enqueueReachedQueueWrite = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await admin.query(
        "select 1 from pg_stat_activity " +
        "where query like 'insert into private.analysis_jobs%' and wait_event_type = 'Lock' limit 1",
      );
      if (waiting.rows[0]) {
        enqueueReachedQueueWrite = true;
        break;
      }
      await delay(10);
    }
    assert.equal(enqueueReachedQueueWrite, true, "enqueue did not reach its post-source-lock queue write");

    const replacementUrl = "https://postgres-commit-ordered.example/replaced";
    const replacementConfiguration = { kind: "website" } as const;
    const replace = (async () => {
      await replacement.query("begin");
      replacementTransaction = true;
      await replacement.query("update public.project_sources set active = false where id = $1", [source!.id]);
      const inserted = await replacement.query(
        "insert into public.project_sources " +
        "(organization_id, project_id, source_type, source_url, source_configuration, version, active) " +
        "values ($1, $2, 'website', $3, $4::jsonb, 2, true) returning id",
        [actor.organizationId, project.id, replacementUrl, JSON.stringify(replacementConfiguration)],
      );
      await replacement.query(
        "insert into public.source_snapshots " +
        "(organization_id, project_id, project_source_id, source_identity_hash, is_fixture) " +
        "values ($1, $2, $3, $4, false)",
        [actor.organizationId, project.id, inserted.rows[0].id,
          computeSourceIdentityHash("website", replacementUrl, replacementConfiguration)],
      );
      await replacement.query("commit");
      replacementTransaction = false;
      return "replaced" as const;
    })();
    assert.equal(await Promise.race([replace, delay(50).then(() => "blocked" as const)]), "blocked");

    await queueLock.query("commit");
    queueLockTransaction = false;
    const accepted = await enqueue;
    assert.equal(await replace, "replaced");
    const claimed = await repository.claimAnalysis("postgres-commit-ordered-worker", 60_000, ["website"]);
    assert.equal(claimed?.id, accepted.id);
    assert.equal(claimed?.sourceUrl, "https://postgres-commit-ordered.example/app");
    assert.deepEqual(claimed?.sourceConfiguration, { kind: "website" });
    await repository.failAnalysis(
      "postgres-commit-ordered-worker",
      accepted.id,
      "EXPECTED_TEST_CLEANUP",
      false,
      claimed!.leaseGeneration,
    );
  } finally {
    if (replacementTransaction) await replacement.query("rollback");
    if (queueLockTransaction) await queueLock.query("rollback");
    replacement.release();
    queueLock.release();
    await admin.end();
    await repository.close();
  }
});

test("Postgres repository persists and recovers the fixture lifecycle", {
  skip: !connectionString || !adminConnectionString,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const role = await pool.query(
    "select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = current_user"
  );
  assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, rolinherit: false });
  await assert.rejects(pool.query("select * from public.projects"), (error: unknown) =>
    error instanceof pg.DatabaseError && error.code === "42501");
  await pool.end();

  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
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
      capabilities: capabilities("find_order", "create_support_ticket"),
      diagnostics: [{ code: "SERVER_ADAPTER_REQUIRED", operationKey: "GET /private", reason: "api_key_header" }],
      evidence: evidenceFor(plans("find_order", "create_support_ticket")),
      release: releaseCandidate("export const persisted = true;", plans("find_order", "create_support_ticket")),
      providerProvenance: {
        mode: "local", adapter: "local-fixture", adapterVersion: 1, fixture: true,
      },
    });
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.leaseOwner, undefined);
    assert.equal(completed.leaseExpiresAt, undefined);
    assert.deepEqual(completed.providerProvenance, {
      mode: "local", adapter: "local-fixture", adapterVersion: 1, fixture: true,
    });
    assert.equal((await repository.getAnalysis(actor, run.id)).status, "succeeded");
    assert.equal((await repository.listCapabilities(actor, project.id)).length, 2);
    assert.deepEqual((await repository.getAnalysisResult(actor, run.id))?.diagnostics, [{
      code: "SERVER_ADAPTER_REQUIRED",
      operationKey: "GET /private",
      reason: "api_key_header"
    }]);

    const mutation = (await repository.listAnalysisCapabilities(actor, run.id))
      .find(({ stableName }) => stableName === "create_support_ticket")!;
    await repository.reviewCapability(actor, mutation.id, {
      action: "approve",
      expectedVersion: mutation.version,
    });
    const capabilityDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, run.id));
    const verificationInput = {
      analysisRunId: run.id,
      capabilityStateDigest: capabilityDigest,
      candidate: releaseCandidate("export const persisted = true;", plans("find_order", "create_support_ticket")),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    };
    const verification = await saveVerification(repository, actor, project.id, verificationInput);
    const publishInput = {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: capabilityDigest,
      candidateContentHash: verification.candidateContentHash,
      verificationRunId: verification.id,
      ...hostedArtifactIdentity(verification.candidateContentHash),
      idempotencyKey: "postgres-publish",
      inputHash: "publish-input"
    } as const;
    await assert.rejects(repository.publishRelease(actor, {
      ...publishInput,
      verificationRunId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "postgres-publish-wrong-verification",
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CANDIDATE_CHANGED"));
    const [release, concurrentRelease] = await Promise.all([
      repository.publishRelease(actor, publishInput),
      repository.publishRelease(actor, {
        ...publishInput,
        idempotencyKey: "postgres-publish-concurrent",
      }),
    ]);
    assert.equal(concurrentRelease.id, release.id);
    assert.equal(release.capabilityStateDigest, capabilityDigest);
    assert.equal(release.verificationRunId, verification.id);
    assert.deepEqual({
      artifactUrl: release.artifactUrl,
      downloadUrl: release.downloadUrl,
      localOnly: release.localOnly,
    }, hostedArtifactIdentity(release.contentHash));
    const storedReleaseIdentity = await repository.getRelease(actor, project.id, release.id);
    assert.deepEqual({
      artifactUrl: storedReleaseIdentity.artifactUrl,
      downloadUrl: storedReleaseIdentity.downloadUrl,
      localOnly: storedReleaseIdentity.localOnly,
    }, {
      artifactUrl: release.artifactUrl,
      downloadUrl: release.downloadUrl,
      localOnly: false,
    });
    assert.ok(release.artifactUrl);
    const installationInput = {
      releaseId: release.id,
      pageUrl: "https://acme.example/account",
      artifactUrl: release.artifactUrl,
      downloadUrl: release.downloadUrl!,
      localOnly: false,
      targetOrigin: release.allowedOrigin,
      artifactContentHash: release.contentHash,
      integrity: release.sri,
      expectedTools: ["create_support_ticket", "find_order"],
      status: "verified" as const,
      delivery: "hosted" as const,
      csp: { hosted: "allowed" as const },
      webMcpImplementation: "native" as const,
      verifierIdentity: {
        protocolVersion: 1 as const,
        mode: "hermetic" as const,
        webMcpImplementation: "native" as const,
        verifierOriginDigest: "b".repeat(64),
      },
      attestation: {
        observedArtifactUrl: release.artifactUrl,
        observedDownloadUrl: release.downloadUrl!,
        observedLocalOnly: false,
        observedIntegrity: release.sri,
        executedArtifactUrl: release.artifactUrl,
        servedContentHash: release.contentHash,
        executedContentHash: release.contentHash,
        observedTargetOrigin: release.allowedOrigin,
        registeredTools: ["create_support_ticket", "find_order"],
        webMcpImplementation: "native" as const,
        normalPageLoad: true,
        routeInterception: false,
        injectedRegistration: false,
        syntheticHarness: false,
        duplicateLoadHarmless: true,
        executionEvidence: {
          authenticatedRead: { toolName: "find_order", authenticated: true as const, succeeded: true as const },
          confirmedReversibleMutation: {
            toolName: "create_support_ticket", confirmation: "explicit" as const,
            reversible: true as const, succeeded: true as const, effectCount: 1 as const,
          },
          authoritativeFinalState: {
            mutationToolName: "create_support_ticket", source: "target" as const, verified: true as const,
          },
        },
        csp: { hosted: "allowed" as const },
      },
      idempotencyKey: "postgres-installation",
      inputHash: "c".repeat(64),
    };
    const pendingInstallationInput = {
      ...installationInput,
      status: "pending_self_host" as const,
      csp: { hosted: "blocked" as const },
      attestation: {
        ...installationInput.attestation,
        executedArtifactUrl: null,
        executedContentHash: null,
        registeredTools: [],
        duplicateLoadHarmless: null,
        executionEvidence: null,
        csp: { hosted: "blocked" as const },
      },
      idempotencyKey: "postgres-installation-pending",
      inputHash: "f".repeat(64),
    };
    const pendingInstallation = await repository.saveReleaseInstallation(
      actor, project.id, pendingInstallationInput,
    );
    assert.equal((await repository.saveReleaseInstallation(
      actor, project.id, pendingInstallationInput,
    )).id, pendingInstallation.id);
    const installation = await repository.saveReleaseInstallation(actor, project.id, installationInput);
    assert.equal(installation.artifactUrl, release.artifactUrl);
    assert.notEqual(installation.id, pendingInstallation.id);
    assert.equal(
      (await repository.getLatestReleaseInstallation(actor, project.id, release.id))?.id,
      installation.id,
    );
    await assert.rejects(repository.saveReleaseInstallation(actor, project.id, {
      ...installationInput,
      artifactUrl: `https://unrelated.example/${release.contentHash}.js`,
      idempotencyKey: "postgres-installation-unrelated",
      inputHash: "d".repeat(64),
    }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
    await assert.rejects(repository.saveReleaseInstallation(actor, project.id, {
      ...installationInput,
      csp: { hosted: "blocked" },
      idempotencyKey: "postgres-installation-contradictory-csp",
      inputHash: "e".repeat(64),
    }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
    assert.equal((await saveVerification(repository, actor, project.id, verificationInput)).id, verification.id);
    await assert.rejects(saveVerification(repository, actor, project.id, {
      ...verificationInput,
      candidate: releaseCandidate(
        "export const changedAfterPublish = true;",
        plans("find_order", "create_support_ticket"),
      )
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
      capabilities: capabilities("find_order"),
      diagnostics: [],
      evidence: evidenceFor(plans("find_order")),
      release: releaseCandidate("export const persisted = true;")
    });
    const secondDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, secondRun.id));
    const secondVerification = await saveVerification(repository, actor, project.id, {
      analysisRunId: secondRun.id,
      capabilityStateDigest: secondDigest,
      candidate: releaseCandidate("export const persisted = true;"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    });
    const secondRelease = await repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: secondRun.id,
      capabilityStateDigest: secondDigest,
      candidateContentHash: secondVerification.candidateContentHash,
      verificationRunId: secondVerification.id,
      ...hostedArtifactIdentity(secondVerification.candidateContentHash),
      idempotencyKey: "postgres-publish-two",
      inputHash: "publish-input-two"
    });
    assert.equal(secondRelease.capabilityStateDigest, secondDigest);
    assert.notEqual(secondRelease.id, release.id);
    assert.equal(secondRelease.contentHash, release.contentHash);
    assert.notEqual(secondRelease.analysisRunId, release.analysisRunId);
    const latestPublished = await repository.getLatestPublishedRelease(actor, project.id);
    assert.equal(latestPublished?.release.id, secondRelease.id);
    assert.equal(latestPublished?.verification.analysisRunId, secondRelease.analysisRunId);
    assert.equal(latestPublished?.verification.capabilityStateDigest, secondRelease.capabilityStateDigest);
    assert.equal(latestPublished?.verification.candidateContentHash, secondRelease.contentHash);

    const diagnosticRun = await repository.enqueueAnalysis(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-analysis-diagnostic-only",
      inputHash: "analysis-input-diagnostic-only"
    });
    assert.equal((await repository.claimAnalysis("postgres-worker-diagnostic-only", 60_000))?.id, diagnosticRun.id);
    const diagnosticContent = JSON.stringify({ adapter: "bounded-openapi", sourceDigest: "urn:sha256:source" });
    const diagnosticReference = `urn:sha256:${createHash("sha256").update(diagnosticContent).digest("hex")}`;
    await repository.completeAnalysis("postgres-worker-diagnostic-only", diagnosticRun.id, {
      capabilities: [],
      diagnostics: [{ code: "SERVER_ADAPTER_REQUIRED", operationKey: "GET /private", reason: "api_key_header" }],
      evidence: [{ source: "openapi", content: diagnosticContent, reference: diagnosticReference }]
    });
    const diagnosticResult = await repository.getAnalysisResult(actor, diagnosticRun.id);
    assert.deepEqual(diagnosticResult?.capabilities, []);
    assert.deepEqual(diagnosticResult?.diagnostics, [{
      code: "SERVER_ADAPTER_REQUIRED",
      operationKey: "GET /private",
      reason: "api_key_header"
    }]);
    assert.equal(diagnosticResult?.release, undefined);

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
    await assert.rejects(repository.getLatestPublishedRelease(outsider, project.id), (error: unknown) =>
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

    await admin.query(
      "update public.analysis_runs set provider_mode = 'website', provider_adapter = 'browser-use-v4', " +
      "provider_adapter_version = 4, provider_fixture = false where id = $1",
      [run.id],
    );
    await admin.query(
      "update public.verification_runs set verification_mode = 'live' where id = $1",
      [verification.id],
    );
    await admin.query(
      `insert into public.release_installations (
        id, organization_id, project_id, release_id, actor_id, page_url, artifact_url, self_hosted_url,
        target_origin, artifact_content_hash, integrity, expected_tools, status, delivery, csp_status, csp_directive,
        webmcp_implementation, attestation, idempotency_key, input_hash, download_url, local_only, verification_mode,
        verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation, observed_artifact_url,
        observed_download_url, observed_local_only, observed_integrity, observed_target_origin, registered_tools,
        executed_artifact_url, served_content_hash, executed_content_hash, normal_page_load, route_interception,
        injected_registration, synthetic_harness, duplicate_load_harmless, authenticated_read_tool_name,
        authenticated_read_authenticated, authenticated_read_succeeded, confirmed_mutation_tool_name,
        confirmed_mutation_confirmation, confirmed_mutation_reversible, confirmed_mutation_succeeded,
        confirmed_mutation_effect_count, final_state_mutation_tool_name, final_state_source, final_state_verified,
        verified_at
      )
      select
        splice.id, installation.organization_id, installation.project_id, installation.release_id,
        installation.actor_id, installation.page_url, installation.artifact_url, installation.self_hosted_url,
        installation.target_origin, installation.artifact_content_hash, installation.integrity,
        installation.expected_tools, installation.status, installation.delivery, installation.csp_status,
        installation.csp_directive, installation.webmcp_implementation, installation.attestation,
        splice.idempotency_key, installation.input_hash, installation.download_url, installation.local_only, 'live',
        installation.verifier_protocol_version, installation.verifier_origin_digest,
        installation.verifier_webmcp_implementation, installation.observed_artifact_url,
        installation.observed_download_url, installation.observed_local_only, installation.observed_integrity,
        installation.observed_target_origin, installation.registered_tools, installation.executed_artifact_url,
        installation.served_content_hash, installation.executed_content_hash, installation.normal_page_load,
        splice.route_interception, installation.injected_registration, installation.synthetic_harness,
        installation.duplicate_load_harmless, splice.read_tool, true, true, splice.mutation_tool, 'explicit', true,
        true, 1, splice.mutation_tool, 'target', true, splice.verified_at
      from public.release_installations installation
      cross join (values
        ('77777777-7777-4777-8777-777777777771'::uuid, 'postgres-installation-splice-normal',
          '2026-08-31T20:00:00.000Z'::timestamptz, false, 'unrelated_read', 'unrelated_mutation'),
        ('77777777-7777-4777-8777-777777777772'::uuid, 'postgres-installation-splice-execution',
          '2026-08-31T20:01:00.000Z'::timestamptz, true, 'find_order', 'create_support_ticket')
      ) as splice(id, idempotency_key, verified_at, route_interception, read_tool, mutation_tool)
      where installation.id = $1`,
      [installation.id],
    );
    const antiSplice = await admin.query(
      "select count(*)::integer as count from private.selected_native_installation_proof($1)",
      [release.contentHash],
    );
    assert.equal(antiSplice.rows[0]?.count, 0,
      "normal-load and execution facts from different installation rows must not compose a live proof");
  } finally {
    await repository.close();
    await admin.end();
  }
});

test("Postgres phased workflow matches in-memory transitions, lease generations, waits, and cancellation", {
  skip: !connectionString || !adminConnectionString,
}, async () => {
  const repository = createPostgresRepository({ connectionString: connectionString!, maxConnections: 4 });
  const direct = new pg.Pool({ connectionString: connectionString!, max: 2 });
  const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
  };
  try {
    const project = await repository.createProject(actor, {
      name: "Postgres phased workflow",
      sourceType: "openapi",
      url: "https://workflow.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://workflow.widgets.example", testPageUrl: "https://workflow.widgets.example/", environment: "test" },
      idempotencyKey: "postgres-workflow-project",
      inputHash: "postgres-workflow-project",
    });
    assert.equal((await repository.listProjectSources(actor, project.id)).length, 1);
    assert.equal((await repository.listSourceSnapshots(actor, project.id)).length, 1);
    const run = await repository.startWorkflow(actor, {
      projectId: project.id,
      idempotencyKey: "postgres-workflow-run",
      inputHash: "postgres-workflow-run",
    });
    assert.deepEqual((await repository.listWorkflowEvents(actor, run.id)).map(({ sequence, type }) => ({ sequence, type })), [
      { sequence: 1, type: "workflow.created" },
      { sequence: 2, type: "task.created" },
    ]);
    const directScopedWrite = async (
      role: "page2webmcp_app" | "page2webmcp_worker",
      sql: string,
      parameters: unknown[],
    ) => {
      const client = await direct.connect();
      try {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        if (role === "page2webmcp_app") {
          await client.query(
            "select set_config('page2webmcp.organization_id', $1, true), " +
            "set_config('page2webmcp.actor_id', $2, true), set_config('page2webmcp.access', 'member', true)",
            [actor.organizationId, actor.id],
          );
        }
        await client.query(sql, parameters);
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
    };
    const invalidWrites = await Promise.allSettled(
      (["page2webmcp_app", "page2webmcp_worker"] as const).flatMap((role) => [
        directScopedWrite(role, "update public.workflow_runs set current_phase = 'publish' where id = $1", [run.id]),
        directScopedWrite(
          role,
          "insert into private.workflow_tasks " +
          "(organization_id, project_id, workflow_run_id, phase, status, idempotency_key, input_hash) " +
          "values ($1, $2, $3, 'publish', 'queued', $4, $5)",
          [actor.organizationId, project.id, run.id, `wft_${"e".repeat(64)}`, "e".repeat(64)],
        ),
      ]),
    );
    for (const outcome of invalidWrites) {
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof pg.DatabaseError);
        assert.equal(outcome.reason.code, "23514");
      }
    }
    const initialProject = await repository.createProject(actor, {
      name: "Postgres illegal initial state",
      sourceType: "openapi",
      url: "https://initial-state.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://initial-state.widgets.example", testPageUrl: "https://initial-state.widgets.example/", environment: "test" },
      idempotencyKey: "postgres-initial-state-project",
      inputHash: "postgres-initial-state-project",
    });
    const [initialSnapshot] = await repository.listSourceSnapshots(actor, initialProject.id);
    assert.ok(initialSnapshot);
    const invalidInitialRuns: PromiseSettledResult<void>[] = [];
    for (const role of ["page2webmcp_app", "page2webmcp_worker"] as const) {
      for (const [status, version, nextSequence, cancelRequestedAt] of [
        ["running", 0, 1, null],
        ["queued", 1, 1, null],
        ["queued", 0, 2, null],
        ["queued", 0, 1, new Date()],
      ] as const) {
        const [outcome] = await Promise.allSettled([directScopedWrite(
          role,
          "insert into public.workflow_runs " +
          "(organization_id, project_id, source_snapshot_id, status, current_phase, input_hash, version, " +
          "next_event_sequence, cancel_requested_at) values ($1, $2, $3, $4, 'preflight', $5, $6, $7, $8)",
          [actor.organizationId, initialProject.id, initialSnapshot.id, status, "f".repeat(64),
            version, nextSequence, cancelRequestedAt],
        )]);
        invalidInitialRuns.push(outcome);
      }
    }
    for (const outcome of invalidInitialRuns) {
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof pg.DatabaseError);
        assert.equal(outcome.reason.code, "23514");
      }
    }

    const legacyProject = await repository.createProject(actor, {
      name: "Postgres illegal legacy task state",
      sourceType: "openapi",
      url: "https://legacy-state.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://legacy-state.widgets.example", testPageUrl: "https://legacy-state.widgets.example/", environment: "test" },
      idempotencyKey: "postgres-legacy-state-project",
      inputHash: "postgres-legacy-state-project",
    });
    const legacyAnalysis = await repository.enqueueAnalysis(actor, {
      projectId: legacyProject.id,
      idempotencyKey: "postgres-legacy-state-analysis",
      inputHash: "postgres-legacy-state-analysis",
    });
    const legacyWorkflow = await repository.getWorkflowRun(actor, legacyAnalysis.id);
    await admin.query("delete from private.workflow_tasks where workflow_run_id = $1", [legacyWorkflow.id]);
    const invalidLegacyTasks = await Promise.allSettled(
      (["page2webmcp_app", "page2webmcp_worker"] as const).map((role) => directScopedWrite(
        role,
        "insert into private.workflow_tasks " +
        "(organization_id, project_id, workflow_run_id, phase, status, idempotency_key, input_hash, " +
        "lease_generation, attempts) values ($1, $2, $3, 'analysis', 'succeeded', $4, $5, 3, 3)",
        [actor.organizationId, legacyProject.id, legacyWorkflow.id, `wft_${"9".repeat(64)}`, legacyWorkflow.inputHash],
      )),
    );
    for (const outcome of invalidLegacyTasks) {
      assert.equal(outcome.status, "rejected");
      if (outcome.status === "rejected") {
        assert.ok(outcome.reason instanceof pg.DatabaseError);
        assert.equal(outcome.reason.code, "23514");
      }
    }
    await repository.cancelWorkflow(actor, {
      runId: legacyWorkflow.id,
      idempotencyKey: "postgres-cancel-legacy-state",
      inputHash: "postgres-cancel-legacy-state",
    });
    const [left, right] = await Promise.all([
      repository.claimWorkflowTask("postgres-workflow-a"),
      repository.claimWorkflowTask("postgres-workflow-b"),
    ]);
    const claimed = left ?? right;
    assert.ok(claimed);
    assert.equal([left, right].filter(Boolean).length, 1);
    await repository.completeWorkflowTask(claimed.leaseOwner, claimed.id, claimed.leaseGeneration, {
      idempotencyKey: "postgres-complete-preflight",
      inputHash: "postgres-complete-preflight",
      outputReference: `urn:sha256:${"a".repeat(64)}`,
    });
    const ownership = await repository.claimWorkflowTask("postgres-workflow-owner");
    assert.equal(ownership?.phase, "ownership");
    assert.ok(ownership);
    const waiting = await repository.waitWorkflowTask(
      "postgres-workflow-owner", ownership.id, ownership.leaseGeneration, {
        idempotencyKey: "postgres-wait-owner",
        inputHash: "postgres-wait-owner",
        reason: "ownership_proof",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );
    assert.equal((await repository.getWorkflowRun(actor, run.id)).status, "waiting");
    const resumed = await Promise.all([
      repository.resumeWorkflowTask(actor, {
        runId: run.id,
        waitToken: waiting.waitToken,
        idempotencyKey: "postgres-resume-owner",
        inputHash: "postgres-resume-owner",
      }),
      repository.resumeWorkflowTask(actor, {
        runId: run.id,
        waitToken: waiting.waitToken,
        idempotencyKey: "postgres-resume-owner",
        inputHash: "postgres-resume-owner",
      }),
    ]);
    assert.equal(resumed[0].status, "queued");
    assert.equal(resumed[1].id, resumed[0].id);
    assert.equal((await repository.cancelWorkflow(actor, {
      runId: run.id,
      idempotencyKey: "postgres-cancel-workflow",
      inputHash: "postgres-cancel-workflow",
    })).status, "cancelled");

    const raceProject = await repository.createProject(actor, {
      name: "Postgres cancellation race",
      sourceType: "openapi",
      url: "https://race.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://race.widgets.example", testPageUrl: "https://race.widgets.example/", environment: "test" },
      idempotencyKey: "postgres-race-project",
      inputHash: "postgres-race-project",
    });
    const raceRun = await repository.startWorkflow(actor, {
      projectId: raceProject.id,
      idempotencyKey: "postgres-race-run",
      inputHash: "postgres-race-run",
    });
    const [claimOutcome, cancelOutcome] = await Promise.allSettled([
      repository.claimWorkflowTask("postgres-race-worker"),
      repository.cancelWorkflow(actor, {
        runId: raceRun.id,
        idempotencyKey: "postgres-race-cancel",
        inputHash: "postgres-race-cancel",
      }),
    ]);
    assert.equal(cancelOutcome.status, "fulfilled");
    assert.equal((await repository.getWorkflowRun(actor, raceRun.id)).status, "cancelled");
    if (claimOutcome.status === "fulfilled" && claimOutcome.value) {
      await assert.rejects(repository.completeWorkflowTask(
        "postgres-race-worker", claimOutcome.value.id, claimOutcome.value.leaseGeneration, {
          idempotencyKey: "postgres-race-complete-after-cancel",
          inputHash: "postgres-race-complete-after-cancel",
        },
      ), (error: unknown) => error instanceof RepositoryError && error.code === "CANCELLED");
    }

    const completionProject = await repository.createProject(actor, {
      name: "Postgres completion cancellation race",
      sourceType: "openapi",
      url: "https://complete-race.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://complete-race.widgets.example", testPageUrl: "https://complete-race.widgets.example/", environment: "test" },
      idempotencyKey: "postgres-complete-race-project",
      inputHash: "postgres-complete-race-project",
    });
    const completionRun = await repository.startWorkflow(actor, {
      projectId: completionProject.id,
      idempotencyKey: "postgres-complete-race-run",
      inputHash: "postgres-complete-race-run",
    });
    const completionTask = await repository.claimWorkflowTask("postgres-complete-race-worker");
    assert.ok(completionTask);
    const [completeOutcome, completionCancelOutcome] = await Promise.allSettled([
      repository.completeWorkflowTask(
        "postgres-complete-race-worker", completionTask.id, completionTask.leaseGeneration, {
          idempotencyKey: "postgres-complete-race-complete",
          inputHash: "postgres-complete-race-complete",
        },
      ),
      repository.cancelWorkflow(actor, {
        runId: completionRun.id,
        idempotencyKey: "postgres-complete-race-cancel",
        inputHash: "postgres-complete-race-cancel",
      }),
    ]);
    assert.equal(completionCancelOutcome.status, "fulfilled");
    if (completeOutcome.status === "rejected") {
      assert.ok(completeOutcome.reason instanceof RepositoryError);
      assert.equal(completeOutcome.reason.code, "CANCELLED");
    }
    assert.equal((await repository.getWorkflowRun(actor, completionRun.id)).status, "cancelled");

    const repairProject = await repository.createProject(actor, {
      name: "Postgres missing next repair",
      sourceType: "openapi",
      url: "https://repair.widgets.example/openapi.json",
      sourceConfiguration: { kind: "openapi", targetOrigin: "https://repair.widgets.example", testPageUrl: "https://repair.widgets.example/", environment: "test" },
      idempotencyKey: "postgres-repair-project",
      inputHash: "postgres-repair-project",
    });
    const repairRun = await repository.startWorkflow(actor, {
      projectId: repairProject.id,
      idempotencyKey: "postgres-repair-run",
      inputHash: "postgres-repair-run",
    });
    const repairClaim = await repository.claimWorkflowTask("postgres-repair-worker");
    assert.ok(repairClaim);
    const repairCompletion = await repository.completeWorkflowTask(
      "postgres-repair-worker", repairClaim.id, repairClaim.leaseGeneration, {
        idempotencyKey: "postgres-repair-complete",
        inputHash: "postgres-repair-complete",
      },
    );
    assert.equal(repairCompletion.nextTask?.phase, "ownership");
    await admin.query(
      "delete from private.workflow_tasks where workflow_run_id = $1 and phase = 'ownership'",
      [repairRun.id],
    );
    assert.equal(await repository.reconcileWorkflows("postgres-repair-reconciler"), 1);
    assert.equal(await repository.reconcileWorkflows("postgres-repair-reconciler"), 0);
    const repairedTasks = await repository.listWorkflowTasks(actor, repairRun.id);
    assert.deepEqual(repairedTasks.map(({ phase }) => phase), ["preflight", "ownership"]);
    assert.equal(repairedTasks[1]?.inputHash, repairCompletion.task.outputHash);
  } finally {
    await repository.close();
    await direct.end();
    await admin.end();
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
        "with expired_job as (" +
        "update private.analysis_jobs set lease_expires_at = now() - interval '1 second' " +
        "where analysis_run_id = $1 returning analysis_run_id, lease_expires_at) " +
        "update private.workflow_tasks task set lease_expires_at = expired_job.lease_expires_at " +
        "from expired_job where task.workflow_run_id = expired_job.analysis_run_id and task.phase = 'analysis'",
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
      capabilities: capabilities("create_support_ticket", "find_order"),
      diagnostics: [],
      evidence: evidenceFor(plans("create_support_ticket", "find_order")),
      release: releaseCandidate("export const stale = true;", plans("create_support_ticket", "find_order"))
    });
    const initialCapabilities = await repository.listAnalysisCapabilities(actor, publishRun.id);
    const capability = initialCapabilities.find((item) => item.stableName === "create_support_ticket");
    const blockedCapability = initialCapabilities.find((item) => item.stableName === "find_order");
    assert.ok(capability);
    assert.ok(blockedCapability);
    const staleDigest = capabilityStateDigest(initialCapabilities);
    const verification = await saveVerification(repository, actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: staleDigest,
      candidate: releaseCandidate("export const stale = true;", plans("create_support_ticket", "find_order")),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    });
    await repository.reviewCapability(actor, capability.id, { action: "block", expectedVersion: 1 });
    await assert.rejects(repository.publishRelease(actor, {
      projectId: publishProject.id,
      analysisRunId: publishRun.id,
      capabilityStateDigest: staleDigest,
      candidateContentHash: verification.candidateContentHash,
      verificationRunId: verification.id,
      ...hostedArtifactIdentity(verification.candidateContentHash),
      idempotencyKey: "stale-publish",
      inputHash: "stale-publish"
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CAPABILITIES_CHANGED"));

    const reviewedDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, publishRun.id));
    await assert.rejects(saveVerification(repository, actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidate: { ...releaseCandidate("export const mismatch = true;"), contentHash: "0".repeat(64) },
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CANDIDATE_HASH_MISMATCH"));

    const firstCandidate = await saveVerification(repository, actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidate: releaseCandidate("export const subset = 'first';"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    });
    const latestCandidate = await saveVerification(repository, actor, publishProject.id, {
      analysisRunId: publishRun.id,
      capabilityStateDigest: reviewedDigest,
      candidate: releaseCandidate("export const subset = 'latest';"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
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
      verificationRunId: latestCandidate.id,
      ...hostedArtifactIdentity(latestCandidate.candidateContentHash),
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
      verificationRunId: firstCandidate.id,
      ...hostedArtifactIdentity(firstCandidate.candidateContentHash),
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
      verificationRunId: latestCandidate.id,
      ...hostedArtifactIdentity(latestCandidate.candidateContentHash),
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
      capabilities: fixturePlans.map((plan) => ({ plan, status: "proposed" as const })),
      diagnostics: [],
      evidence: evidenceFor(fixturePlans),
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
    const subsetVerification = await saveVerification(repository, actor, project.id, {
      analysisRunId: run.id,
      capabilityStateDigest: blockedDigest,
      candidate: subset,
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    });

    assert.equal((await repository.getAnalysisResult(actor, run.id))?.release?.code, source.code);
    await repository.reviewCapability(actor, blocked.id, {
      action: "approve",
      expectedVersion: blocked.version
    });
    await assert.rejects(repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: blockedDigest,
      candidateContentHash: subsetVerification.candidateContentHash,
      verificationRunId: subsetVerification.id,
      ...hostedArtifactIdentity(subsetVerification.candidateContentHash),
      idempotencyKey: "immutable-source-publish",
      inputHash: "immutable-source-publish-stale"
    }), (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CAPABILITIES_CHANGED"));

    const approvedDigest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, run.id));
    const fullVerification = await saveVerification(repository, actor, project.id, {
      analysisRunId: run.id,
      capabilityStateDigest: approvedDigest,
      candidate: source,
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    });
    const release = await repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: approvedDigest,
      candidateContentHash: fullVerification.candidateContentHash,
      verificationRunId: fullVerification.id,
      ...hostedArtifactIdentity(fullVerification.candidateContentHash),
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
      capabilities: capabilities("find_order"),
      diagnostics: [],
      evidence: evidenceFor(plans("find_order")),
      release: releaseCandidate("export const retentionRace = true;")
    });
    const digest = capabilityStateDigest(await repository.listAnalysisCapabilities(actor, run.id));
    const verification = await saveVerification(repository, actor, project.id, {
      analysisRunId: run.id,
      capabilityStateDigest: digest,
      candidate: releaseCandidate("export const retentionRace = true;"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
      checks: passedVerificationChecks(),
      csp: { hosted: "allowed" as const },
      verificationMode: "hermetic" as const
    });

    await blocker.query("begin");
    blockerOpen = true;
    await blocker.query("lock table public.releases in access exclusive mode");
    publication = repository.publishRelease(actor, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: digest,
      candidateContentHash: verification.candidateContentHash,
      verificationRunId: verification.id,
      ...hostedArtifactIdentity(verification.candidateContentHash),
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
