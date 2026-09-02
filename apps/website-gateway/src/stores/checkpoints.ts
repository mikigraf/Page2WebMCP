import {
  browserUseSuspensionCheckpointReference,
  type BrowserUseSuspensionAttestation,
} from "../../../../packages/providers/src/browser-use-v4.ts";
import { sha256Hex } from "../canonical.ts";
import {
  AUTHENTICATION_CHECKPOINT_PROTOCOL_VERSION,
  HASH_REFERENCE,
  HEX64,
  IDENTIFIER,
  SECRET_REFERENCE,
} from "../constants.ts";

export type CheckpointBinding = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  publicEvidenceReference: string;
  egressPolicyReference: string;
  egressPolicyDigest: string;
  providerSessionId: string;
  liveReference: string;
  cdpReference: string;
  leaseId: string;
  browserPolicyDigest: string;
  expiresAt: string;
}>;

export type AuthenticationSignal = Readonly<{
  authenticatedOrigin: string;
  observedAt: string;
  signals: readonly string[];
}>;

export type CheckpointRecord = {
  readonly attestation: BrowserUseSuspensionAttestation;
  readonly providerSessionId: string;
  readonly expiresAtMs: number;
  targetOrigin?: string;
  handoffId?: string;
  authentication?: AuthenticationSignal;
  authenticationEvidenceReference?: string;
  resumeClaimed: boolean;
  terminal: boolean;
};

export type CheckpointStore = Readonly<{
  create(binding: CheckpointBinding): BrowserUseSuspensionAttestation;
  get(reference: string, now: Date): CheckpointRecord | undefined;
  find(reference: string): CheckpointRecord | undefined;
  byHandoff(handoffId: string, now: Date): CheckpointRecord | undefined;
  bindHumanHandoff(record: CheckpointRecord, targetOrigin: string, handoffId: string): void;
  recordAuthentication(record: CheckpointRecord, signal: AuthenticationSignal, reference: string): void;
  /** Returns true for the single caller that wins the resume; false for every replay. */
  claimResume(record: CheckpointRecord): boolean;
  retire(reference: string, cleanupResources: readonly unknown[]): void;
  /** The disposal evidence of a checkpoint this control already terminated. */
  retired(reference: string, now: Date): RetiredCheckpoint | undefined;
}>;

export type RetiredCheckpoint = Readonly<{
  attestation: BrowserUseSuspensionAttestation;
  cleanupResources: readonly unknown[];
  forgetAtMs: number;
}>;

export function validCheckpointBinding(value: unknown): value is CheckpointBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const strings = ["organizationId", "projectId", "runId", "sourceSnapshotId", "leaseId", "providerSessionId"];
  return strings.every((name) => typeof binding[name] === "string" && IDENTIFIER.test(binding[name] as string))
    && [binding.sourceIdentityHash, binding.targetOriginDigest, binding.egressPolicyDigest, binding.browserPolicyDigest]
      .every((digest) => typeof digest === "string" && HEX64.test(digest))
    && typeof binding.publicEvidenceReference === "string" && HASH_REFERENCE.test(binding.publicEvidenceReference)
    && [binding.egressPolicyReference, binding.liveReference, binding.cdpReference]
      .every((reference) => typeof reference === "string" && SECRET_REFERENCE.test(reference))
    && typeof binding.expiresAt === "string" && Number.isFinite(Date.parse(binding.expiresAt));
}

export function attestationFor(binding: CheckpointBinding): BrowserUseSuspensionAttestation {
  const content = {
    authenticationCheckpointProtocolVersion: AUTHENTICATION_CHECKPOINT_PROTOCOL_VERSION,
    suspended: true as const,
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    runId: binding.runId,
    sourceSnapshotId: binding.sourceSnapshotId,
    sourceIdentityHash: binding.sourceIdentityHash,
    targetOriginDigest: binding.targetOriginDigest,
    publicEvidenceReference: binding.publicEvidenceReference,
    providerSessionIdDigest: sha256Hex(binding.providerSessionId),
    liveReference: binding.liveReference,
    cdpReference: binding.cdpReference,
    leaseId: binding.leaseId,
    egressPolicyReference: binding.egressPolicyReference,
    egressPolicyDigest: binding.egressPolicyDigest,
    browserPolicyDigest: binding.browserPolicyDigest,
    expiresAt: binding.expiresAt,
  };
  return { ...content, checkpointReference: browserUseSuspensionCheckpointReference(content) };
}

/**
 * Authentication checkpoints, held per process.
 *
 * Guarantee: at most one resume ever succeeds for a checkpoint reference for as
 * long as this process lives, because the claim below is a single synchronous
 * compare-and-set on a value no other task can interleave with.
 *
 * Not guaranteed: durability. A restart forgets every checkpoint, and a second
 * replica would keep its own table. An operator therefore runs exactly one
 * replica of the authentication-handoff control, and a restart fails a pending
 * checkpoint closed (status "missing", resume refused) rather than admitting a
 * second resume.
 */
export function createCheckpointStore(): CheckpointStore {
  const records = new Map<string, CheckpointRecord>();
  const byHandoff = new Map<string, string>();
  const retired = new Map<string, RetiredCheckpoint>();

  const store: CheckpointStore = {
    create(binding) {
      const attestation = attestationFor(binding);
      const existing = records.get(attestation.checkpointReference);
      if (existing) return existing.attestation;
      records.set(attestation.checkpointReference, {
        attestation,
        providerSessionId: binding.providerSessionId,
        expiresAtMs: Date.parse(binding.expiresAt),
        resumeClaimed: false,
        terminal: false,
      });
      return attestation;
    },
    get(reference, now) {
      const record = records.get(reference);
      if (!record || record.terminal || record.expiresAtMs <= now.getTime()) return undefined;
      return record;
    },
    find: (reference) => records.get(reference),
    byHandoff(handoffId, now) {
      const reference = byHandoff.get(handoffId);
      return reference ? store.get(reference, now) : undefined;
    },
    bindHumanHandoff(record, targetOrigin, handoffId) {
      if (record.handoffId) byHandoff.delete(record.handoffId);
      record.targetOrigin = targetOrigin;
      record.handoffId = handoffId;
      byHandoff.set(handoffId, record.attestation.checkpointReference);
    },
    recordAuthentication(record, signal, reference) {
      record.authentication = signal;
      record.authenticationEvidenceReference = reference;
    },
    claimResume(record) {
      if (record.resumeClaimed) return false;
      record.resumeClaimed = true;
      return true;
    },
    retire(reference, cleanupResources) {
      const record = records.get(reference);
      if (!record) return;
      record.terminal = true;
      if (record.handoffId) byHandoff.delete(record.handoffId);
      records.delete(reference);
      retired.set(reference, {
        attestation: record.attestation,
        cleanupResources,
        // Disposal evidence outlives the checkpoint only long enough for the
        // worker's finalize/reconcile pair to read the same answer twice.
        forgetAtMs: record.expiresAtMs + 60 * 60_000,
      });
    },
    retired(reference, now) {
      const record = retired.get(reference);
      if (!record) return undefined;
      if (record.forgetAtMs <= now.getTime()) { retired.delete(reference); return undefined; }
      return record;
    },
  };
  return store;
}
