import {
  BROWSER_USE_CLOUD_API_VERSION,
  BROWSER_USE_CLOUD_MODEL,
  browserUseCloudV4PolicyDigest,
  type BrowserUseCloudV4Request,
} from "../../../../packages/providers/src/browser-use-v4.ts";
import { IDENTIFIER, MAX_SESSION_TTL_MS, SECRET_REFERENCE } from "../constants.ts";
import { badRequest, unavailable } from "../errors.ts";
import { isPlainRecord, sameJson } from "../canonical.ts";
import { workerResponse, type WorkerEnvelope } from "../envelope.ts";
import type { BrowserUseUpstream } from "../dependencies.ts";
import type { RouteResult } from "./types.ts";

const PINNED_SESSION = Object.freeze({
  ephemeral: true, keepAlive: true, recording: false,
  profile: null, workspace: null, persistMemory: false,
});
const PINNED_FEATURES = Object.freeze({ downloads: false, uploads: false, skills: false, agentmail: false });
const REQUEST_KEYS = [
  "allowedDomains", "allowedOrigins", "apiVersion", "expiresAt", "features", "model", "proxy", "session",
];

function exactHttpsOrigin(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.origin === value && url.href === `${value}/` ? url : undefined;
  } catch { return undefined; }
}

/**
 * Rebuilds the pinned Browser Use Cloud v4 request from the caller's request and
 * refuses anything that differs. The returned object, not the caller's, is what
 * is sent upstream and what the applied policy digest is computed over.
 */
export function pinnedBrowserUseRequest(value: unknown, now: Date): BrowserUseCloudV4Request {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(",") !== REQUEST_KEYS.join(",")) {
    throw badRequest("GATEWAY_BROWSER_REQUEST_INVALID");
  }
  if (value.apiVersion !== BROWSER_USE_CLOUD_API_VERSION || value.model !== BROWSER_USE_CLOUD_MODEL) {
    throw badRequest("GATEWAY_BROWSER_REQUEST_PIN_VIOLATION");
  }
  if (!sameJson(value.session, PINNED_SESSION) || !sameJson(value.features, PINNED_FEATURES)) {
    throw badRequest("GATEWAY_BROWSER_REQUEST_PIN_VIOLATION");
  }
  const proxy = value.proxy;
  if (!isPlainRecord(proxy) || proxy.denyByDefault !== true
    || typeof proxy.policyReference !== "string" || !SECRET_REFERENCE.test(proxy.policyReference)
    || Object.keys(proxy).sort().join(",") !== "denyByDefault,policyReference") {
    throw badRequest("GATEWAY_BROWSER_REQUEST_PIN_VIOLATION");
  }
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length !== 1) {
    throw badRequest("GATEWAY_BROWSER_REQUEST_PIN_VIOLATION");
  }
  const origin = exactHttpsOrigin(value.allowedOrigins[0]);
  if (!origin || !sameJson(value.allowedDomains, [origin.hostname])) {
    throw badRequest("GATEWAY_BROWSER_REQUEST_PIN_VIOLATION");
  }
  const expiry = Date.parse(String(value.expiresAt));
  if (typeof value.expiresAt !== "string" || !Number.isFinite(expiry)
    || expiry <= now.getTime() || expiry - now.getTime() > MAX_SESSION_TTL_MS) {
    throw badRequest("GATEWAY_BROWSER_SESSION_TTL_INVALID");
  }
  return {
    apiVersion: BROWSER_USE_CLOUD_API_VERSION,
    model: BROWSER_USE_CLOUD_MODEL,
    allowedDomains: [origin.hostname],
    allowedOrigins: [origin.origin],
    proxy: { denyByDefault: true, policyReference: proxy.policyReference },
    session: { ...PINNED_SESSION },
    features: { ...PINNED_FEATURES },
    expiresAt: value.expiresAt,
  };
}

export async function startBrowserSession(
  upstream: BrowserUseUpstream,
  envelope: WorkerEnvelope,
  now: Date,
): Promise<RouteResult> {
  const request = pinnedBrowserUseRequest(envelope.payload.request, now);
  const appliedPolicyDigest = browserUseCloudV4PolicyDigest(request);
  let started;
  try { started = await upstream.startSession(request); }
  catch { throw unavailable("GATEWAY_BROWSER_UPSTREAM_UNAVAILABLE"); }
  if (!started || typeof started.providerSessionId !== "string" || !IDENTIFIER.test(started.providerSessionId)
    || typeof started.liveUrl !== "string" || !started.liveUrl.startsWith("https://")
    || typeof started.cdpUrl !== "string" || !started.cdpUrl.startsWith("wss://")) {
    throw unavailable("GATEWAY_BROWSER_UPSTREAM_RESPONSE_INVALID");
  }
  return {
    status: 200,
    body: {
      gatewayProtocolVersion: envelope.gatewayProtocolVersion,
      idempotencyKey: envelope.idempotencyKey,
      ownership: envelope.ownership,
      apiVersion: BROWSER_USE_CLOUD_API_VERSION,
      model: BROWSER_USE_CLOUD_MODEL,
      providerSessionId: started.providerSessionId,
      liveUrl: started.liveUrl,
      cdpUrl: started.cdpUrl,
      appliedPolicyDigest,
    },
  };
}

export async function stopBrowserSession(
  upstream: BrowserUseUpstream,
  envelope: WorkerEnvelope,
): Promise<RouteResult> {
  const { providerSessionId, reason } = envelope.payload;
  if (typeof providerSessionId !== "string" || !IDENTIFIER.test(providerSessionId)
    || !["completed", "failed", "cancelled"].includes(String(reason))) {
    throw badRequest("GATEWAY_BROWSER_REQUEST_INVALID");
  }
  try { await upstream.stopSession(providerSessionId, reason as "completed" | "failed" | "cancelled"); }
  catch { throw unavailable("GATEWAY_BROWSER_UPSTREAM_UNAVAILABLE"); }
  return { status: 200, body: workerResponse(envelope, { stopped: true }) };
}

export async function reconcileBrowserSession(
  upstream: BrowserUseUpstream,
  envelope: WorkerEnvelope,
): Promise<RouteResult> {
  const providerSessionId = envelope.payload.providerSessionId;
  if (typeof providerSessionId !== "string" || !IDENTIFIER.test(providerSessionId)) {
    throw badRequest("GATEWAY_BROWSER_REQUEST_INVALID");
  }
  let reconciled;
  try { reconciled = await upstream.reconcileSession(providerSessionId); }
  catch { throw unavailable("GATEWAY_BROWSER_UPSTREAM_UNAVAILABLE"); }
  // Termination is attested only when the upstream positively confirmed it.
  if (reconciled?.terminated !== true) throw unavailable("GATEWAY_BROWSER_TERMINATION_UNPROVEN");
  return { status: 200, body: workerResponse(envelope, { reconciled: true, terminated: true }) };
}
