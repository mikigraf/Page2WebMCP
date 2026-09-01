import { createHash } from "node:crypto";
import {
  createNodePinnedJsonTransport,
  type NodePinnedJsonResponse,
  type NodePinnedJsonTransport,
} from "../../worker/src/node-network.ts";
import { validateTargetUrl } from "../../../packages/security/src/security.ts";

const CONTROL_PROTOCOL_VERSION = 1;
const CONTROL_DEADLINE_MS = 10_000;
const MAX_CONTROL_BYTES = 64 * 1_024;
const MAX_OWNERSHIP_CHALLENGE_TTL_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export const WEBSITE_USER_HANDOFF_PATHS = Object.freeze({
  // These are additive Page2WebMCP control-store endpoints, not Browser Use
  // Cloud endpoints, and they never receive the Browser Use API key. They
  // leave the worker's established `challenges/load` request/response schema
  // unchanged. A verified immutable source attestation is consumed and bound
  // to the worker's exact analysis run before that legacy challenge is loaded.
  // An older control service that lacks an additive path is rejected with
  // WEBSITE_HANDOFF_PROTOCOL_UNSUPPORTED.
  ownershipStatus: "/v1/website-ownership/source-attestations/status",
  ownershipChallenge: "/v1/website-ownership/source-attestations/issue",
  ownershipCheck: "/v1/website-ownership/source-attestations/check",
} as const);

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type WebsiteUserHandoffBinding = Readonly<{
  organizationId: string;
  projectId: string;
  projectSourceId: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  sourceUrl: string;
  targetOrigin: string;
}>;

export type WebsiteOwnershipState =
  | Readonly<{
    state: "pending";
    method: "dns_txt";
    targetOrigin: string;
    expiresAt: string;
    instructions: Readonly<{ recordName: string; recordType: "TXT"; recordValue: string }>;
  }>
  | Readonly<{
    state: "pending";
    method: "well_known";
    targetOrigin: string;
    expiresAt: string;
    instructions: Readonly<{ url: string; content: string }>;
  }>
  | Readonly<{
    state: "verified" | "expired" | "failed" | "missing";
    targetOrigin: string;
    expiresAt?: string;
  }>;

export interface WebsiteUserHandoffPort {
  ownershipStatus(binding: WebsiteUserHandoffBinding, signal: AbortSignal): Promise<WebsiteOwnershipState>;
  issueOwnershipChallenge(
    binding: WebsiteUserHandoffBinding,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<WebsiteOwnershipState>;
  checkOwnership(
    binding: WebsiteUserHandoffBinding,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<WebsiteOwnershipState>;
}

export type WebsiteUserHandoffDependencies = Readonly<{
  transport?: NodePinnedJsonTransport;
  clock?: () => Date;
  deadlineMs?: number;
}>;

type HandoffConfiguration = Readonly<{
  ownershipOrigin: string;
  ownershipToken: string;
}>;

let testPort: WebsiteUserHandoffPort | undefined;

export function setWebsiteUserHandoffPortForTest(port: WebsiteUserHandoffPort | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_ADAPTER_FORBIDDEN");
  testPort = port;
}

export function websiteUserHandoffPort(): WebsiteUserHandoffPort {
  return testPort ?? createConfiguredWebsiteUserHandoffPort(process.env);
}

export function createConfiguredWebsiteUserHandoffPort(
  environment: RuntimeEnvironment = process.env,
  dependencies: WebsiteUserHandoffDependencies = {},
): WebsiteUserHandoffPort {
  const configuration = configuredEnvironment(environment);
  const transport = dependencies.transport ?? createNodePinnedJsonTransport();
  const clock = dependencies.clock ?? (() => new Date());
  const deadlineMs = dependencies.deadlineMs ?? CONTROL_DEADLINE_MS;
  if (!transport || typeof transport.request !== "function" || typeof clock !== "function"
    || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > CONTROL_DEADLINE_MS) {
    throw stableError("WEBSITE_LIVE_CONFIGURATION_REQUIRED");
  }

  const ownershipRequest = async (
    path: string,
    operation: string,
    binding: WebsiteUserHandoffBinding,
    callerKey: string,
    signal: AbortSignal,
  ): Promise<WebsiteOwnershipState> => {
    const normalized = validateBinding(binding);
    const request = sourceControlEnvelope(normalized, operation, callerKey);
    const response = await requestControl(
      transport,
      configuration.ownershipOrigin,
      configuration.ownershipToken,
      path,
      request,
      signal,
      deadlineMs,
    );
    assertSourceResponseEnvelope(response, request);
    return ownershipState(response, normalized, clock());
  };

  return {
    ownershipStatus: (binding, signal) => ownershipRequest(
      WEBSITE_USER_HANDOFF_PATHS.ownershipStatus,
      "ownership-status",
      binding,
      `status:${binding.sourceIdentityHash}`,
      signal,
    ),
    issueOwnershipChallenge: (binding, idempotencyKey, signal) => ownershipRequest(
      WEBSITE_USER_HANDOFF_PATHS.ownershipChallenge,
      "ownership-challenge",
      binding,
      idempotencyKey,
      signal,
    ),
    checkOwnership: (binding, idempotencyKey, signal) => ownershipRequest(
      WEBSITE_USER_HANDOFF_PATHS.ownershipCheck,
      "ownership-check",
      binding,
      idempotencyKey,
      signal,
    ),
  };
}

function configuredEnvironment(environment: RuntimeEnvironment): HandoffConfiguration {
  const ownershipOrigin = exactHttpsOrigin(environment.PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN);
  const ownershipToken = boundedToken(environment.PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN);
  if (!ownershipOrigin || !ownershipToken) {
    throw stableError("WEBSITE_LIVE_CONFIGURATION_REQUIRED");
  }
  return { ownershipOrigin, ownershipToken };
}

function exactHttpsOrigin(value: string | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return validateTargetUrl(value).ok && url.protocol === "https:" && !url.username && !url.password
      && !url.search && !url.hash && url.origin === value && url.href === `${value}/`
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedToken(value: string | undefined): string | undefined {
  return value && value.length >= 32 && value.length <= 4_096 && /^[\u0021-\u007e]+$/.test(value)
    ? value
    : undefined;
}

function validateBinding(binding: WebsiteUserHandoffBinding): WebsiteUserHandoffBinding {
  if (!binding || !UUID.test(binding.organizationId) || !UUID.test(binding.projectId)
    || !UUID.test(binding.projectSourceId) || !UUID.test(binding.sourceSnapshotId)
    || !HASH.test(binding.sourceIdentityHash)
    || !validateTargetUrl(binding.sourceUrl).ok) throw stableError("WEBSITE_HANDOFF_INPUT_INVALID");
  let source: URL;
  try { source = new URL(binding.sourceUrl); } catch { throw stableError("WEBSITE_HANDOFF_INPUT_INVALID"); }
  if (source.protocol !== "https:" || source.search || source.hash || source.origin !== binding.targetOrigin
    || exactHttpsOrigin(binding.targetOrigin) !== binding.targetOrigin) {
    throw stableError("WEBSITE_HANDOFF_INPUT_INVALID");
  }
  return { ...binding, sourceUrl: binding.sourceUrl, targetOrigin: source.origin };
}

function sourceControlEnvelope(
  binding: WebsiteUserHandoffBinding,
  operation: string,
  callerKey: string,
): Record<string, unknown> {
  if (!IDEMPOTENCY_KEY.test(callerKey)) throw stableError("WEBSITE_HANDOFF_INPUT_INVALID");
  const idempotencyKey = `website-ui:${createHash("sha256").update([
    binding.organizationId,
    binding.projectId,
    binding.projectSourceId,
    binding.sourceSnapshotId,
    binding.sourceIdentityHash,
    operation,
    callerKey,
  ].join("\0"), "utf8").digest("hex")}`;
  return {
    gatewayProtocolVersion: CONTROL_PROTOCOL_VERSION,
    idempotencyKey,
    scope: {
      organizationId: binding.organizationId,
      projectId: binding.projectId,
    },
    source: {
      projectSourceId: binding.projectSourceId,
      sourceSnapshotId: binding.sourceSnapshotId,
      sourceIdentityHash: binding.sourceIdentityHash,
      sourceUrl: binding.sourceUrl,
      targetOrigin: binding.targetOrigin,
    },
  };
}

async function requestControl(
  transport: NodePinnedJsonTransport,
  origin: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  callerSignal: AbortSignal,
  deadlineMs: number,
): Promise<Record<string, unknown>> {
  if (!(callerSignal instanceof AbortSignal) || callerSignal.aborted || !path.startsWith("/v1/")) {
    throw stableError("WEBSITE_HANDOFF_INPUT_INVALID");
  }
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_BYTES) throw stableError("WEBSITE_HANDOFF_INPUT_INVALID");
  const lifecycle = linkedSignal(callerSignal, deadlineMs);
  const url = `${origin}${path}`;
  try {
    const response = await transport.request({
      url,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: encoded,
      signal: lifecycle.signal,
    });
    if (response.url === url && [404, 405, 501].includes(response.status)) {
      throw stableError("WEBSITE_HANDOFF_PROTOCOL_UNSUPPORTED");
    }
    if (response.url !== url || response.status !== 200
      || mediaType(response.headers["content-type"]) !== "application/json") {
      throw stableError("WEBSITE_HANDOFF_UNAVAILABLE");
    }
    return boundedJson(response);
  } catch (error) {
    if (error instanceof Error && /^WEBSITE_HANDOFF_[A-Z0-9_]+$/.test(error.message)) throw error;
    throw stableError(lifecycle.timedOut() ? "WEBSITE_HANDOFF_TIMEOUT" : "WEBSITE_HANDOFF_UNAVAILABLE");
  } finally {
    lifecycle.dispose();
  }
}

function boundedJson(response: NodePinnedJsonResponse): Record<string, unknown> {
  const declared = response.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_CONTROL_BYTES)
    || !(response.body instanceof Uint8Array) || response.body.byteLength > MAX_CONTROL_BYTES) {
    throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
  catch { throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  }
  return parsed as Record<string, unknown>;
}

const SOURCE_ENVELOPE_KEYS = ["gatewayProtocolVersion", "idempotencyKey", "scope", "source"] as const;
function assertEnvelopeKeys(
  response: Record<string, unknown>,
  request: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (canonicalJson(response[key]) !== canonicalJson(request[key])) {
      throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
    }
  }
}

function assertSourceResponseEnvelope(response: Record<string, unknown>, request: Record<string, unknown>): void {
  assertEnvelopeKeys(response, request, SOURCE_ENVELOPE_KEYS);
}

function ownershipState(
  response: Record<string, unknown>,
  binding: WebsiteUserHandoffBinding,
  now: Date,
): WebsiteOwnershipState {
  const state = response.state;
  if (!["missing", "pending", "verified", "expired", "failed"].includes(String(state))) {
    throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  }
  if (response.targetOrigin !== binding.targetOrigin) throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  if (state !== "pending") {
    assertExactKeys(response, responseKeys(SOURCE_ENVELOPE_KEYS, ["state", "targetOrigin", "expiresAt"]));
    const expiresAt = optionalExpiry(response.expiresAt, now, false, MAX_OWNERSHIP_CHALLENGE_TTL_MS);
    return {
      state: state as "verified" | "expired" | "failed" | "missing",
      targetOrigin: binding.targetOrigin,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  assertExactKeys(response, responseKeys(
    SOURCE_ENVELOPE_KEYS,
    ["state", "method", "token", "targetOrigin", "expiresAt"],
  ));
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(response.token ?? ""))) {
    throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  }
  const expiresAt = optionalExpiry(response.expiresAt, now, true, MAX_OWNERSHIP_CHALLENGE_TTL_MS)!;
  const token = String(response.token);
  if (response.method === "dns_txt") {
    return {
      state: "pending",
      method: "dns_txt",
      targetOrigin: binding.targetOrigin,
      expiresAt,
      instructions: {
        recordName: `_page2webmcp.${new URL(binding.targetOrigin).hostname}`,
        recordType: "TXT",
        recordValue: `page2webmcp-verification=${token};origin=${binding.targetOrigin};expires=${expiresAt}`,
      },
    };
  }
  if (response.method === "well_known") {
    return {
      state: "pending",
      method: "well_known",
      targetOrigin: binding.targetOrigin,
      expiresAt,
      instructions: {
        url: `${binding.targetOrigin}/.well-known/page2webmcp-verification.txt`,
        content: `page2webmcp-verification=${token}\norigin=${binding.targetOrigin}\nexpires=${expiresAt}\n`,
      },
    };
  }
  throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
}

function responseKeys(envelope: readonly string[], extra: readonly string[]): Set<string> {
  return new Set([...envelope, ...extra]);
}

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  }
}

function optionalExpiry(value: unknown, now: Date, requireFuture: boolean, maximumTtlMs: number): string | undefined {
  if (value === undefined) {
    if (requireFuture) throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
    return undefined;
  }
  if (typeof value !== "string") throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || requireFuture && (parsed <= now.getTime() || parsed - now.getTime() > maximumTtlMs)) {
    throw stableError("WEBSITE_HANDOFF_RESPONSE_INVALID");
  }
  return new Date(parsed).toISOString();
}

function linkedSignal(parent: AbortSignal, deadlineMs: number): Readonly<{
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}> {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort(parent.reason ?? stableError("WEBSITE_HANDOFF_ABORTED"));
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort(stableError("WEBSITE_HANDOFF_TIMEOUT"));
  }, deadlineMs);
  timeout.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timeout);
      parent.removeEventListener("abort", abort);
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function mediaType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function stableError(code: string): Error {
  return new Error(code);
}
