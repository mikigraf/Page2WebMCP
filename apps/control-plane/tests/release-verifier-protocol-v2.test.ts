import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  buildLiveVerifierRequest,
  canonicalVerifierJson,
  createLiveVerifierReplayGuard,
  verifyLiveVerifierResponse,
  type LiveVerifierScope,
} from "../src/release-verifier-protocol-v2.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const TOKEN = "verifier-secret-token-value-1234567890";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const ATTESTATION_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = Buffer.alloc(32, 7);
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const candidateScope: LiveVerifierScope = {
  operation: "candidate",
  projectId: "33333333-3333-4333-8333-333333333333",
  analysisRunId: "44444444-4444-4444-8444-444444444444",
  sourceIdentityHash: OTHER_HASH,
  targetOrigin: "https://staging.widgets.dev",
  environment: "staging",
  contentHash: HASH,
};

function request() {
  return buildLiveVerifierRequest({
    operation: "candidate",
    scope: candidateScope,
    payload: { contentHash: HASH, expectedTools: ["list_widgets"] },
    token: TOKEN,
  }, {
    now: () => NOW,
    randomUuid: () => REQUEST_ID,
    randomBytes: () => NONCE,
  });
}

function signedResponse(context = request(), overrides: Record<string, unknown> = {}) {
  const body = Buffer.from(canonicalVerifierJson({
    schema: "ReleaseVerifierAttestationV2",
    protocolVersion: 2,
    attestationId: ATTESTATION_ID,
    requestId: context.context.requestId,
    nonceDigest: context.context.nonceDigest,
    operation: context.context.operation,
    scopeDigest: context.context.scopeDigest,
    payloadDigest: context.context.payloadDigest,
    issuedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-01T12:01:00.000Z",
    attestedAt: "2026-09-01T12:00:01.000Z",
    report: { native: true, selectedHash: HASH },
    ...overrides,
  }));
  return {
    context,
    body,
    signature: `hmac-sha256=${createHmac("sha256", TOKEN).update(body).digest("hex")}`,
  };
}

test("live verifier v2 signs one canonical bounded request with exact scope and payload digests", () => {
  const built = request();
  assert.equal(built.signature, `hmac-sha256=${createHmac("sha256", TOKEN).update(built.body).digest("hex")}`);
  assert.doesNotMatch(built.body, new RegExp(TOKEN));
  assert.deepEqual(JSON.parse(built.body), {
    schema: "ReleaseVerifierRequestV2",
    protocolVersion: 2,
    requestId: REQUEST_ID,
    nonce: NONCE.toString("base64url"),
    operation: "candidate",
    issuedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-01T12:01:00.000Z",
    scope: candidateScope,
    scopeDigest: built.context.scopeDigest,
    payload: { contentHash: HASH, expectedTools: ["list_widgets"] },
    payloadDigest: built.context.payloadDigest,
  });
  assert.match(built.context.nonceDigest, /^[0-9a-f]{64}$/);
});

test("live verifier v2 authenticates exact response bytes and accepts one exact fresh echo", () => {
  const response = signedResponse();
  const verified = verifyLiveVerifierResponse({
    body: response.body,
    signature: response.signature,
    token: TOKEN,
    request: response.context.context,
  }, { now: () => new Date("2026-09-01T12:00:02.000Z") });
  assert.deepEqual(verified.report, { native: true, selectedHash: HASH });
  assert.equal(verified.attestation.attestationId, ATTESTATION_ID);
  assert.equal(verified.attestation.scopeDigest, response.context.context.scopeDigest);
});

test("live verifier v2 rejects missing/wrong signatures, byte changes, and replay", () => {
  const replayGuard = createLiveVerifierReplayGuard();
  const response = signedResponse();
  const input = { body: response.body, signature: response.signature, token: TOKEN, request: response.context.context };
  assert.doesNotThrow(() => verifyLiveVerifierResponse(input, {
    now: () => new Date("2026-09-01T12:00:02.000Z"), replayGuard,
  }));
  assert.throws(() => verifyLiveVerifierResponse(input, {
    now: () => new Date("2026-09-01T12:00:03.000Z"), replayGuard,
  }), /RELEASE_VERIFIER_RESPONSE_REPLAYED/);
  for (const mutation of [
    { ...input, signature: undefined },
    { ...input, signature: `hmac-sha256=${"0".repeat(64)}` },
    { ...input, body: Buffer.concat([response.body, Buffer.from(" ")]) },
  ]) assert.throws(() => verifyLiveVerifierResponse(mutation, {
    now: () => new Date("2026-09-01T12:00:02.000Z"), replayGuard: createLiveVerifierReplayGuard(),
  }), /RELEASE_VERIFIER_RESPONSE_(?:SIGNATURE_INVALID|INVALID)/);
});

test("live verifier v2 rejects expired, future, overlong, and mismatched response attestations", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ expiresAt: "2026-09-01T12:00:01.000Z" }, "EXPIRED"],
    [{ issuedAt: "2026-09-01T12:00:03.000Z", attestedAt: "2026-09-01T12:00:03.000Z" }, "FUTURE"],
    [{ expiresAt: "2026-09-01T12:03:00.000Z" }, "TIMELINE_INVALID"],
    [{ attestedAt: "2026-09-01T12:01:00.000Z" }, "FUTURE"],
    [{ requestId: "55555555-5555-4555-8555-555555555555" }, "CONTEXT_MISMATCH"],
    [{ nonceDigest: OTHER_HASH }, "CONTEXT_MISMATCH"],
    [{ operation: "installation" }, "CONTEXT_MISMATCH"],
    [{ scopeDigest: OTHER_HASH }, "CONTEXT_MISMATCH"],
    [{ payloadDigest: OTHER_HASH }, "CONTEXT_MISMATCH"],
  ];
  for (const [overrides, code] of cases) {
    const response = signedResponse(request(), overrides);
    assert.throws(() => verifyLiveVerifierResponse({
      body: response.body,
      signature: response.signature,
      token: TOKEN,
      request: response.context.context,
    }, { now: () => new Date("2026-09-01T12:00:02.000Z") }), new RegExp(`RELEASE_VERIFIER_RESPONSE_${code}`));
  }
});

test("live verifier v2 treats the exact expiry instant as expired", () => {
  const response = signedResponse();
  assert.throws(() => verifyLiveVerifierResponse({
    body: response.body,
    signature: response.signature,
    token: TOKEN,
    request: response.context.context,
  }, { now: () => new Date("2026-09-01T12:01:00.000Z") }), /RELEASE_VERIFIER_RESPONSE_EXPIRED/);
});

test("live verifier v2 scope validation rejects wrong hash, origin, environment, and operation fields", () => {
  const invalid = [
    { ...candidateScope, contentHash: "A".repeat(64) },
    { ...candidateScope, targetOrigin: "http://staging.widgets.dev" },
    { ...candidateScope, targetOrigin: "https://staging.widgets.dev/path" },
    { ...candidateScope, environment: "preview" },
    { ...candidateScope, releaseId: "55555555-5555-4555-8555-555555555555" },
  ];
  for (const scope of invalid) assert.throws(() => buildLiveVerifierRequest({
    operation: "candidate",
    scope: scope as LiveVerifierScope,
    payload: {},
    token: TOKEN,
  }, { now: () => NOW, randomUuid: () => REQUEST_ID, randomBytes: () => NONCE }),
  /RELEASE_VERIFIER_REQUEST_INVALID/);
});
