import { sha256Hex } from "../canonical.ts";
import type { BrowserUseSuspensionAttestation } from "../../../../packages/providers/src/browser-use-v4.ts";
import type { WebsiteAuthenticationCleanupResourceEvidence } from "../../../../packages/database/src/control-plane.ts";

export type CleanupDisposition = Readonly<{
  disposition: "revoked" | "released" | "destroyed" | "retained_immutable" | "failed";
  errorCode?: string;
}>;

export type CleanupOutcomes = Readonly<{
  checkpoint: CleanupDisposition;
  browserLease: CleanupDisposition;
  browserSession: CleanupDisposition;
  cdpObservationLease: CleanupDisposition;
  egressPolicy: CleanupDisposition;
  evidence: CleanupDisposition;
  ttlSecrets: CleanupDisposition;
}>;

/**
 * Reports the identity and the observed disposition of each resource this
 * control is responsible for. A resource whose disposal could not be proven is
 * reported as `failed` with its error code, never as disposed.
 */
export function cleanupResourceEvidence(
  attestation: BrowserUseSuspensionAttestation,
  outcomes: CleanupOutcomes,
  timestamp: string,
): WebsiteAuthenticationCleanupResourceEvidence[] {
  const ttlSecrets = [
    { purpose: "browser_cdp_url", referenceDigest: sha256Hex(attestation.cdpReference), expiresAt: attestation.expiresAt },
    { purpose: "browser_live_url", referenceDigest: sha256Hex(attestation.liveReference), expiresAt: attestation.expiresAt },
  ];
  const entries: readonly (readonly [
    WebsiteAuthenticationCleanupResourceEvidence["resource"], string, CleanupDisposition,
  ])[] = [
    ["authentication_handoff_checkpoint", sha256Hex(attestation.checkpointReference), outcomes.checkpoint],
    ["browser_lease", sha256Hex(attestation.leaseId), outcomes.browserLease],
    ["browser_session", attestation.providerSessionIdDigest, outcomes.browserSession],
    ["cdp_observation_lease", sha256Hex(attestation.cdpReference), outcomes.cdpObservationLease],
    ["egress_policy_proxy", sha256Hex(attestation.egressPolicyReference), outcomes.egressPolicy],
    ["evidence_lease", sha256Hex(attestation.publicEvidenceReference), outcomes.evidence],
    ["ttl_secrets", sha256Hex(JSON.stringify(ttlSecrets)), outcomes.ttlSecrets],
  ];
  return entries.map(([resource, identityDigest, outcome]) => ({
    resource,
    identityDigest,
    disposition: outcome.disposition,
    timestamp,
    ...(outcome.disposition === "failed" ? { errorCode: outcome.errorCode ?? "CLEANUP_UNPROVEN" } : {}),
  }));
}
