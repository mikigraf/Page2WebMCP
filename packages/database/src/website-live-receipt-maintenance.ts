import { createHash } from "node:crypto";
import type { MaintenanceReadinessPool } from "./readiness.ts";
import {
  normalizeWebsiteCleanupResources,
  type WebsiteAuthenticationCleanupResourceEvidence,
  type WebsiteAuthenticationTtlSecretEvidence,
} from "./control-plane.ts";

const HASH = /^[0-9a-f]{64}$/;

export type SelectedWebsiteLiveReceiptEvidence = Readonly<{
  selectedReleaseHash: string;
  analysisRunIdentityDigest: string;
  sourceSnapshotIdentityDigest: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  ownershipDecisionDigest: string;
  providerSessionIdentityDigest: string;
  browserUseApiVersion: "v4";
  browserUseModel: "browser-use-2.0";
  browserUseAdapter: "browser-use-v4";
  browserUseAdapterVersion: 4;
  browserPolicyDigest: string;
  browserLeaseIdentityDigest: string;
  browserLeaseExpiresAt: string;
  egressPolicyReferenceDigest: string;
  egressPolicyDigest: string;
  cdpReferenceDigest: string;
  publicEvidenceReference: string;
  ttlSecretDigestEvidence: readonly WebsiteAuthenticationTtlSecretEvidence[];
  checkpointIdentityDigest: string;
  checkpointExpiresAt: string;
  suspendedWorkerIdentityDigest: string;
  suspendedLeaseGeneration: number;
  suspendedAt: string;
  authenticationEvidenceReferenceDigest?: string;
  authenticationConsumedAt?: string;
  resumedWorkerIdentityDigest?: string;
  resumeLeaseGeneration?: number;
  resumeClaimedAt?: string;
  resultCheckpointHash: string;
  resultCheckpointOutputReference: string;
  resultCheckpointWorkerIdentityDigest: string;
  resultCheckpointLeaseGeneration: number;
  resultCheckpointedAt: string;
  completionWorkerIdentityDigest: string;
  completionLeaseGeneration: number;
  resumeAcknowledgedAt?: string;
  restartVerified: boolean;
  cleanupResources: readonly WebsiteAuthenticationCleanupResourceEvidence[];
}>;

export type WebsiteLiveReceiptEvidenceMaintenanceRepository = Readonly<{
  findSelected(hash: string): Promise<SelectedWebsiteLiveReceiptEvidence | undefined>;
  close(): Promise<void>;
}>;

export function createWebsiteLiveReceiptEvidenceMaintenanceRepository(
  pool: MaintenanceReadinessPool,
): WebsiteLiveReceiptEvidenceMaintenanceRepository {
  return {
    async findSelected(hash) {
      if (!HASH.test(hash)) throw new Error("WEBSITE_LIVE_RECEIPT_HASH_INVALID");
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction read only");
        await client.query("set local role page2webmcp_maintenance");
        const result = await client.query(
          "select * from private.selected_website_live_receipt_evidence($1)",
          [hash],
        );
        if (result.rows.length > 1) throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
        const evidence = result.rows[0] ? mapSelectedWebsiteLiveReceiptEvidence(result.rows[0]) : undefined;
        if (evidence && evidence.selectedReleaseHash !== hash) {
          throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
        }
        await client.query("commit");
        return evidence;
      } catch (error) {
        try { await client.query("rollback"); } catch { /* preserve the bounded query error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function mapSelectedWebsiteLiveReceiptEvidence(
  row: Readonly<Record<string, unknown>>,
): SelectedWebsiteLiveReceiptEvidence {
  const digest = (value: unknown): string => {
    if (typeof value !== "string" || !HASH.test(value)) throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
    return value;
  };
  const instant = (value: unknown): string => {
    if (!(typeof value === "string" || value instanceof Date) || !Number.isFinite(new Date(value).getTime())) {
      throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
    }
    return new Date(value).toISOString();
  };
  const contentReference = (value: unknown): string => {
    if (typeof value !== "string" || !/^urn:sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
    }
    return value;
  };
  const positiveInteger = (value: unknown): number => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
    return number;
  };
  const ttlSecrets = row.ttl_secret_digest_evidence;
  if (!Array.isArray(ttlSecrets) || ttlSecrets.length !== 2) throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
  const normalizedTtlSecrets = ttlSecrets.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
    }
    const secret = item as Record<string, unknown>;
    if ((secret.purpose !== "browser_cdp_url" && secret.purpose !== "browser_live_url")
      || Object.keys(secret).sort().join(",") !== "expiresAt,purpose,referenceDigest") {
      throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
    }
    return { purpose: secret.purpose as WebsiteAuthenticationTtlSecretEvidence["purpose"],
      referenceDigest: digest(secret.referenceDigest),
      expiresAt: instant(secret.expiresAt) };
  }).sort((left, right) => left.purpose.localeCompare(right.purpose));
  if (normalizedTtlSecrets[0]?.purpose !== "browser_cdp_url"
    || normalizedTtlSecrets[1]?.purpose !== "browser_live_url"
    || normalizedTtlSecrets[0].referenceDigest === normalizedTtlSecrets[1].referenceDigest) {
    throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
  }
  let cleanupResources: readonly WebsiteAuthenticationCleanupResourceEvidence[];
  try {
    cleanupResources = normalizeWebsiteCleanupResources(
      row.cleanup_resources as WebsiteAuthenticationCleanupResourceEvidence[],
    );
  } catch {
    invalid();
  }
  const result: SelectedWebsiteLiveReceiptEvidence = {
    selectedReleaseHash: digest(row.selected_release_hash),
    analysisRunIdentityDigest: digest(row.analysis_run_identity_digest),
    sourceSnapshotIdentityDigest: digest(row.source_snapshot_identity_digest),
    sourceIdentityHash: digest(row.source_identity_hash),
    targetOriginDigest: digest(row.target_origin_digest),
    ownershipDecisionDigest: digest(row.ownership_decision_digest),
    providerSessionIdentityDigest: digest(row.provider_session_identity_digest),
    browserUseApiVersion: row.browser_use_api_version === "v4" ? "v4" : invalid(),
    browserUseModel: row.browser_use_model === "browser-use-2.0" ? "browser-use-2.0" : invalid(),
    browserUseAdapter: row.browser_use_adapter === "browser-use-v4" ? "browser-use-v4" : invalid(),
    browserUseAdapterVersion: positiveInteger(row.browser_use_adapter_version) === 4 ? 4 : invalid(),
    browserPolicyDigest: digest(row.browser_policy_digest),
    browserLeaseIdentityDigest: digest(row.browser_lease_identity_digest),
    browserLeaseExpiresAt: instant(row.browser_lease_expires_at),
    egressPolicyReferenceDigest: digest(row.egress_policy_reference_digest),
    egressPolicyDigest: digest(row.egress_policy_digest),
    cdpReferenceDigest: digest(row.cdp_reference_digest),
    publicEvidenceReference: contentReference(row.public_evidence_reference),
    ttlSecretDigestEvidence: normalizedTtlSecrets,
    checkpointIdentityDigest: digest(row.checkpoint_identity_digest),
    checkpointExpiresAt: instant(row.checkpoint_expires_at),
    suspendedWorkerIdentityDigest: digest(row.suspended_worker_identity_digest),
    suspendedLeaseGeneration: positiveInteger(row.suspended_lease_generation),
    suspendedAt: instant(row.suspended_at),
    ...(row.authentication_evidence_reference_digest ? {
      authenticationEvidenceReferenceDigest: digest(row.authentication_evidence_reference_digest),
      authenticationConsumedAt: instant(row.authentication_consumed_at),
    } : {}),
    ...(row.resumed_worker_identity_digest ? {
      resumedWorkerIdentityDigest: digest(row.resumed_worker_identity_digest),
      resumeLeaseGeneration: positiveInteger(row.resume_lease_generation),
      resumeClaimedAt: instant(row.resume_claimed_at),
    } : {}),
    resultCheckpointHash: digest(row.result_checkpoint_hash),
    resultCheckpointOutputReference: contentReference(row.result_checkpoint_output_reference),
    resultCheckpointWorkerIdentityDigest: digest(row.result_checkpoint_worker_identity_digest),
    resultCheckpointLeaseGeneration: positiveInteger(row.result_checkpoint_lease_generation),
    resultCheckpointedAt: instant(row.result_checkpointed_at),
    completionWorkerIdentityDigest: digest(row.completion_worker_identity_digest),
    completionLeaseGeneration: positiveInteger(row.completion_lease_generation),
    ...(row.resume_acknowledged_at ? { resumeAcknowledgedAt: instant(row.resume_acknowledged_at) } : {}),
    restartVerified: row.restart_verified === true,
    cleanupResources,
  };
  if (!result.restartVerified || !result.authenticationEvidenceReferenceDigest || !result.authenticationConsumedAt
    || !result.resumedWorkerIdentityDigest || !result.resumeLeaseGeneration || !result.resumeClaimedAt
    || !result.resumeAcknowledgedAt
    || result.resultCheckpointOutputReference !== `urn:sha256:${result.selectedReleaseHash}`
    || result.resultCheckpointLeaseGeneration < result.resumeLeaseGeneration
    || result.completionWorkerIdentityDigest === result.suspendedWorkerIdentityDigest
    || result.completionLeaseGeneration < result.resultCheckpointLeaseGeneration
    || result.cdpReferenceDigest !== normalizedTtlSecrets[0].referenceDigest
    || result.browserLeaseExpiresAt !== result.checkpointExpiresAt
    || normalizedTtlSecrets.some(({ expiresAt }) => expiresAt !== result.checkpointExpiresAt)
    || Date.parse(result.authenticationConsumedAt) < Date.parse(result.suspendedAt)
    || Date.parse(result.resumeClaimedAt) < Date.parse(result.authenticationConsumedAt)
    || Date.parse(result.resultCheckpointedAt) < Date.parse(result.resumeClaimedAt)
    || Date.parse(result.resumeAcknowledgedAt) < Date.parse(result.resultCheckpointedAt)) invalid();
  const cleanupIdentityByResource = new Map(result.cleanupResources.map((item) => [item.resource, item]));
  const expectedIdentities: Readonly<Record<string, string>> = {
    authentication_handoff_checkpoint: result.checkpointIdentityDigest,
    browser_lease: result.browserLeaseIdentityDigest,
    browser_session: result.providerSessionIdentityDigest,
    cdp_observation_lease: result.cdpReferenceDigest,
    egress_policy_proxy: result.egressPolicyReferenceDigest,
    evidence_lease: createHash("sha256").update(result.publicEvidenceReference, "utf8").digest("hex"),
    ttl_secrets: createHash("sha256").update(JSON.stringify(normalizedTtlSecrets), "utf8").digest("hex"),
  };
  const terminalDispositions: Readonly<Record<string, ReadonlySet<string>>> = {
    authentication_handoff_checkpoint: new Set(["destroyed", "reconciled"]),
    browser_lease: new Set(["released", "reconciled"]),
    browser_session: new Set(["destroyed", "reconciled"]),
    cdp_observation_lease: new Set(["released", "reconciled"]),
    egress_policy_proxy: new Set(["revoked", "reconciled"]),
    evidence_lease: new Set(["released", "retained_immutable"]),
    ttl_secrets: new Set(["destroyed", "revoked"]),
  };
  for (const [resource, expectedIdentity] of Object.entries(expectedIdentities)) {
    const cleanup = cleanupIdentityByResource.get(
      resource as WebsiteAuthenticationCleanupResourceEvidence["resource"],
    );
    if (!cleanup || cleanup.identityDigest !== expectedIdentity
      || !terminalDispositions[resource]!.has(cleanup.disposition)) invalid();
  }
  return result;
}

function invalid(): never {
  throw new Error("WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID");
}
