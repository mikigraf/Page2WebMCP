import { createHash, createHmac, randomBytes as nodeRandomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const HASH = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^hmac-sha256=([0-9a-f]{64})$/;
const ENVIRONMENTS = new Set(["test", "staging", "production"]);
const MAX_REQUEST_BYTES = 160 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_LIFETIME_MS = 60_000;
const MAX_LIFETIME_MS = 120_000;
const MAX_REPLAY_ENTRIES = 4_096;

export type LiveVerifierScope = Readonly<
  | {
    operation: "readiness";
    deploymentIdentityDigest: string;
  }
  | {
    operation: "candidate";
    projectId: string;
    analysisRunId: string;
    sourceIdentityHash: string;
    targetOrigin: string;
    environment: "test" | "staging" | "production";
    contentHash: string;
  }
  | {
    operation: "installation";
    projectId: string;
    releaseId: string;
    installationOperationId: string;
    sourceIdentityHash: string;
    pageUrl: string;
    targetOrigin: string;
    environment: "test" | "staging" | "production";
    selectedHash: string;
  }
>;

export type LiveVerifierRequestContext = Readonly<{
  requestId: string;
  nonceDigest: string;
  operation: LiveVerifierScope["operation"];
  scopeDigest: string;
  payloadDigest: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type LiveVerifierAttestationIdentityV2 = Readonly<{
  protocolVersion: 2;
  attestationId: string;
  requestId: string;
  nonceDigest: string;
  operation: LiveVerifierScope["operation"];
  scopeDigest: string;
  payloadDigest: string;
  issuedAt: string;
  expiresAt: string;
  attestedAt: string;
}>;

export type LiveVerifierReplayGuard = Readonly<{
  admit(attestationId: string, expiresAt: number, now: number): boolean;
}>;

type BuildDependencies = Readonly<{
  now?: () => Date;
  randomUuid?: () => string;
  randomBytes?: () => Uint8Array;
}>;

type VerifyDependencies = Readonly<{
  now?: () => Date;
  replayGuard?: LiveVerifierReplayGuard;
}>;

const processReplayGuard = createLiveVerifierReplayGuard();

export function buildLiveVerifierRequest(input: Readonly<{
  operation: LiveVerifierScope["operation"];
  scope: LiveVerifierScope;
  payload: unknown;
  token: string;
}>, dependencies: BuildDependencies = {}): Readonly<{
  body: string;
  signature: string;
  context: LiveVerifierRequestContext;
}> {
  if (!validToken(input?.token) || !validScope(input?.scope, input?.operation)) {
    throw new Error("RELEASE_VERIFIER_REQUEST_INVALID");
  }
  const now = exactDate((dependencies.now ?? (() => new Date()))());
  const requestId = (dependencies.randomUuid ?? randomUUID)();
  const nonceBytes = Buffer.from((dependencies.randomBytes ?? (() => nodeRandomBytes(32)))());
  if (!UUID_V4.test(requestId) || nonceBytes.byteLength !== 32) {
    throw new Error("RELEASE_VERIFIER_REQUEST_INVALID");
  }
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + REQUEST_LIFETIME_MS).toISOString();
  let scopeDigest: string;
  let payloadDigest: string;
  try {
    scopeDigest = sha256(canonicalVerifierJson(input.scope));
    payloadDigest = sha256(canonicalVerifierJson(input.payload));
  } catch {
    throw new Error("RELEASE_VERIFIER_REQUEST_INVALID");
  }
  const nonce = nonceBytes.toString("base64url");
  const envelope = {
    schema: "ReleaseVerifierRequestV2" as const,
    protocolVersion: 2 as const,
    requestId,
    nonce,
    operation: input.operation,
    issuedAt,
    expiresAt,
    scope: input.scope,
    scopeDigest,
    payload: input.payload,
    payloadDigest,
  };
  let body: string;
  try { body = canonicalVerifierJson(envelope); }
  catch { throw new Error("RELEASE_VERIFIER_REQUEST_INVALID"); }
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("RELEASE_VERIFIER_REQUEST_INVALID");
  }
  const context = Object.freeze({
    requestId,
    nonceDigest: sha256(nonce),
    operation: input.operation,
    scopeDigest,
    payloadDigest,
    issuedAt,
    expiresAt,
  });
  return Object.freeze({ body, signature: sign(body, input.token), context });
}

export function verifyLiveVerifierResponse(input: Readonly<{
  body: Uint8Array;
  signature?: string;
  token: string;
  request: LiveVerifierRequestContext;
}>, dependencies: VerifyDependencies = {}): Readonly<{
  report: unknown;
  attestation: LiveVerifierAttestationIdentityV2;
}> {
  if (!validToken(input?.token) || !(input?.body instanceof Uint8Array)
    || input.body.byteLength < 2 || input.body.byteLength > MAX_RESPONSE_BYTES
    || !validRequestContext(input.request)) {
    throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
  }
  const body = Buffer.from(input.body);
  if (!validSignature(input.signature, body, input.token)) {
    throw new Error("RELEASE_VERIFIER_RESPONSE_SIGNATURE_INVALID");
  }
  let parsed: unknown;
  const text = body.toString("utf8");
  try {
    parsed = JSON.parse(text);
    if (canonicalVerifierJson(parsed) !== text) throw new Error("NON_CANONICAL");
  } catch {
    throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
  }
  if (!plainRecord(parsed) || !exactKeys(parsed, [
    "attestationId", "attestedAt", "expiresAt", "issuedAt", "nonceDigest", "operation",
    "payloadDigest", "protocolVersion", "report", "requestId", "schema", "scopeDigest",
  ]) || parsed.schema !== "ReleaseVerifierAttestationV2" || parsed.protocolVersion !== 2
    || typeof parsed.attestationId !== "string" || !UUID_V4.test(parsed.attestationId)
    || typeof parsed.requestId !== "string" || !UUID_V4.test(parsed.requestId)
    || typeof parsed.nonceDigest !== "string" || !HASH.test(parsed.nonceDigest)
    || !["readiness", "candidate", "installation"].includes(String(parsed.operation))
    || typeof parsed.scopeDigest !== "string" || !HASH.test(parsed.scopeDigest)
    || typeof parsed.payloadDigest !== "string" || !HASH.test(parsed.payloadDigest)
    || !validTimestamp(parsed.issuedAt) || !validTimestamp(parsed.expiresAt)
    || !validTimestamp(parsed.attestedAt)) {
    throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
  }
  const now = exactDate((dependencies.now ?? (() => new Date()))()).getTime();
  const requestIssuedAt = Date.parse(input.request.issuedAt);
  const requestExpiresAt = Date.parse(input.request.expiresAt);
  const issuedAt = Date.parse(parsed.issuedAt as string);
  const expiresAt = Date.parse(parsed.expiresAt as string);
  const attestedAt = Date.parse(parsed.attestedAt as string);
  if (issuedAt > now || attestedAt > now) throw new Error("RELEASE_VERIFIER_RESPONSE_FUTURE");
  if (expiresAt <= now) throw new Error("RELEASE_VERIFIER_RESPONSE_EXPIRED");
  if (requestExpiresAt <= now) throw new Error("RELEASE_VERIFIER_RESPONSE_EXPIRED");
  if (issuedAt < requestIssuedAt || expiresAt > requestExpiresAt
    || expiresAt - issuedAt > MAX_LIFETIME_MS || attestedAt < issuedAt || attestedAt > expiresAt) {
    throw new Error("RELEASE_VERIFIER_RESPONSE_TIMELINE_INVALID");
  }
  if (parsed.requestId !== input.request.requestId
    || parsed.nonceDigest !== input.request.nonceDigest
    || parsed.operation !== input.request.operation
    || parsed.scopeDigest !== input.request.scopeDigest
    || parsed.payloadDigest !== input.request.payloadDigest) {
    throw new Error("RELEASE_VERIFIER_RESPONSE_CONTEXT_MISMATCH");
  }
  const guard = dependencies.replayGuard ?? processReplayGuard;
  if (!guard.admit(parsed.attestationId, expiresAt, now)) {
    throw new Error("RELEASE_VERIFIER_RESPONSE_REPLAYED");
  }
  const attestation: LiveVerifierAttestationIdentityV2 = Object.freeze({
    protocolVersion: 2,
    attestationId: parsed.attestationId,
    requestId: parsed.requestId,
    nonceDigest: parsed.nonceDigest,
    operation: parsed.operation as LiveVerifierScope["operation"],
    scopeDigest: parsed.scopeDigest,
    payloadDigest: parsed.payloadDigest,
    issuedAt: parsed.issuedAt as string,
    expiresAt: parsed.expiresAt as string,
    attestedAt: parsed.attestedAt as string,
  });
  return Object.freeze({ report: parsed.report, attestation });
}

export function createLiveVerifierReplayGuard(maxEntries = MAX_REPLAY_ENTRIES): LiveVerifierReplayGuard {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_REPLAY_ENTRIES) {
    throw new Error("RELEASE_VERIFIER_REPLAY_CONFIGURATION_INVALID");
  }
  const admitted = new Map<string, number>();
  return Object.freeze({
    admit(attestationId, expiresAt, now) {
      for (const [id, expiry] of admitted) if (expiry <= now) admitted.delete(id);
      if (admitted.has(attestationId)) return false;
      if (admitted.size >= maxEntries) return false;
      admitted.set(attestationId, expiresAt);
      return true;
    },
  });
}

export function canonicalVerifierJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalVerifierJson).join(",")}]`;
  if (plainRecord(value)) {
    const entries = Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error("CANONICAL_JSON_INVALID");
      return `${JSON.stringify(key)}:${canonicalVerifierJson(value[key])}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new Error("CANONICAL_JSON_INVALID");
}

function validScope(value: unknown, operation: unknown): value is LiveVerifierScope {
  if (!plainRecord(value) || value.operation !== operation) return false;
  if (operation === "readiness") {
    return exactKeys(value, ["deploymentIdentityDigest", "operation"])
      && value.operation === "readiness" && typeof value.deploymentIdentityDigest === "string"
      && HASH.test(value.deploymentIdentityDigest);
  }
  const common = typeof value.projectId === "string" && UUID_V4.test(value.projectId)
    && typeof value.sourceIdentityHash === "string" && HASH.test(value.sourceIdentityHash)
    && typeof value.targetOrigin === "string" && exactHttpsOrigin(value.targetOrigin)
    && typeof value.environment === "string" && ENVIRONMENTS.has(value.environment);
  if (!common) return false;
  if (operation === "candidate") {
    return exactKeys(value, [
      "analysisRunId", "contentHash", "environment", "operation", "projectId", "sourceIdentityHash", "targetOrigin",
    ]) && value.operation === "candidate"
      && typeof value.analysisRunId === "string" && UUID_V4.test(value.analysisRunId)
      && typeof value.contentHash === "string" && HASH.test(value.contentHash);
  }
  if (operation !== "installation") return false;
  return exactKeys(value, [
    "environment", "installationOperationId", "operation", "pageUrl", "projectId", "releaseId",
    "selectedHash", "sourceIdentityHash", "targetOrigin",
  ]) && value.operation === "installation"
    && typeof value.releaseId === "string" && UUID_V4.test(value.releaseId)
    && typeof value.installationOperationId === "string" && HASH.test(value.installationOperationId)
    && typeof value.selectedHash === "string" && HASH.test(value.selectedHash)
    && typeof value.pageUrl === "string" && exactHttpsPage(value.pageUrl, value.targetOrigin as string);
}

function validRequestContext(value: unknown): value is LiveVerifierRequestContext {
  return plainRecord(value) && exactKeys(value, [
    "expiresAt", "issuedAt", "nonceDigest", "operation", "payloadDigest", "requestId", "scopeDigest",
  ]) && typeof value.requestId === "string" && UUID_V4.test(value.requestId)
    && typeof value.nonceDigest === "string" && HASH.test(value.nonceDigest)
    && ["readiness", "candidate", "installation"].includes(String(value.operation))
    && typeof value.scopeDigest === "string" && HASH.test(value.scopeDigest)
    && typeof value.payloadDigest === "string" && HASH.test(value.payloadDigest)
    && validTimestamp(value.issuedAt) && validTimestamp(value.expiresAt)
    && Date.parse(value.expiresAt as string) > Date.parse(value.issuedAt as string)
    && Date.parse(value.expiresAt as string) - Date.parse(value.issuedAt as string) <= MAX_LIFETIME_MS;
}

function exactHttpsOrigin(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.pathname === "/"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function exactHttpsPage(value: string, origin: string): boolean {
  if (value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === origin && !url.username && !url.password
      && !url.search && !url.hash && url.toString() === value;
  } catch { return false; }
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && /^[\u0021-\u007e]+$/.test(value) && !/[\r\n]/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("RELEASE_VERIFIER_TIME_INVALID");
  }
  return value;
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

function sign(body: string | Uint8Array, token: string): string {
  return `hmac-sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
}

function validSignature(value: unknown, body: Uint8Array, token: string): boolean {
  if (typeof value !== "string") return false;
  const match = SIGNATURE.exec(value);
  if (!match) return false;
  const received = Buffer.from(match[1]!, "hex");
  const expected = Buffer.from(sign(body, token).slice("hmac-sha256=".length), "hex");
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
