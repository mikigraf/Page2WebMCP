import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveInstallationOperationId,
  liveCandidateVerifierScopeDigest,
  liveInstallationVerifierScopeDigest,
  normalizeVerifierAttestationIdentity,
} from "./control-plane.ts";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

test("durable verifier-v2 identities are strict, secret-free, and operation specific", () => {
  const identity = {
    protocolVersion: 2 as const,
    attestationId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    nonceDigest: HASH,
    operation: "candidate" as const,
    scopeDigest: OTHER_HASH,
    payloadDigest: HASH,
    issuedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-01T12:01:00.000Z",
    attestedAt: "2026-09-01T12:00:01.000Z",
  };
  assert.deepEqual(normalizeVerifierAttestationIdentity(identity, "candidate"), identity);
  for (const invalid of [
    { ...identity, operation: "installation" },
    { ...identity, token: "must-never-persist" },
    { ...identity, expiresAt: identity.issuedAt },
    { ...identity, attestedAt: identity.expiresAt },
    { ...identity, attestedAt: "2026-09-01T12:01:01.000Z" },
  ]) assert.throws(() => normalizeVerifierAttestationIdentity(invalid as never, "candidate"),
    (error: unknown) => !!error && typeof error === "object"
      && "details" in error && (error as { details?: string[] }).details?.includes("VERIFIER_ATTESTATION_INVALID") === true);
});

test("candidate and installation scope digests bind exact persisted application identities", () => {
  assert.equal(liveCandidateVerifierScopeDigest({
    projectId: "11111111-1111-4111-8111-111111111111",
    analysisRunId: "22222222-2222-4222-8222-222222222222",
    sourceIdentityHash: OTHER_HASH,
    targetOrigin: "https://staging.widgets.example",
    environment: "staging",
    contentHash: HASH,
  }), "74164e2d64395b989eb4561b2f745942f2af33c72e94c68c327729ce77d58efd");

  const installationOperationId = deriveInstallationOperationId({
    projectId: "11111111-1111-4111-8111-111111111111",
    releaseId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "install-release-one",
    inputHash: HASH,
  });
  assert.equal(installationOperationId, "e831415cd3da21ef8b426aba449e78c73ccb2412f57920b863a181e7ad29c63a");
  assert.equal(liveInstallationVerifierScopeDigest({
    projectId: "11111111-1111-4111-8111-111111111111",
    releaseId: "33333333-3333-4333-8333-333333333333",
    installationOperationId,
    sourceIdentityHash: OTHER_HASH,
    pageUrl: "https://staging.widgets.example/account",
    targetOrigin: "https://staging.widgets.example",
    environment: "staging",
    selectedHash: HASH,
  }), "bfcca663993ea3036e26852a38d314b73c5a2165e0a9979d3f57c847fc66140a");
});
