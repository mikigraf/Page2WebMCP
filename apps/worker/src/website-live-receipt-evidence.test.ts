import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { BrowserUseSuspensionAttestation } from "../../../packages/providers/src/browser-use-v4.ts";
import {
  bindWebsiteSuspensionToWorker,
  projectBrowserUseSuspensionEvidence,
} from "./workflow.ts";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

test("Browser Use suspension projects only the bounded receipt evidence needed after restart", () => {
  const attestation: BrowserUseSuspensionAttestation = {
    authenticationCheckpointProtocolVersion: 1,
    suspended: true,
    checkpointReference: `urn:sha256:${"a".repeat(64)}`,
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    projectId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    runId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    sourceSnapshotId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    sourceIdentityHash: "1".repeat(64),
    targetOriginDigest: "2".repeat(64),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    providerSessionIdDigest: "4".repeat(64),
    liveReference: "secretref:live-session-url",
    cdpReference: "secretref:cdp-session-url",
    leaseId: "browser-lease-42",
    egressPolicyReference: "secretref:egress-policy-42",
    egressPolicyDigest: "5".repeat(64),
    browserPolicyDigest: "6".repeat(64),
    expiresAt: "2026-09-01T12:09:00.000Z",
  };

  const projection = projectBrowserUseSuspensionEvidence(attestation, "a".repeat(64));
  assert.deepEqual(projection, {
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
    browserLease: {
      identityDigest: digest("browser-lease-42"),
      expiresAt: "2026-09-01T12:09:00.000Z",
    },
    egressPolicy: {
      referenceDigest: digest("secretref:egress-policy-42"),
      policyDigest: "5".repeat(64),
    },
    cdpReferenceDigest: digest("secretref:cdp-session-url"),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    ttlSecrets: [
      {
        purpose: "browser_cdp_url",
        referenceDigest: digest("secretref:cdp-session-url"),
        expiresAt: "2026-09-01T12:09:00.000Z",
      },
      {
        purpose: "browser_live_url",
        referenceDigest: digest("secretref:live-session-url"),
        expiresAt: "2026-09-01T12:09:00.000Z",
      },
    ],
    checkpoint: {
      checkpointReference: `urn:sha256:${"a".repeat(64)}`,
      sourceSnapshotId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      sourceIdentityHash: "1".repeat(64),
      targetOriginDigest: "2".repeat(64),
      expiresAt: "2026-09-01T12:09:00.000Z",
    },
  });

  const bound = bindWebsiteSuspensionToWorker(projection, "worker-secret-name", 7);
  assert.equal(bound.suspendedWorkerIdentityDigest, digest("worker-secret-name"));
  assert.equal(bound.suspendedLeaseGeneration, 7);
  const serialized = JSON.stringify(bound);
  for (const forbidden of [
    attestation.liveReference,
    attestation.cdpReference,
    attestation.leaseId,
    attestation.egressPolicyReference,
    attestation.organizationId,
    attestation.projectId,
    attestation.runId,
    "worker-secret-name",
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("suspension projection rejects unvalidated or secret-bearing attestation shapes", () => {
  const malformed = {
    authenticationCheckpointProtocolVersion: 1,
    suspended: true,
    checkpointReference: `urn:sha256:${"a".repeat(64)}`,
    sourceSnapshotId: "snapshot",
    sourceIdentityHash: "1".repeat(64),
    targetOriginDigest: "2".repeat(64),
    publicEvidenceReference: `urn:sha256:${"3".repeat(64)}`,
    providerSessionIdDigest: "4".repeat(64),
    providerSessionId: "must-never-persist",
    liveReference: "https://live.browser-use.example/session/credential",
    cdpReference: "wss://cdp.browser-use.example/session/credential",
    leaseId: "lease",
    egressPolicyReference: "secretref:policy",
    egressPolicyDigest: "5".repeat(64),
    browserPolicyDigest: "6".repeat(64),
    expiresAt: "2026-09-01T12:09:00.000Z",
  };
  assert.throws(
    () => projectBrowserUseSuspensionEvidence(malformed as never, "a".repeat(64)),
    /WEBSITE_SUSPENSION_EVIDENCE_INVALID/,
  );
});
