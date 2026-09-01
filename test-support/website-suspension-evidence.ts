import { createHash } from "node:crypto";
import type {
  WebsiteAuthenticationSuspensionEvidence,
  WebsiteAuthenticationSuspensionProjection,
} from "../packages/database/src/control-plane.ts";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function websiteSuspensionEvidenceFixture(input: Readonly<{
  checkpointReference: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  expiresAt: string;
  workerId: string;
  leaseGeneration: number;
}>): WebsiteAuthenticationSuspensionEvidence {
  return {
    schemaVersion: 1,
    ownershipDecisionDigest: "a".repeat(64),
    providerSessionIdentityDigest: "4".repeat(64),
    browserUse: {
      adapter: "browser-use-v4",
      adapterVersion: 4,
      apiVersion: "v4",
      model: "browser-use-2.0",
      policyDigest: "6".repeat(64),
    },
    browserLease: { identityDigest: "7".repeat(64), expiresAt: input.expiresAt },
    egressPolicy: { referenceDigest: "8".repeat(64), policyDigest: "5".repeat(64) },
    cdpReferenceDigest: "9".repeat(64),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    ttlSecrets: [
      { purpose: "browser_cdp_url", referenceDigest: "9".repeat(64), expiresAt: input.expiresAt },
      { purpose: "browser_live_url", referenceDigest: "0".repeat(64), expiresAt: input.expiresAt },
    ],
    checkpoint: {
      checkpointReference: input.checkpointReference,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceIdentityHash: input.sourceIdentityHash,
      targetOriginDigest: input.targetOriginDigest,
      expiresAt: input.expiresAt,
    },
    suspendedWorkerIdentityDigest: digest(input.workerId),
    suspendedLeaseGeneration: input.leaseGeneration,
  };
}

export function websiteSuspensionProjectionFixture(
  input: Omit<Parameters<typeof websiteSuspensionEvidenceFixture>[0], "workerId" | "leaseGeneration">,
): WebsiteAuthenticationSuspensionProjection {
  const evidence = websiteSuspensionEvidenceFixture({ ...input, workerId: "projection-worker", leaseGeneration: 1 });
  return {
    schemaVersion: evidence.schemaVersion,
    ownershipDecisionDigest: evidence.ownershipDecisionDigest,
    providerSessionIdentityDigest: evidence.providerSessionIdentityDigest,
    browserUse: evidence.browserUse,
    browserLease: evidence.browserLease,
    egressPolicy: evidence.egressPolicy,
    cdpReferenceDigest: evidence.cdpReferenceDigest,
    publicEvidenceReference: evidence.publicEvidenceReference,
    ttlSecrets: evidence.ttlSecrets,
    checkpoint: evidence.checkpoint,
  };
}
