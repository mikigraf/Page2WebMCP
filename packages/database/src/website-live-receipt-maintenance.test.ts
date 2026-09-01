import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { MaintenanceReadinessPool } from "./readiness.ts";
import { createWebsiteLiveReceiptEvidenceMaintenanceRepository } from "./website-live-receipt-maintenance.ts";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const selectedHash = "a".repeat(64);
const expiresAt = "2026-09-01T12:09:00.000Z";
const publicEvidenceReference = `urn:sha256:${"3".repeat(64)}`;
const ttlSecrets = [
  { purpose: "browser_cdp_url", referenceDigest: "9".repeat(64), expiresAt },
  { purpose: "browser_live_url", referenceDigest: "0".repeat(64), expiresAt },
];

function validRow(): Record<string, unknown> {
  return {
    selected_release_hash: selectedHash,
    analysis_run_identity_digest: "1".repeat(64),
    source_snapshot_identity_digest: "2".repeat(64),
    source_identity_hash: "f".repeat(64),
    target_origin_digest: "5".repeat(64),
    ownership_decision_digest: "a".repeat(64),
    provider_session_identity_digest: "4".repeat(64),
    browser_use_api_version: "v4",
    browser_use_model: "browser-use-2.0",
    browser_use_adapter: "browser-use-v4",
    browser_use_adapter_version: 4,
    browser_policy_digest: "6".repeat(64),
    browser_lease_identity_digest: "7".repeat(64),
    browser_lease_expires_at: expiresAt,
    egress_policy_reference_digest: "8".repeat(64),
    egress_policy_digest: "5".repeat(64),
    cdp_reference_digest: "9".repeat(64),
    public_evidence_reference: publicEvidenceReference,
    ttl_secret_digest_evidence: ttlSecrets,
    checkpoint_identity_digest: digest(`urn:sha256:${"b".repeat(64)}`),
    checkpoint_expires_at: expiresAt,
    suspended_worker_identity_digest: "c".repeat(64),
    suspended_lease_generation: 1,
    suspended_at: "2026-09-01T12:00:00.000Z",
    authentication_evidence_reference_digest: "d".repeat(64),
    authentication_consumed_at: "2026-09-01T12:01:00.000Z",
    resumed_worker_identity_digest: "e".repeat(64),
    resume_lease_generation: 2,
    resume_claimed_at: "2026-09-01T12:02:00.000Z",
    result_checkpoint_hash: "b".repeat(64),
    result_checkpoint_output_reference: `urn:sha256:${selectedHash}`,
    result_checkpoint_worker_identity_digest: "1".repeat(64),
    result_checkpoint_lease_generation: 3,
    result_checkpointed_at: "2026-09-01T12:03:00.000Z",
    completion_worker_identity_digest: "f".repeat(64),
    completion_lease_generation: 4,
    resume_acknowledged_at: "2026-09-01T12:04:00.000Z",
    restart_verified: true,
    cleanup_resources: [
      { resource: "authentication_handoff_checkpoint", identityDigest: digest(`urn:sha256:${"b".repeat(64)}`),
        disposition: "destroyed", timestamp: "2026-09-01T12:04:00.000Z" },
      { resource: "browser_lease", identityDigest: "7".repeat(64), disposition: "released",
        timestamp: "2026-09-01T12:04:00.000Z" },
      { resource: "browser_session", identityDigest: "4".repeat(64), disposition: "destroyed",
        timestamp: "2026-09-01T12:04:00.000Z" },
      { resource: "cdp_observation_lease", identityDigest: "9".repeat(64), disposition: "released",
        timestamp: "2026-09-01T12:04:00.000Z" },
      { resource: "egress_policy_proxy", identityDigest: "8".repeat(64), disposition: "revoked",
        timestamp: "2026-09-01T12:04:00.000Z" },
      { resource: "evidence_lease", identityDigest: digest(publicEvidenceReference), disposition: "retained_immutable",
        timestamp: "2026-09-01T12:04:00.000Z" },
      { resource: "ttl_secrets", identityDigest: digest(JSON.stringify(ttlSecrets)), disposition: "destroyed",
        timestamp: "2026-09-01T12:04:00.000Z" },
    ],
  };
}

function repositoryFor(row: Record<string, unknown>, requestedRows = [row]) {
  const client = {
    query: async (sql: string) => sql.startsWith("select *") ? { rows: requestedRows } : { rows: [] },
    release: () => undefined,
  };
  return createWebsiteLiveReceiptEvidenceMaintenanceRepository({
    connect: async () => client,
    end: async () => undefined,
  } as unknown as MaintenanceReadinessPool);
}

test("maintenance projection accepts only a fully bound, cleaned, restart-verified receipt", async () => {
  const evidence = await repositoryFor(validRow()).findSelected(selectedHash);
  assert.equal(evidence?.selectedReleaseHash, selectedHash);
  assert.equal(evidence?.resultCheckpointOutputReference, `urn:sha256:${selectedHash}`);
  assert.equal(evidence?.resultCheckpointLeaseGeneration, 3);
  assert.equal(evidence?.completionLeaseGeneration, 4);
});

test("maintenance projection rejects mismatched selection, TTL, completion, and cleanup evidence", async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...validRow(), selected_release_hash: "0".repeat(64) },
    { ...validRow(), ownership_decision_digest: "not-an-ownership-digest" },
    { ...validRow(), ttl_secret_digest_evidence: [ttlSecrets[0], ttlSecrets[0]] },
    { ...validRow(), ttl_secret_digest_evidence: [ttlSecrets[0], { ...ttlSecrets[1], expiresAt: "2026-09-01T12:08:00.000Z" }] },
    { ...validRow(), completion_worker_identity_digest: "c".repeat(64) },
    { ...validRow(), cleanup_resources: (validRow().cleanup_resources as Array<Record<string, unknown>>)
      .map((item) => {
        if (item.resource !== "browser_session") return item;
        const pending = { ...item };
        delete pending.timestamp;
        return { ...pending, disposition: "pending" };
      }) },
  ];
  for (const row of cases) {
    await assert.rejects(repositoryFor(row).findSelected(selectedHash), /WEBSITE_LIVE_RECEIPT_EVIDENCE_INVALID/);
  }
});
