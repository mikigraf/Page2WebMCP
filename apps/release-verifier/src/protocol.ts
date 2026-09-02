import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  canonicalVerifierJson,
  type LiveVerifierScope,
} from "../../control-plane/src/release-verifier-protocol-v2.ts";
import type { ReplayStore } from "./replay-store.ts";

/**
 * Server half of the release verifier protocol v2. The control plane's client half lives in
 * apps/control-plane/src/release-verifier-protocol-v2.ts; the canonical JSON encoder is imported
 * from there so both halves agree byte for byte.
 */

const HASH = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^hmac-sha256=([0-9a-f]{64})$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ENVIRONMENTS = new Set(["test", "staging", "production"]);
export const MAX_REQUEST_BYTES = 160 * 1_024;
export const MAX_RESPONSE_BYTES = 64 * 1_024;
export const MAX_LIFETIME_MS = 120_000;

export type VerifierOperation = "readiness" | "candidate" | "installation";

export type VerifiedVerifierRequest = Readonly<{
  ok: true;
  requestId: string;
  nonceDigest: string;
  operation: VerifierOperation;
  scope: LiveVerifierScope;
  payload: unknown;
  scopeDigest: string;
  payloadDigest: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type VerifierRequestRejection = Readonly<{
  ok: false;
  status: number;
  code: string;
}>;

export type VerifierRequestResult = VerifiedVerifierRequest | VerifierRequestRejection;

export function verifyVerifierRequest(input: Readonly<{
  operation: VerifierOperation;
  body: Uint8Array;
  authorization?: string | undefined;
  signature?: string | undefined;
  token: string;
  now: Date;
  replayStore: ReplayStore;
}>): VerifierRequestResult {
  const body = Buffer.from(input.body);
  if (body.byteLength > MAX_REQUEST_BYTES) return reject(413, "RELEASE_VERIFIER_REQUEST_TOO_LARGE");
  if (!validBearer(input.authorization, input.token)) return reject(401, "RELEASE_VERIFIER_UNAUTHORIZED");
  if (!validSignature(input.signature, body, input.token)) {
    return reject(401, "RELEASE_VERIFIER_SIGNATURE_INVALID");
  }
  const text = body.toString("utf8");
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
    if (canonicalVerifierJson(envelope) !== text) throw new Error("NON_CANONICAL");
  } catch {
    return reject(400, "RELEASE_VERIFIER_REQUEST_INVALID");
  }
  if (!plainRecord(envelope) || !exactKeys(envelope, [
    "expiresAt", "issuedAt", "nonce", "operation", "payload", "payloadDigest",
    "protocolVersion", "requestId", "schema", "scope", "scopeDigest",
  ]) || envelope.schema !== "ReleaseVerifierRequestV2" || envelope.protocolVersion !== 2
    || envelope.operation !== input.operation
    || typeof envelope.requestId !== "string" || !UUID_V4.test(envelope.requestId)
    || typeof envelope.nonce !== "string" || !NONCE.test(envelope.nonce)
    || typeof envelope.scopeDigest !== "string" || !HASH.test(envelope.scopeDigest)
    || typeof envelope.payloadDigest !== "string" || !HASH.test(envelope.payloadDigest)
    || !validTimestamp(envelope.issuedAt) || !validTimestamp(envelope.expiresAt)
    || !validScope(envelope.scope, input.operation)) {
    return reject(400, "RELEASE_VERIFIER_REQUEST_INVALID");
  }
  let scopeDigest: string;
  let payloadDigest: string;
  try {
    scopeDigest = sha256(canonicalVerifierJson(envelope.scope));
    payloadDigest = sha256(canonicalVerifierJson(envelope.payload));
  } catch {
    return reject(400, "RELEASE_VERIFIER_REQUEST_INVALID");
  }
  if (scopeDigest !== envelope.scopeDigest || payloadDigest !== envelope.payloadDigest) {
    return reject(400, "RELEASE_VERIFIER_REQUEST_INVALID");
  }
  const issuedAt = Date.parse(envelope.issuedAt as string);
  const expiresAt = Date.parse(envelope.expiresAt as string);
  const now = input.now.getTime();
  if (!Number.isFinite(now)) return reject(500, "RELEASE_VERIFIER_TIME_INVALID");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_MS) {
    return reject(400, "RELEASE_VERIFIER_REQUEST_LIFETIME_INVALID");
  }
  if (issuedAt > now) return reject(400, "RELEASE_VERIFIER_REQUEST_FUTURE");
  if (expiresAt <= now) return reject(400, "RELEASE_VERIFIER_REQUEST_EXPIRED");
  const nonceDigest = sha256(envelope.nonce as string);
  if (!input.replayStore.admit(`request:${envelope.requestId}`, expiresAt, now)
    || !input.replayStore.admit(`nonce:${nonceDigest}`, expiresAt, now)) {
    return reject(409, "RELEASE_VERIFIER_REQUEST_REPLAYED");
  }
  return Object.freeze({
    ok: true,
    requestId: envelope.requestId as string,
    nonceDigest,
    operation: input.operation,
    scope: envelope.scope as LiveVerifierScope,
    payload: envelope.payload,
    scopeDigest,
    payloadDigest,
    issuedAt: envelope.issuedAt as string,
    expiresAt: envelope.expiresAt as string,
  });
}

export function buildAttestationResponse(input: Readonly<{
  request: VerifiedVerifierRequest;
  report: unknown;
  token: string;
  now: Date;
  attestationId?: string;
}>): Readonly<{ body: string; signature: string }> {
  const requestIssuedAt = Date.parse(input.request.issuedAt);
  const requestExpiresAt = Date.parse(input.request.expiresAt);
  const clamped = Math.min(Math.max(input.now.getTime(), requestIssuedAt), requestExpiresAt - 1);
  if (!Number.isFinite(clamped) || clamped < requestIssuedAt) {
    throw new Error("RELEASE_VERIFIER_ATTESTATION_WINDOW_CLOSED");
  }
  const attestedAt = new Date(clamped).toISOString();
  const attestationId = input.attestationId ?? randomUUID();
  if (!UUID_V4.test(attestationId)) throw new Error("RELEASE_VERIFIER_ATTESTATION_INVALID");
  const envelope = {
    schema: "ReleaseVerifierAttestationV2" as const,
    protocolVersion: 2 as const,
    attestationId,
    requestId: input.request.requestId,
    nonceDigest: input.request.nonceDigest,
    operation: input.request.operation,
    scopeDigest: input.request.scopeDigest,
    payloadDigest: input.request.payloadDigest,
    issuedAt: attestedAt,
    expiresAt: input.request.expiresAt,
    attestedAt,
    report: input.report,
  };
  const body = canonicalVerifierJson(envelope);
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("RELEASE_VERIFIER_RESPONSE_TOO_LARGE");
  }
  return Object.freeze({ body, signature: sign(body, input.token) });
}

export function operationForPath(path: string): VerifierOperation | undefined {
  if (path === "/v2/readiness") return "readiness";
  if (path === "/v2/candidates/verify") return "candidate";
  if (path === "/v2/installations/verify") return "installation";
  return undefined;
}

function reject(status: number, code: string): VerifierRequestRejection {
  return Object.freeze({ ok: false, status, code });
}

function validBearer(value: unknown, token: string): boolean {
  const prefix = "Bearer ";
  if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  return constantTimeEqual(Buffer.from(value.slice(prefix.length), "utf8"), Buffer.from(token, "utf8"));
}

function validSignature(value: unknown, body: Uint8Array, token: string): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(SIGNATURE);
  if (!match) return false;
  const received = Buffer.from(match[1]!, "hex");
  const expected = Buffer.from(sign(body, token).slice("hmac-sha256=".length), "hex");
  return constantTimeEqual(received, expected);
}

function constantTimeEqual(received: Buffer, expected: Buffer): boolean {
  if (received.byteLength !== expected.byteLength) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(received, expected);
}

function sign(body: string | Uint8Array, token: string): string {
  return `hmac-sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validScope(value: unknown, operation: VerifierOperation): value is LiveVerifierScope {
  if (!plainRecord(value) || value.operation !== operation) return false;
  if (operation === "readiness") {
    return exactKeys(value, ["deploymentIdentityDigest", "operation"])
      && typeof value.deploymentIdentityDigest === "string" && HASH.test(value.deploymentIdentityDigest);
  }
  const common = typeof value.projectId === "string" && UUID_V4.test(value.projectId)
    && typeof value.sourceIdentityHash === "string" && HASH.test(value.sourceIdentityHash)
    && typeof value.targetOrigin === "string" && exactOrigin(value.targetOrigin)
    && typeof value.environment === "string" && ENVIRONMENTS.has(value.environment);
  if (!common) return false;
  if (operation === "candidate") {
    return exactKeys(value, [
      "analysisRunId", "contentHash", "environment", "operation", "projectId",
      "sourceIdentityHash", "targetOrigin",
    ]) && typeof value.analysisRunId === "string" && UUID_V4.test(value.analysisRunId)
      && typeof value.contentHash === "string" && HASH.test(value.contentHash);
  }
  return exactKeys(value, [
    "environment", "installationOperationId", "operation", "pageUrl", "projectId", "releaseId",
    "selectedHash", "sourceIdentityHash", "targetOrigin",
  ]) && typeof value.releaseId === "string" && UUID_V4.test(value.releaseId)
    && typeof value.installationOperationId === "string" && HASH.test(value.installationOperationId)
    && typeof value.selectedHash === "string" && HASH.test(value.selectedHash)
    && typeof value.pageUrl === "string" && exactPage(value.pageUrl, value.targetOrigin as string);
}

function exactOrigin(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.pathname === "/"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function exactPage(value: string, origin: string): boolean {
  if (value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === origin && !url.username && !url.password
      && !url.search && !url.hash && url.toString() === value;
  } catch {
    return false;
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value)
    && new Date(value).toISOString() === value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
