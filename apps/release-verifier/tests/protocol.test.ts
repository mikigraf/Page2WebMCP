import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import {
  buildLiveVerifierRequest,
  canonicalVerifierJson,
  verifyLiveVerifierResponse,
  type LiveVerifierScope,
} from "../../control-plane/src/release-verifier-protocol-v2.ts";
import { buildAttestationResponse, verifyVerifierRequest } from "../src/protocol.ts";
import { createMemoryReplayStore } from "../src/replay-store.ts";

const TOKEN = "verifier-secret-token-value-1234567890";
const NOW = new Date("2026-09-01T12:00:00.000Z");
const READINESS_SCOPE: LiveVerifierScope = {
  operation: "readiness",
  deploymentIdentityDigest: "d".repeat(64),
};

function clientRequest(scope: LiveVerifierScope = READINESS_SCOPE, payload: unknown = {}) {
  return buildLiveVerifierRequest({ operation: scope.operation, scope, payload, token: TOKEN }, { now: () => NOW });
}

function verify(overrides: Partial<Parameters<typeof verifyVerifierRequest>[0]> = {}) {
  const request = clientRequest();
  return verifyVerifierRequest({
    operation: "readiness",
    body: Buffer.from(request.body, "utf8"),
    authorization: `Bearer ${TOKEN}`,
    signature: request.signature,
    token: TOKEN,
    now: NOW,
    replayStore: createMemoryReplayStore(64),
    ...overrides,
  });
}

test("a genuine client request is accepted with its exact digests and identity", () => {
  const request = clientRequest();
  const verified = verify({ body: Buffer.from(request.body, "utf8"), signature: request.signature });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.requestId, request.context.requestId);
  assert.equal(verified.nonceDigest, request.context.nonceDigest);
  assert.equal(verified.operation, "readiness");
  assert.equal(verified.scopeDigest, request.context.scopeDigest);
  assert.equal(verified.payloadDigest, request.context.payloadDigest);
  assert.deepEqual(verified.scope, READINESS_SCOPE);
});

test("authentication and signature are both required and constant-time compared", () => {
  const request = clientRequest();
  const body = Buffer.from(request.body, "utf8");
  const wrongKeySignature = buildLiveVerifierRequest(
    { operation: "readiness", scope: READINESS_SCOPE, payload: {}, token: `${TOKEN}-other` },
    { now: () => NOW, randomUuid: () => request.context.requestId },
  ).signature;
  const cases: ReadonlyArray<readonly [string, Partial<Parameters<typeof verifyVerifierRequest>[0]>, string]> = [
    ["missing authorization", { authorization: undefined }, "RELEASE_VERIFIER_UNAUTHORIZED"],
    ["wrong token", { authorization: `Bearer ${TOKEN}x` }, "RELEASE_VERIFIER_UNAUTHORIZED"],
    ["missing signature", { signature: undefined }, "RELEASE_VERIFIER_SIGNATURE_INVALID"],
    ["wrong key signature", { signature: wrongKeySignature }, "RELEASE_VERIFIER_SIGNATURE_INVALID"],
    ["malformed signature", { signature: "hmac-sha256=zz" }, "RELEASE_VERIFIER_SIGNATURE_INVALID"],
    [
      "tampered byte",
      { body: Buffer.from(request.body.replace(READINESS_SCOPE.deploymentIdentityDigest, "e".repeat(64)), "utf8") },
      "RELEASE_VERIFIER_SIGNATURE_INVALID",
    ],
  ];
  for (const [name, override, code] of cases) {
    const result = verify({ body, signature: request.signature, ...override });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.code, code, name);
  }
});

test("envelope timing is enforced at the exact boundaries", () => {
  const request = clientRequest();
  const body = Buffer.from(request.body, "utf8");
  const expiresAt = new Date(Date.parse(request.context.expiresAt));
  assert.equal(verify({ body, signature: request.signature, now: new Date(expiresAt.getTime() - 1) }).ok, true);
  const expired = verify({ body, signature: request.signature, now: expiresAt });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, "RELEASE_VERIFIER_REQUEST_EXPIRED");
  const future = verify({ body, signature: request.signature, now: new Date(NOW.getTime() - 1) });
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.code, "RELEASE_VERIFIER_REQUEST_FUTURE");
});

test("an overlong lifetime, a wrong operation, and a mismatched digest are rejected", () => {
  const forged = (patch: Record<string, unknown>) => {
    const envelope = {
      schema: "ReleaseVerifierRequestV2",
      protocolVersion: 2,
      requestId: randomUUID(),
      nonce: Buffer.alloc(32, 7).toString("base64url"),
      operation: "readiness",
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      scope: READINESS_SCOPE,
      scopeDigest: createHash("sha256").update(canonicalVerifierJson(READINESS_SCOPE)).digest("hex"),
      payload: {},
      payloadDigest: createHash("sha256").update(canonicalVerifierJson({})).digest("hex"),
      ...patch,
    };
    return { encoded: canonicalVerifierJson(envelope) };
  };
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["overlong lifetime", { expiresAt: new Date(NOW.getTime() + 121_000).toISOString() },
      "RELEASE_VERIFIER_REQUEST_LIFETIME_INVALID"],
    ["scope digest mismatch", { scopeDigest: "a".repeat(64) }, "RELEASE_VERIFIER_REQUEST_INVALID"],
    ["payload digest mismatch", { payloadDigest: "b".repeat(64) }, "RELEASE_VERIFIER_REQUEST_INVALID"],
    ["operation mismatch", { operation: "candidate" }, "RELEASE_VERIFIER_REQUEST_INVALID"],
    ["unknown schema", { schema: "ReleaseVerifierRequestV1" }, "RELEASE_VERIFIER_REQUEST_INVALID"],
  ];
  for (const [name, patch, code] of cases) {
    const { encoded } = forged(patch);
    const body = Buffer.from(encoded, "utf8");
    const signature = clientSignature(encoded);
    const result = verify({ body, signature });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.code, code, name);
  }
});

test("non-canonical bodies are rejected", () => {
  const request = clientRequest();
  const reordered = JSON.stringify(JSON.parse(request.body), ["schema", "protocolVersion"]);
  const result = verify({ body: Buffer.from(reordered, "utf8"), signature: clientSignature(reordered) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "RELEASE_VERIFIER_REQUEST_INVALID");
});

test("a replayed requestId or nonce is refused once and forever within the store window", () => {
  const store = createMemoryReplayStore(64);
  const request = clientRequest();
  const body = Buffer.from(request.body, "utf8");
  assert.equal(verify({ body, signature: request.signature, replayStore: store }).ok, true);
  const replayed = verify({ body, signature: request.signature, replayStore: store });
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.equal(replayed.code, "RELEASE_VERIFIER_REQUEST_REPLAYED");

  const sameNonce = buildLiveVerifierRequest(
    { operation: "readiness", scope: READINESS_SCOPE, payload: {}, token: TOKEN },
    { now: () => NOW, randomBytes: () => Buffer.from(String(JSON.parse(request.body).nonce), "base64url") },
  );
  const nonceReplay = verify({
    body: Buffer.from(sameNonce.body, "utf8"),
    signature: sameNonce.signature,
    replayStore: store,
  });
  assert.equal(nonceReplay.ok, false);
  if (!nonceReplay.ok) assert.equal(nonceReplay.code, "RELEASE_VERIFIER_REQUEST_REPLAYED");
});

test("the signed attestation echoes every required field and the client accepts it", () => {
  const request = clientRequest();
  const verified = verify({ body: Buffer.from(request.body, "utf8"), signature: request.signature });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  const report = { mode: "live", protocolVersion: 2, webMcpImplementation: "native" };
  const attestedAt = new Date(NOW.getTime() + 1_500);
  const response = buildAttestationResponse({
    request: verified,
    report,
    token: TOKEN,
    now: attestedAt,
    attestationId: "55555555-5555-4555-8555-555555555555",
  });
  const parsed = JSON.parse(response.body) as Record<string, unknown>;
  assert.equal(parsed.schema, "ReleaseVerifierAttestationV2");
  assert.equal(parsed.protocolVersion, 2);
  assert.equal(parsed.requestId, request.context.requestId);
  assert.equal(parsed.nonceDigest, request.context.nonceDigest);
  assert.equal(parsed.operation, "readiness");
  assert.equal(parsed.scopeDigest, request.context.scopeDigest);
  assert.equal(parsed.payloadDigest, request.context.payloadDigest);
  assert.deepEqual(parsed.report, report);
  assert.ok(Date.parse(parsed.issuedAt as string) >= Date.parse(request.context.issuedAt));
  assert.ok(Date.parse(parsed.expiresAt as string) <= Date.parse(request.context.expiresAt));

  const accepted = verifyLiveVerifierResponse({
    body: Buffer.from(response.body, "utf8"),
    signature: response.signature,
    token: TOKEN,
    request: request.context,
  }, { now: () => attestedAt, replayGuard: { admit: () => true } });
  assert.deepEqual(accepted.report, report);
  assert.equal(accepted.attestation.attestationId, "55555555-5555-4555-8555-555555555555");
});

test("two attestations for the same request carry distinct attestation identifiers", () => {
  const request = clientRequest();
  const verified = verify({ body: Buffer.from(request.body, "utf8"), signature: request.signature });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  const first = buildAttestationResponse({ request: verified, report: {}, token: TOKEN, now: NOW });
  const second = buildAttestationResponse({ request: verified, report: {}, token: TOKEN, now: NOW });
  assert.notEqual(
    (JSON.parse(first.body) as { attestationId: string }).attestationId,
    (JSON.parse(second.body) as { attestationId: string }).attestationId,
  );
});

function clientSignature(body: string): string {
  return `hmac-sha256=${createHmac("sha256", TOKEN).update(body).digest("hex")}`;
}
