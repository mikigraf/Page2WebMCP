import assert from "node:assert/strict";
import test from "node:test";
import { startGateway, testEnvironment, canonicalJson, sha256Hex, TEST_TOKENS } from "./harness.ts";

const token = TEST_TOKENS["ownership-store"];
const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SOURCE = "88888888-8888-4888-8888-888888888888";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";
const TARGET_ORIGIN = "https://widgets.example";
const SOURCE_URL = "https://widgets.example/app";
const IDENTITY = "b".repeat(64);
const RUN = "33333333-3333-4333-8333-333333333333";
const ownership = { organizationId: ORGANIZATION, projectId: PROJECT, runId: RUN };

function envelope(operation: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    gatewayProtocolVersion: 1,
    idempotencyKey: `website:${RUN}:1:${operation}:${sha256Hex(canonicalJson(payload))}`,
    ownership,
    ...payload,
  };
}

function uiEnvelope(suffix: string): Record<string, unknown> {
  return {
    gatewayProtocolVersion: 1,
    idempotencyKey: `website-ui:${sha256Hex(suffix)}`,
    scope: { organizationId: ORGANIZATION, projectId: PROJECT },
    source: {
      projectSourceId: SOURCE,
      sourceSnapshotId: SNAPSHOT,
      sourceIdentityHash: IDENTITY,
      sourceUrl: SOURCE_URL,
      targetOrigin: TARGET_ORIGIN,
    },
  };
}

function consumePayload(): Record<string, unknown> {
  return {
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    runId: RUN,
    sourceIdentityHash: IDENTITY,
    sourceUrl: SOURCE_URL,
    targetOrigin: TARGET_ORIGIN,
  };
}

test("a source attestation is issued, verified, consumed and loadable, and its digest matches the challenge token", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  let issuedToken = "";
  const gateway = await startGateway(testEnvironment(), {
    clock: () => current,
    ownershipVerifier: { verify: async (challenge) => { issuedToken = challenge.token; return { verified: true as const }; } },
  });
  try {
    const missing = await gateway.json("/v1/website-ownership/source-attestations/status", uiEnvelope("s0"), { token });
    assert.equal(missing.body?.state, "missing");

    const issued = await gateway.json("/v1/website-ownership/source-attestations/issue", uiEnvelope("i1"), { token });
    assert.equal(issued.status, 200);
    assert.equal(issued.body?.state, "pending");
    assert.match(String(issued.body?.token), /^[A-Za-z0-9_-]{32,128}$/);
    assert.ok(["dns_txt", "well_known"].includes(String(issued.body?.method)));
    assert.equal(issued.body?.targetOrigin, TARGET_ORIGIN);

    const beforeVerification = await gateway.json("/v1/website-ownership/source-attestations/consume",
      envelope("source-attestation-consume", consumePayload()), { token });
    assert.equal(beforeVerification.status, 409);

    const checked = await gateway.json("/v1/website-ownership/source-attestations/check", uiEnvelope("c1"), { token });
    assert.equal(checked.body?.state, "verified");
    assert.equal(issuedToken, issued.body?.token);

    const consumed = await gateway.json("/v1/website-ownership/source-attestations/consume",
      envelope("source-attestation-consume", consumePayload()), { token });
    assert.equal(consumed.status, 200);
    assert.equal(consumed.body?.bound, true);
    assert.equal(consumed.body?.challengeDigest, sha256Hex(String(issued.body?.token)));

    const loaded = await gateway.json("/v1/website-ownership/challenges/load", envelope("ownership-load", {
      organizationId: ORGANIZATION, projectId: PROJECT,
      runId: RUN, targetOrigin: TARGET_ORIGIN,
    }), { token });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body?.token, issued.body?.token);
    assert.equal(loaded.body?.targetOrigin, TARGET_ORIGIN);
    assert.equal(sha256Hex(String(loaded.body?.token)), consumed.body?.challengeDigest);
  } finally { await gateway.close(); }
});

test("a failed proof is reported as failed and never consumable", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), {
    clock: () => current,
    ownershipVerifier: { verify: async () => ({ verified: false as const, reason: "OWNERSHIP_PROOF_MISSING" }) },
  });
  try {
    await gateway.json("/v1/website-ownership/source-attestations/issue", uiEnvelope("i1"), { token });
    const checked = await gateway.json("/v1/website-ownership/source-attestations/check", uiEnvelope("c1"), { token });
    assert.equal(checked.body?.state, "failed");
    const consumed = await gateway.json("/v1/website-ownership/source-attestations/consume",
      envelope("source-attestation-consume", consumePayload()), { token });
    assert.equal(consumed.status, 409);
  } finally { await gateway.close(); }
});

test("a replay key is consumable exactly once and never after its expiry", async () => {
  let current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const expiresAt = new Date(current.getTime() + 600_000).toISOString();
    const payload = { key: "e".repeat(64), expiresAt };
    const first = await gateway.json("/v1/website-ownership/replays/consume",
      envelope("ownership-replay", payload), { token });
    assert.equal(first.status, 200);
    assert.equal(first.body?.consumed, true);
    const second = await gateway.json("/v1/website-ownership/replays/consume",
      envelope("ownership-replay", payload), { token });
    assert.equal(second.status, 200);
    assert.equal(second.body?.consumed, false);

    current = new Date(current.getTime() + 3_600_000);
    const stale = await gateway.json("/v1/website-ownership/replays/consume",
      envelope("ownership-replay-2", { key: "f".repeat(64), expiresAt }), { token });
    assert.equal(stale.body?.consumed, false);
  } finally { await gateway.close(); }
});

test("consume refuses a source url that does not belong to the attested origin", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), {
    clock: () => current,
    ownershipVerifier: { verify: async () => ({ verified: true as const }) },
  });
  try {
    await gateway.json("/v1/website-ownership/source-attestations/issue", uiEnvelope("i1"), { token });
    await gateway.json("/v1/website-ownership/source-attestations/check", uiEnvelope("c1"), { token });
    const mismatched = await gateway.json("/v1/website-ownership/source-attestations/consume",
      envelope("source-attestation-consume", { ...consumePayload(), sourceUrl: "https://other.example/app" }), { token });
    assert.equal(mismatched.status, 400);
  } finally { await gateway.close(); }
});

test("a source attestation defaults to the well-known file method and honours an explicit method", async () => {
  const gateway = await startGateway(testEnvironment(), {
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
    ownershipVerifier: { verify: async () => ({ verified: true as const }) },
  });
  try {
    const defaulted = await gateway.json("/v1/website-ownership/source-attestations/issue", uiEnvelope("m0"), { token });
    assert.equal(defaulted.status, 200);
    assert.equal(defaulted.body?.method, "well_known");

    const dnsEnvelope = uiEnvelope("m1");
    (dnsEnvelope.source as Record<string, unknown>).method = "dns_txt";
    const dns = await gateway.json("/v1/website-ownership/source-attestations/issue", dnsEnvelope, { token });
    assert.equal(dns.status, 200);
    assert.equal(dns.body?.method, "dns_txt");

    const status = await gateway.json("/v1/website-ownership/source-attestations/status", uiEnvelope("m2"), { token });
    assert.equal(status.body?.method, "dns_txt", "the latest issued method is the pending one");

    const invalid = uiEnvelope("m3");
    (invalid.source as Record<string, unknown>).method = "ftp";
    const rejected = await gateway.json("/v1/website-ownership/source-attestations/issue", invalid, { token });
    assert.equal(rejected.status, 400);
  } finally { await gateway.close(); }
});
