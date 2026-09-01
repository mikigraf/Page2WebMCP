import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  acknowledgeWebsiteAuthenticationCompletion,
  advanceWebsiteCleanupResources,
  InMemoryControlPlaneRepository,
  RepositoryError,
  type ClaimedAnalysisRunRecord,
  type RepositoryActor,
} from "./control-plane.ts";

const owner: RepositoryActor = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role: "owner",
};
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const checkpointReference = `urn:sha256:${"a".repeat(64)}`;
const authenticationEvidenceReference = `urn:sha256:${"b".repeat(64)}`;
const targetOriginDigest = "57522ad7956a69fe9a8100d7088fe09afc3a63de516de9f548c69862a5ff64ec";

async function runningWebsite(repository: InMemoryControlPlaneRepository): Promise<Readonly<{
  projectId: string;
  runId: string;
  claim: ClaimedAnalysisRunRecord;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
}>> {
  const project = await repository.createProject(owner, {
    name: "Website receipt evidence",
    sourceType: "website",
    url: "https://widgets.example",
    idempotencyKey: "website-receipt-project",
    inputHash: "website-receipt-project",
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "website-receipt-analysis",
    inputHash: "website-receipt-analysis",
  });
  const sourceSnapshot = (await repository.listSourceSnapshots(owner, project.id))[0]!;
  const claim = await repository.claimAnalysis("suspending-worker-a", 60_000, ["website"]);
  assert.equal(claim?.id, run.id);
  return {
    projectId: project.id,
    runId: run.id,
    claim: claim!,
    sourceSnapshotId: sourceSnapshot.id,
    sourceIdentityHash: sourceSnapshot.sourceIdentityHash,
  };
}

test("durable wait stores secret-free suspension evidence and first resumed claim binds worker B", async () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const source = await runningWebsite(repository);
  const suspensionEvidence = {
    schemaVersion: 1 as const,
    ownershipDecisionDigest: "a".repeat(64),
    providerSessionIdentityDigest: "4".repeat(64),
    browserUse: {
      adapter: "browser-use-v4" as const,
      adapterVersion: 4 as const,
      apiVersion: "v4" as const,
      model: "browser-use-2.0" as const,
      policyDigest: "6".repeat(64),
    },
    browserLease: { identityDigest: "7".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    egressPolicy: { referenceDigest: "8".repeat(64), policyDigest: "5".repeat(64) },
    cdpReferenceDigest: "9".repeat(64),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    ttlSecrets: [
      { purpose: "browser_cdp_url" as const, referenceDigest: "9".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
      { purpose: "browser_live_url" as const, referenceDigest: "0".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    ],
    checkpoint: {
      checkpointReference,
      sourceSnapshotId: source.sourceSnapshotId,
      sourceIdentityHash: source.sourceIdentityHash,
      targetOriginDigest,
      expiresAt: "2026-09-01T12:09:00.000Z",
    },
    suspendedWorkerIdentityDigest: digest("suspending-worker-a"),
    suspendedLeaseGeneration: source.claim.leaseGeneration,
  };
  const waiting = await repository.waitAnalysisForAuthentication("suspending-worker-a", source.runId, {
    checkpointReference,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest,
    expiresAt: "2026-09-01T12:09:00.000Z",
    suspensionEvidence,
    idempotencyKey: "website-receipt-wait",
    inputHash: "website-receipt-wait",
  }, source.claim.leaseGeneration);

  assert.equal("suspensionEvidence" in waiting, false, "public checkpoint must not expose receipt evidence");
  assert.equal((await repository.getAnalysis(owner, source.runId)).leaseOwner, undefined);
  await repository.resumeAnalysisAfterAuthentication(owner, {
    runId: source.runId,
    checkpointReference,
    authenticationEvidenceReference,
    sourceSnapshotId: source.sourceSnapshotId,
    sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest,
    idempotencyKey: "website-receipt-resume",
    inputHash: "website-receipt-resume",
  });
  const resumed = await repository.claimAnalysis("resumed-worker-b", 60_000, ["website"]);
  assert.equal(resumed?.id, source.runId);
  assert.deepEqual(resumed?.authenticationCheckpoint?.liveReceiptEvidence, {
    ...suspensionEvidence,
    authenticationEvidenceReferenceDigest: digest(authenticationEvidenceReference),
    authenticationConsumedAt: now.toISOString(),
    resumedWorkerIdentityDigest: digest("resumed-worker-b"),
    resumeLeaseGeneration: resumed?.leaseGeneration,
    resumeClaimedAt: now.toISOString(),
    restartVerified: false,
    cleanupResources: [
      { resource: "authentication_handoff_checkpoint", identityDigest: digest(checkpointReference), disposition: "pending" },
      { resource: "browser_lease", identityDigest: "7".repeat(64), disposition: "pending" },
      { resource: "browser_session", identityDigest: "4".repeat(64), disposition: "pending" },
      { resource: "cdp_observation_lease", identityDigest: "9".repeat(64), disposition: "pending" },
      { resource: "egress_policy_proxy", identityDigest: "8".repeat(64), disposition: "pending" },
      { resource: "evidence_lease", identityDigest: digest(`urn:sha256:${"3".repeat(64)}`), disposition: "pending" },
      {
        resource: "ttl_secrets",
        identityDigest: digest(JSON.stringify([
          { purpose: "browser_cdp_url", referenceDigest: "9".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
          { purpose: "browser_live_url", referenceDigest: "0".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
        ])),
        disposition: "pending",
      },
    ],
  });
  const serialized = JSON.stringify(resumed?.authenticationCheckpoint?.liveReceiptEvidence);
  assert.doesNotMatch(serialized, /suspending-worker-a|resumed-worker-b|secretref:|https:\/\/|wss:\/\//);
  assert.doesNotMatch(serialized, new RegExp(authenticationEvidenceReference));
});

test("same worker resume is retained but cannot count as restart proof", async () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const source = await runningWebsite(repository);
  const evidence = {
    schemaVersion: 1 as const,
    ownershipDecisionDigest: "a".repeat(64),
    providerSessionIdentityDigest: "4".repeat(64),
    browserUse: { adapter: "browser-use-v4" as const, adapterVersion: 4 as const, apiVersion: "v4" as const,
      model: "browser-use-2.0" as const, policyDigest: "6".repeat(64) },
    browserLease: { identityDigest: "7".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    egressPolicy: { referenceDigest: "8".repeat(64), policyDigest: "5".repeat(64) },
    cdpReferenceDigest: "9".repeat(64),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    ttlSecrets: [
      { purpose: "browser_cdp_url" as const, referenceDigest: "9".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
      { purpose: "browser_live_url" as const, referenceDigest: "0".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    ],
    checkpoint: { checkpointReference, sourceSnapshotId: source.sourceSnapshotId,
      sourceIdentityHash: source.sourceIdentityHash, targetOriginDigest, expiresAt: "2026-09-01T12:09:00.000Z" },
    suspendedWorkerIdentityDigest: digest("suspending-worker-a"),
    suspendedLeaseGeneration: source.claim.leaseGeneration,
  };
  await repository.waitAnalysisForAuthentication("suspending-worker-a", source.runId, {
    checkpointReference, sourceSnapshotId: source.sourceSnapshotId, sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest, expiresAt: "2026-09-01T12:09:00.000Z", suspensionEvidence: evidence,
    idempotencyKey: "same-worker-wait", inputHash: "same-worker-wait",
  }, source.claim.leaseGeneration);
  await repository.resumeAnalysisAfterAuthentication(owner, {
    runId: source.runId, checkpointReference, authenticationEvidenceReference,
    sourceSnapshotId: source.sourceSnapshotId, sourceIdentityHash: source.sourceIdentityHash, targetOriginDigest,
    idempotencyKey: "same-worker-resume", inputHash: "same-worker-resume",
  });
  const resumed = await repository.claimAnalysis("suspending-worker-a", 60_000, ["website"]);
  assert.equal(resumed?.authenticationCheckpoint?.liveReceiptEvidence?.restartVerified, false);
  assert.equal(
    resumed?.authenticationCheckpoint?.liveReceiptEvidence?.resumedWorkerIdentityDigest,
    resumed?.authenticationCheckpoint?.liveReceiptEvidence?.suspendedWorkerIdentityDigest,
  );
});

test("restart proof is bound to the worker and lease generation that actually completes", () => {
  const claimedByWorkerB = {
    schemaVersion: 1 as const,
    ownershipDecisionDigest: "a".repeat(64),
    providerSessionIdentityDigest: "4".repeat(64),
    browserUse: { adapter: "browser-use-v4" as const, adapterVersion: 4 as const, apiVersion: "v4" as const,
      model: "browser-use-2.0" as const, policyDigest: "6".repeat(64) },
    browserLease: { identityDigest: "7".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    egressPolicy: { referenceDigest: "8".repeat(64), policyDigest: "5".repeat(64) },
    cdpReferenceDigest: "9".repeat(64),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    ttlSecrets: [
      { purpose: "browser_cdp_url" as const, referenceDigest: "9".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
      { purpose: "browser_live_url" as const, referenceDigest: "0".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    ],
    checkpoint: { checkpointReference, sourceSnapshotId: "snapshot", sourceIdentityHash: "1".repeat(64),
      targetOriginDigest, expiresAt: "2026-09-01T12:09:00.000Z" },
    suspendedWorkerIdentityDigest: digest("worker-a"),
    suspendedLeaseGeneration: 1,
    resumedWorkerIdentityDigest: digest("worker-b"),
    resumeLeaseGeneration: 2,
    resumeClaimedAt: "2026-09-01T12:01:00.000Z",
    restartVerified: false,
    cleanupResources: [
      "authentication_handoff_checkpoint", "browser_lease", "browser_session", "cdp_observation_lease",
      "egress_policy_proxy", "evidence_lease", "ttl_secrets",
    ].map((resource, index) => ({ resource, identityDigest: String(index + 1).repeat(64), disposition: "pending" })) as never,
  };

  const sameWorkerCompleted = acknowledgeWebsiteAuthenticationCompletion(
    claimedByWorkerB, "worker-a", 3, "2026-09-01T12:02:00.000Z",
  );
  assert.equal(sameWorkerCompleted.restartVerified, false);
  assert.equal(sameWorkerCompleted.completionWorkerIdentityDigest, digest("worker-a"));
  assert.equal(sameWorkerCompleted.completionLeaseGeneration, 3);

  const restartedWorkerCompleted = acknowledgeWebsiteAuthenticationCompletion(
    claimedByWorkerB, "worker-c", 4, "2026-09-01T12:03:00.000Z",
  );
  assert.equal(restartedWorkerCompleted.restartVerified, true);
  assert.equal(restartedWorkerCompleted.completionWorkerIdentityDigest, digest("worker-c"));
  assert.equal(restartedWorkerCompleted.completionLeaseGeneration, 4);
});

test("authentication result checkpoint survives lease loss without replaying result persistence", async () => {
  let now = new Date("2026-09-01T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const source = await runningWebsite(repository);
  const suspensionEvidence = {
    schemaVersion: 1 as const,
    ownershipDecisionDigest: "a".repeat(64),
    providerSessionIdentityDigest: "4".repeat(64),
    browserUse: { adapter: "browser-use-v4" as const, adapterVersion: 4 as const, apiVersion: "v4" as const,
      model: "browser-use-2.0" as const, policyDigest: "6".repeat(64) },
    browserLease: { identityDigest: "7".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    egressPolicy: { referenceDigest: "8".repeat(64), policyDigest: "5".repeat(64) },
    cdpReferenceDigest: "9".repeat(64),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    ttlSecrets: [
      { purpose: "browser_cdp_url" as const, referenceDigest: "9".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
      { purpose: "browser_live_url" as const, referenceDigest: "0".repeat(64), expiresAt: "2026-09-01T12:09:00.000Z" },
    ],
    checkpoint: { checkpointReference, sourceSnapshotId: source.sourceSnapshotId,
      sourceIdentityHash: source.sourceIdentityHash, targetOriginDigest, expiresAt: "2026-09-01T12:09:00.000Z" },
    suspendedWorkerIdentityDigest: digest("suspending-worker-a"),
    suspendedLeaseGeneration: source.claim.leaseGeneration,
  };
  await repository.waitAnalysisForAuthentication("suspending-worker-a", source.runId, {
    checkpointReference, sourceSnapshotId: source.sourceSnapshotId, sourceIdentityHash: source.sourceIdentityHash,
    targetOriginDigest, expiresAt: "2026-09-01T12:09:00.000Z", suspensionEvidence,
    idempotencyKey: "result-checkpoint-wait", inputHash: "result-checkpoint-wait",
  }, source.claim.leaseGeneration);
  await repository.resumeAnalysisAfterAuthentication(owner, {
    runId: source.runId, checkpointReference, authenticationEvidenceReference,
    sourceSnapshotId: source.sourceSnapshotId, sourceIdentityHash: source.sourceIdentityHash, targetOriginDigest,
    idempotencyKey: "result-checkpoint-resume", inputHash: "result-checkpoint-resume",
  });
  const workerB = await repository.claimAnalysis("worker-b", 1_000, ["website"]);
  assert.ok(workerB);
  const result = {
    capabilities: [],
    diagnostics: [{ code: "NO_SUPPORTED_OPERATIONS", operationKey: "website" }],
    evidence: [{ source: "runtime" as const, content: "{}",
      reference: "urn:sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" }],
  };
  await assert.rejects(repository.completeAnalysis("worker-b", source.runId, result, workerB.leaseGeneration),
    (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  const checkpoint = await repository.checkpointWebsiteAuthenticationResult(
    "worker-b", source.runId, result, workerB.leaseGeneration,
  );
  assert.match(JSON.stringify(checkpoint), /resultHash/);
  assert.doesNotMatch(JSON.stringify(checkpoint), /https?:|secretref:|worker-b/);
  assert.equal((await repository.getAnalysis(owner, source.runId)).status, "running");

  now = new Date("2026-09-01T12:00:01.001Z");
  const workerC = await repository.claimAnalysis("worker-c", 60_000, ["website"]);
  assert.ok(workerC?.authenticationCheckpoint?.resultCheckpoint);
  assert.equal(workerC?.authenticationCheckpoint?.resultCheckpoint?.resultHash, checkpoint.resultHash);
  const completed = await repository.completeCheckpointedWebsiteAuthenticationAnalysis(
    "worker-c", source.runId, checkpoint.resultHash, workerC!.leaseGeneration,
  );
  assert.equal(completed.status, "succeeded");
  assert.equal((await repository.listAnalysisCapabilities(owner, source.runId)).length, 0);
  assert.equal((await repository.getAnalysisResult(owner, source.runId))?.evidence.length, 1);
});

test("per-resource cleanup retries remain fail closed and successful items are immutable", () => {
  const pending = [
    "authentication_handoff_checkpoint", "browser_lease", "browser_session", "cdp_observation_lease",
    "egress_policy_proxy", "evidence_lease", "ttl_secrets",
  ].map((resource, index) => ({ resource, identityDigest: String(index + 1).repeat(64), disposition: "pending" })) as never;
  const first = advanceWebsiteCleanupResources(pending, [
    { resource: "browser_lease", identityDigest: "2".repeat(64), disposition: "released",
      timestamp: "2026-09-01T12:01:00.000Z" },
    { resource: "browser_session", identityDigest: "3".repeat(64), disposition: "failed",
      timestamp: "2026-09-01T12:01:00.000Z", errorCode: "PROVIDER_TIMEOUT" },
  ]);
  assert.equal(first.find(({ resource }) => resource === "browser_lease")?.disposition, "released");
  assert.equal(first.find(({ resource }) => resource === "browser_session")?.disposition, "failed");
  assert.equal(first.find(({ resource }) => resource === "ttl_secrets")?.disposition, "pending");
  const retried = advanceWebsiteCleanupResources(first, [{
    resource: "browser_session", identityDigest: "3".repeat(64), disposition: "destroyed",
    timestamp: "2026-09-01T12:02:00.000Z",
  }]);
  assert.equal(retried.find(({ resource }) => resource === "browser_session")?.disposition, "destroyed");
  assert.throws(() => advanceWebsiteCleanupResources(retried, [{
    resource: "browser_lease", identityDigest: "2".repeat(64), disposition: "reconciled",
    timestamp: "2026-09-01T12:03:00.000Z",
  }]), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
});
