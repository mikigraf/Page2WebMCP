import {
  AUTH_SIGNAL_MAX_AGE_MS,
  ALLOWED_AUTH_SIGNALS,
  HASH_REFERENCE,
  HEX64,
  IDENTIFIER,
} from "../constants.ts";
import { badRequest, conflict, forbidden, notFound, unavailable } from "../errors.ts";
import { colocated, type GatewayContext } from "../context.ts";
import { sha256Hex } from "../canonical.ts";
import { workerResponse, type WorkerEnvelope } from "../envelope.ts";
import {
  attestationFor,
  validCheckpointBinding,
  type AuthenticationSignal,
  type CheckpointRecord,
} from "../stores/checkpoints.ts";
import { cleanupResourceEvidence, type CleanupDisposition } from "./cleanup.ts";
import type { RouteResult } from "./types.ts";

type CheckpointIdentity = Readonly<{
  checkpointReference: string;
  organizationId: string;
  projectId: string;
  runId: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  expiresAt: string;
}>;

function checkpointIdentity(envelope: WorkerEnvelope): CheckpointIdentity {
  const payload = envelope.payload;
  const identity = {
    checkpointReference: payload.checkpointReference,
    organizationId: payload.organizationId,
    projectId: payload.projectId,
    runId: payload.runId,
    sourceSnapshotId: payload.sourceSnapshotId,
    sourceIdentityHash: payload.sourceIdentityHash,
    targetOriginDigest: payload.targetOriginDigest,
    expiresAt: payload.expiresAt,
  };
  if (typeof identity.checkpointReference !== "string" || !HASH_REFERENCE.test(identity.checkpointReference)
    || ![identity.organizationId, identity.projectId, identity.runId, identity.sourceSnapshotId]
      .every((value) => typeof value === "string" && IDENTIFIER.test(value))
    || ![identity.sourceIdentityHash, identity.targetOriginDigest]
      .every((value) => typeof value === "string" && HEX64.test(value))
    || typeof identity.expiresAt !== "string" || !Number.isFinite(Date.parse(identity.expiresAt))) {
    throw badRequest("GATEWAY_CHECKPOINT_REQUEST_INVALID");
  }
  return identity as CheckpointIdentity;
}

function boundRecord(context: GatewayContext, envelope: WorkerEnvelope, identity: CheckpointIdentity): CheckpointRecord {
  const record = context.checkpoints.find(identity.checkpointReference);
  if (!record) throw notFound("GATEWAY_CHECKPOINT_UNKNOWN");
  const attestation = record.attestation;
  if (attestation.organizationId !== envelope.ownership.organizationId
    || attestation.projectId !== envelope.ownership.projectId
    || attestation.runId !== envelope.ownership.runId
    || attestation.organizationId !== identity.organizationId
    || attestation.projectId !== identity.projectId
    || attestation.runId !== identity.runId) throw forbidden("GATEWAY_CHECKPOINT_OWNER_MISMATCH");
  if (record.terminal || Date.parse(attestation.expiresAt) <= context.clock().getTime()) {
    throw conflict("GATEWAY_CHECKPOINT_EXPIRED");
  }
  if (attestation.sourceSnapshotId !== identity.sourceSnapshotId
    || attestation.sourceIdentityHash !== identity.sourceIdentityHash
    || attestation.targetOriginDigest !== identity.targetOriginDigest
    || attestation.expiresAt !== identity.expiresAt) throw conflict("GATEWAY_CHECKPOINT_BINDING_MISMATCH");
  return record;
}

export function createCheckpoint(context: GatewayContext, envelope: WorkerEnvelope): RouteResult {
  const binding = envelope.payload.binding;
  if (!validCheckpointBinding(binding)) throw badRequest("GATEWAY_CHECKPOINT_REQUEST_INVALID");
  if (binding.organizationId !== envelope.ownership.organizationId
    || binding.projectId !== envelope.ownership.projectId
    || binding.runId !== envelope.ownership.runId) throw forbidden("GATEWAY_CHECKPOINT_OWNER_MISMATCH");
  const now = context.clock();
  if (Date.parse(binding.expiresAt) <= now.getTime()) throw conflict("GATEWAY_CHECKPOINT_EXPIRED");
  if (colocated(context, "browser-lease-store") && !context.leases.active(binding.leaseId, now)) {
    throw conflict("GATEWAY_CHECKPOINT_LEASE_UNAVAILABLE");
  }
  if (colocated(context, "ttl-secret-store") && context.secrets) {
    for (const reference of [binding.liveReference, binding.cdpReference]) {
      const described = context.secrets.describe(reference, now);
      if (!described || described.ownership.runId !== binding.runId) {
        throw conflict("GATEWAY_CHECKPOINT_SECRET_UNAVAILABLE");
      }
    }
  }
  if (colocated(context, "egress-policy-store") && !context.policies.live(binding.egressPolicyReference, now)) {
    throw conflict("GATEWAY_CHECKPOINT_POLICY_UNAVAILABLE");
  }
  if (colocated(context, "evidence-store") && !context.evidence.get({
    reference: binding.publicEvidenceReference,
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    analysisRunId: binding.runId,
  })) throw conflict("GATEWAY_CHECKPOINT_EVIDENCE_UNAVAILABLE");
  const attestation = context.checkpoints.create(binding);
  // The response carries the attestation only: never the provider session id,
  // never a live or CDP URL.
  return {
    status: 200,
    body: {
      gatewayProtocolVersion: envelope.gatewayProtocolVersion,
      idempotencyKey: envelope.idempotencyKey,
      ownership: envelope.ownership,
      attestation,
    },
  };
}

export function checkpointStatus(context: GatewayContext, envelope: WorkerEnvelope): RouteResult {
  const identity = checkpointIdentity(envelope);
  let record: CheckpointRecord | undefined;
  try { record = boundRecord(context, envelope, identity); } catch { record = undefined; }
  return { status: 200, body: workerResponse(envelope, { status: record ? "ready" : "missing" }) };
}

function validAuthenticationSignal(
  signal: AuthenticationSignal | undefined,
  targetOrigin: string | undefined,
  expiresAt: string,
  now: Date,
): AuthenticationSignal | undefined {
  if (!signal || !targetOrigin || signal.authenticatedOrigin !== targetOrigin) return undefined;
  const observed = Date.parse(signal.observedAt);
  if (!Number.isFinite(observed) || observed < now.getTime() - AUTH_SIGNAL_MAX_AGE_MS
    || observed > Date.parse(expiresAt)) return undefined;
  if (!Array.isArray(signal.signals) || signal.signals.length < 1 || signal.signals.length > 3
    || signal.signals.some((name) => !ALLOWED_AUTH_SIGNALS.has(name))) return undefined;
  return { authenticatedOrigin: targetOrigin, observedAt: signal.observedAt, signals: [...signal.signals] };
}

export function resumeCheckpoint(context: GatewayContext, envelope: WorkerEnvelope): RouteResult {
  const identity = checkpointIdentity(envelope);
  const record = boundRecord(context, envelope, identity);
  const now = context.clock();
  const authentication = validAuthenticationSignal(
    record.authentication, record.targetOrigin, record.attestation.expiresAt, now,
  );
  if (!authentication) throw conflict("GATEWAY_CHECKPOINT_AUTHENTICATION_UNVERIFIED");
  if (colocated(context, "ttl-secret-store") && context.secrets
    && !context.secrets.describe(record.attestation.cdpReference, now)) {
    throw conflict("GATEWAY_CHECKPOINT_SECRET_EXPIRED");
  }
  if (colocated(context, "browser-lease-store") && !context.leases.active(record.attestation.leaseId, now)) {
    throw conflict("GATEWAY_CHECKPOINT_LEASE_EXPIRED");
  }
  if (!context.checkpoints.claimResume(record)) throw conflict("GATEWAY_CHECKPOINT_ALREADY_RESUMED");
  return {
    status: 200,
    body: workerResponse(envelope, {
      resumed: true,
      cdpReference: record.attestation.cdpReference,
      publicEvidenceReference: record.attestation.publicEvidenceReference,
      suspensionAttestation: record.attestation,
      authentication,
    }),
  };
}

async function disposeCheckpoint(
  context: GatewayContext,
  record: CheckpointRecord,
): Promise<ReturnType<typeof cleanupResourceEvidence>> {
  const attestation = record.attestation;
  const timestamp = context.clock().toISOString();
  const proven = (done: boolean, disposition: CleanupDisposition["disposition"], errorCode: string): CleanupDisposition =>
    (done ? { disposition } : { disposition: "failed", errorCode });

  const secretsDestroyed = colocated(context, "ttl-secret-store") && context.secrets
    ? [attestation.cdpReference, attestation.liveReference]
      .map((reference) => context.secrets!.revoke(reference)).every(Boolean)
      || [attestation.cdpReference, attestation.liveReference]
        .every((reference) => context.secrets!.describe(reference, context.clock()) === undefined)
    : false;
  const leaseReleased = colocated(context, "browser-lease-store")
    ? context.leases.release(attestation.leaseId, context.clock())
      || context.leases.active(attestation.leaseId, context.clock()) === undefined
    : false;
  context.enforcer.revoke(attestation.egressPolicyReference);
  const policyRevoked = colocated(context, "egress-policy-store")
    ? context.policies.revoke(attestation.egressPolicyReference)
      || context.policies.live(attestation.egressPolicyReference, context.clock()) === undefined
    : true;
  let sessionTerminated = false;
  let sessionError = "BROWSER_SESSION_TERMINATION_UNPROVEN";
  if (context.browserUseUpstream && colocated(context, "browser-use-v4")) {
    try {
      await context.browserUseUpstream.stopSession(record.providerSessionId, "cancelled");
    } catch { sessionError = "BROWSER_SESSION_STOP_FAILED"; }
    try {
      const reconciled = await context.browserUseUpstream.reconcileSession(record.providerSessionId);
      sessionTerminated = reconciled?.terminated === true;
    } catch { sessionError = "BROWSER_SESSION_RECONCILE_FAILED"; }
  }
  const cleanupResources = cleanupResourceEvidence(attestation, {
    checkpoint: { disposition: "destroyed" },
    browserLease: proven(leaseReleased, "released", "BROWSER_LEASE_RELEASE_UNPROVEN"),
    browserSession: proven(sessionTerminated, "destroyed", sessionError),
    cdpObservationLease: proven(secretsDestroyed, "released", "CDP_OBSERVATION_RELEASE_UNPROVEN"),
    egressPolicy: proven(policyRevoked, "revoked", "EGRESS_POLICY_REVOKE_UNPROVEN"),
    evidence: { disposition: "retained_immutable" },
    ttlSecrets: proven(secretsDestroyed, "destroyed", "TTL_SECRET_DESTRUCTION_UNPROVEN"),
  }, timestamp);
  context.checkpoints.retire(attestation.checkpointReference, cleanupResources);
  return cleanupResources;
}

/** Ownership check that also covers a checkpoint this control already retired. */
function retiredEvidence(
  context: GatewayContext,
  envelope: WorkerEnvelope,
  reference: string,
): ReturnType<typeof cleanupResourceEvidence> | undefined {
  const record = context.checkpoints.retired(reference, context.clock());
  if (!record) return undefined;
  if (record.attestation.organizationId !== envelope.ownership.organizationId
    || record.attestation.projectId !== envelope.ownership.projectId
    || record.attestation.runId !== envelope.ownership.runId) {
    throw forbidden("GATEWAY_CHECKPOINT_OWNER_MISMATCH");
  }
  return record.cleanupResources as ReturnType<typeof cleanupResourceEvidence>;
}

export async function finalizeCheckpoint(context: GatewayContext, envelope: WorkerEnvelope): Promise<RouteResult> {
  const identity = checkpointIdentity(envelope);
  const replayed = retiredEvidence(context, envelope, identity.checkpointReference);
  if (replayed) {
    return { status: 200, body: workerResponse(envelope, { finalized: true, cleanupResources: replayed }) };
  }
  const record = boundRecord(context, envelope, identity);
  const cleanupResources = await disposeCheckpoint(context, record);
  return { status: 200, body: workerResponse(envelope, { finalized: true, cleanupResources }) };
}

export async function reconcileCheckpoint(context: GatewayContext, envelope: WorkerEnvelope): Promise<RouteResult> {
  if (envelope.payload.binding !== undefined) return reconcileBinding(context, envelope);
  const identity = checkpointIdentity(envelope);
  const replayed = retiredEvidence(context, envelope, identity.checkpointReference);
  if (replayed) {
    return {
      status: 200,
      body: workerResponse(envelope, { reconciled: true, terminated: true, cleanupResources: replayed }),
    };
  }
  const record = context.checkpoints.find(identity.checkpointReference);
  if (!record) {
    // Never created here, or already forgotten: nothing to attest terminating.
    throw notFound("GATEWAY_CHECKPOINT_UNKNOWN");
  }
  if (record.attestation.organizationId !== envelope.ownership.organizationId
    || record.attestation.projectId !== envelope.ownership.projectId
    || record.attestation.runId !== envelope.ownership.runId) {
    throw forbidden("GATEWAY_CHECKPOINT_OWNER_MISMATCH");
  }
  const cleanupResources = await disposeCheckpoint(context, record);
  return { status: 200, body: workerResponse(envelope, { reconciled: true, terminated: true, cleanupResources }) };
}

async function reconcileBinding(context: GatewayContext, envelope: WorkerEnvelope): Promise<RouteResult> {
  const binding = envelope.payload.binding;
  if (!validCheckpointBinding(binding)) throw badRequest("GATEWAY_CHECKPOINT_REQUEST_INVALID");
  if (binding.organizationId !== envelope.ownership.organizationId
    || binding.projectId !== envelope.ownership.projectId
    || binding.runId !== envelope.ownership.runId) throw forbidden("GATEWAY_CHECKPOINT_OWNER_MISMATCH");
  const reference = typeof envelope.payload.checkpointReference === "string"
    ? envelope.payload.checkpointReference
    : attestationFor(binding).checkpointReference;
  if (context.checkpoints.retired(reference, context.clock())) {
    return {
      status: 200,
      body: workerResponse(envelope, { reconciled: true, checkpointOwned: true, terminated: true }),
    };
  }
  const record = context.checkpoints.find(reference);
  if (!record) {
    // This control never took ownership, so it terminated nothing.
    return {
      status: 200,
      body: workerResponse(envelope, { reconciled: true, checkpointOwned: false, terminated: false }),
    };
  }
  await disposeCheckpoint(context, record);
  return {
    status: 200,
    body: workerResponse(envelope, { reconciled: true, checkpointOwned: true, terminated: true }),
  };
}

export function bindHumanHandoff(
  context: GatewayContext,
  record: CheckpointRecord,
  targetOrigin: string,
  handoffId: string,
): void {
  if (sha256Hex(targetOrigin) !== record.attestation.targetOriginDigest) {
    throw forbidden("GATEWAY_CHECKPOINT_ORIGIN_MISMATCH");
  }
  context.checkpoints.bindHumanHandoff(record, targetOrigin, handoffId);
}

export function assertObserverAvailable(context: GatewayContext): void {
  if (!context.authenticationObserver) throw unavailable("GATEWAY_AUTHENTICATION_OBSERVER_UNAVAILABLE");
}
