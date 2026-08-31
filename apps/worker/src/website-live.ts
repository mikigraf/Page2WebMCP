import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { WebsiteEvidence, WebsiteObservationInput } from "../../../packages/providers/src/website-evidence.ts";
import type { WebsiteOwnershipChallenge, WebsiteProviderControls } from "../../../packages/providers/src/website.ts";
import { validateTargetUrl } from "../../../packages/security/src/security.ts";
import {
  createNodeOpenApiResolver,
  createNodeOpenApiTransport,
  createNodePinnedJsonTransport,
  type NodePinnedJsonResponse,
  type NodePinnedJsonTransport,
} from "./node-network.ts";
import { createWebsiteAnalysisAdapter, type AnalysisAdapter } from "./workflow.ts";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const MAX_CONTROL_BYTES = 64 * 1_024;
const CONTROL_TIMEOUT_MS = 10_000;
const SESSION_TTL_MS = 9 * 60_000;
const referencePattern = /^secretref:[A-Za-z0-9._:-]{1,200}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION = 1 as const;
export const WEBSITE_LIVE_CONTROL_PATHS = Object.freeze({
  authClose: "/v1/auth-handoffs/close",
  authOpen: "/v1/auth-handoffs/open",
  authWait: "/v1/auth-handoffs/wait",
  browserReconcile: "/v1/browser-use-v4/sessions/reconcile",
  browserStart: "/v1/browser-use-v4/sessions/start",
  browserStop: "/v1/browser-use-v4/sessions/stop",
  evidencePut: "/v1/website-evidence/put",
  leaseClaim: "/v1/browser-leases/claim",
  leaseRelease: "/v1/browser-leases/release",
  observe: "/v1/website-observations/observe",
  ownershipChallenge: "/v1/website-ownership/challenges/load",
  ownershipReplay: "/v1/website-ownership/replays/consume",
  policyApply: "/v1/website-egress-policies/apply",
  policyIssue: "/v1/website-egress-policies/issue",
  policyRevoke: "/v1/website-egress-policies/revoke",
  secretPut: "/v1/ttl-secrets/put",
  secretRevoke: "/v1/ttl-secrets/revoke",
} as const);

export const WEBSITE_LIVE_KEYS = Object.freeze([
  "PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN",
  "PAGE2WEBMCP_AUTH_HANDOFF_TOKEN",
  "PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN",
  "PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN",
  "PAGE2WEBMCP_BROWSER_USE_API_KEY",
  "PAGE2WEBMCP_BROWSER_USE_API_ORIGIN",
  "PAGE2WEBMCP_CDP_OBSERVER_ORIGIN",
  "PAGE2WEBMCP_CDP_OBSERVER_TOKEN",
  "PAGE2WEBMCP_EGRESS_POLICY_ORIGIN",
  "PAGE2WEBMCP_EGRESS_POLICY_TOKEN",
  "PAGE2WEBMCP_EGRESS_PROXY_ORIGIN",
  "PAGE2WEBMCP_EGRESS_PROXY_TOKEN",
  "PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN",
  "PAGE2WEBMCP_EVIDENCE_STORE_TOKEN",
  "PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN",
  "PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN",
  "PAGE2WEBMCP_PUBLIC_ORIGIN",
  "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID",
  "PAGE2WEBMCP_SECRET_STORE_ORIGIN",
  "PAGE2WEBMCP_SECRET_STORE_TOKEN",
] as const);

type WebsiteLiveKey = typeof WEBSITE_LIVE_KEYS[number];
type WebsiteLiveEnvironment = Readonly<Record<WebsiteLiveKey | "PAGE2WEBMCP_PROVIDER_MODE", string>>;

function exactHttpsOrigin(value: string | undefined): value is string {
  if (!value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return validateTargetUrl(value).ok && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.origin === value && url.href === `${value}/`;
  } catch { return false; }
}

function storagePublicPrefix(value: string | undefined): value is string {
  if (!value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return validateTargetUrl(value).ok && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === "/storage/v1/object/public/page2webmcp-releases"
      && url.href.replace(/\/$/, "") === value;
  } catch { return false; }
}

function boundedToken(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && /^[\u0021-\u007e]+$/.test(value);
}

function browserUseKey(value: string | undefined): value is string {
  return boundedToken(value) && /^bu_[A-Za-z0-9_-]+$/.test(value);
}

function kmsKeyReference(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512
    && /^[\u0021-\u007e]+$/.test(value);
}

export function websiteMissingControls(environment: RuntimeEnvironment): WebsiteLiveKey[] {
  const invalid = new Set<WebsiteLiveKey>();
  for (const key of WEBSITE_LIVE_KEYS) if (environment[key] === undefined) invalid.add(key);
  for (const key of WEBSITE_LIVE_KEYS) {
    const value = environment[key];
    if (key.endsWith("_ORIGIN") && key !== "PAGE2WEBMCP_PUBLIC_ORIGIN") {
      if (!exactHttpsOrigin(value)) invalid.add(key);
    } else if (key === "PAGE2WEBMCP_PUBLIC_ORIGIN") {
      if (!storagePublicPrefix(value)) invalid.add(key);
    } else if (key === "PAGE2WEBMCP_BROWSER_USE_API_KEY") {
      if (!browserUseKey(value)) invalid.add(key);
    } else if (key === "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID") {
      if (!kmsKeyReference(value)) invalid.add(key);
    } else if (key.endsWith("_TOKEN") && !boundedToken(value)) invalid.add(key);
  }
  return [...invalid].sort();
}

function configuredEnvironment(environment: RuntimeEnvironment): WebsiteLiveEnvironment {
  if (environment.PAGE2WEBMCP_PROVIDER_MODE !== "website" || websiteMissingControls(environment).length > 0) {
    throw new Error("WEBSITE_LIVE_CONFIGURATION_REQUIRED");
  }
  return environment as WebsiteLiveEnvironment;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.message === "WEBSITE_CONTROL_TIMEOUT"
    ? new Error("WEBSITE_CONTROL_TIMEOUT")
    : new Error("WEBSITE_CONTROL_ABORTED");
}

function linkedSignal(parent: AbortSignal): Readonly<{ signal: AbortSignal; close(): void }> {
  const controller = new AbortController();
  const abort = () => controller.abort(abortReason(parent));
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("WEBSITE_CONTROL_TIMEOUT")), CONTROL_TIMEOUT_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    close: () => { clearTimeout(timer); parent.removeEventListener("abort", abort); },
  };
}

function boundedJson(response: NodePinnedJsonResponse): unknown {
  const declared = response.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_CONTROL_BYTES)) {
    throw new Error("WEBSITE_CONTROL_RESPONSE_TOO_LARGE");
  }
  if (!(response.body instanceof Uint8Array) || response.body.byteLength > MAX_CONTROL_BYTES) {
    throw new Error("WEBSITE_CONTROL_RESPONSE_TOO_LARGE");
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)); }
  catch { throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID"); }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(value: unknown, expected: unknown): boolean {
  return canonicalJson(value) === canonicalJson(expected);
}

type ControlClient = Readonly<{
  request(path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
}>;

function controlClient(transport: NodePinnedJsonTransport, origin: string, headers: Readonly<Record<string, string>>): ControlClient {
  return {
    async request(path, body, signal) {
      const url = `${origin}${path}`;
      const encoded = JSON.stringify(body);
      if (!path.startsWith("/v1/") || encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_BYTES) {
        throw new Error("WEBSITE_CONTROL_REQUEST_INVALID");
      }
      const lifecycle = linkedSignal(signal);
      try {
        let response: NodePinnedJsonResponse;
        try {
          response = await transport.request({
            url,
            method: "POST",
            signal: lifecycle.signal,
            headers: { ...headers, "content-type": "application/json" },
            body: encoded,
          });
        } catch (error) {
          if (lifecycle.signal.aborted) {
            const reason = abortReason(lifecycle.signal);
            throw reason.message === "WEBSITE_CONTROL_TIMEOUT"
              ? new Error("WEBSITE_CONTROL_RETRYABLE") : reason;
          }
          if (error instanceof Error && /^WEBSITE_[A-Z0-9_]+$/.test(error.message)) throw error;
          throw new Error("WEBSITE_CONTROL_RETRYABLE");
        }
        if (response.url !== url) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
        if (response.status === 429 || response.status >= 500 && response.status <= 599) {
          throw new Error("WEBSITE_CONTROL_RETRYABLE");
        }
        if (response.status >= 400 && response.status <= 499) throw new Error("WEBSITE_CONTROL_REJECTED");
        if (response.status !== 200
          || response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
        }
        return asRecord(boundedJson(response));
      } finally { lifecycle.close(); }
    },
  };
}

function bearerClient(transport: NodePinnedJsonTransport, origin: string, token: string): ControlClient {
  return controlClient(transport, origin, { authorization: `Bearer ${token}` });
}

function cleanupSignal(): AbortSignal {
  return new AbortController().signal;
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
}

function assertReference(value: unknown): asserts value is string {
  if (typeof value !== "string" || !referencePattern.test(value)) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
}

function exactSecretUrl(value: unknown, protocol: "https:" | "wss:"): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === protocol && !url.username && !url.password;
  } catch { return false; }
}

type RoutePolicy = Readonly<{
  denyByDefault: true;
  routes: readonly Readonly<{ methods: readonly ["GET", "HEAD"]; origin: string; pathPrefix: "/" }>[];
}>;

function routePolicy(targetOrigin: string): RoutePolicy {
  return { denyByDefault: true, routes: [{ methods: ["GET", "HEAD"], origin: targetOrigin, pathPrefix: "/" }] };
}

function policyDigest(value: RoutePolicy): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function configuredNetwork(
  resolver: WebsiteProviderControls["resolver"] | undefined,
  transport: WebsiteProviderControls["transport"] | undefined,
): Pick<WebsiteProviderControls, "resolver" | "transport"> {
  if (resolver && transport) return { resolver, transport };
  if (resolver || transport) throw new Error("WEBSITE_LIVE_CONFIGURATION_REQUIRED");
  const addressResolver = createNodeOpenApiResolver();
  const httpsTransport = createNodeOpenApiTransport();
  return {
    resolver: {
      resolve: async (hostname, signal) => {
        try { return await addressResolver.resolve(hostname, signal); }
        catch (error) {
          if (signal.aborted) throw abortReason(signal);
          throw new Error(error instanceof Error && error.message === "OPENAPI_DNS_RESOLUTION_FAILED"
            ? "WEBSITE_DNS_RESOLUTION_FAILED" : "WEBSITE_SSRF_BLOCKED");
        }
      },
      resolveTxt: async (hostname, signal) => {
        if (signal.aborted) throw abortReason(signal);
        const dns = new Resolver({ timeout: 2_000, tries: 2 });
        const abort = () => dns.cancel();
        signal.addEventListener("abort", abort, { once: true });
        try {
          const records = await dns.resolveTxt(hostname);
          if (records.length > 100) throw new Error("OWNERSHIP_PROOF_INVALID");
          return records;
        } catch (error) {
          if (signal.aborted) throw abortReason(signal);
          if (error instanceof Error && error.message === "OWNERSHIP_PROOF_INVALID") throw error;
          throw new Error("OWNERSHIP_DNS_RESOLUTION_FAILED");
        } finally { signal.removeEventListener("abort", abort); }
      },
    },
    transport: {
      request: async (request) => {
        if (request.method !== "GET") throw new Error("WEBSITE_TRANSPORT_POLICY_VIOLATION");
        try {
          const response = await httpsTransport.request({
            ...request,
            method: "GET",
            headers: { accept: request.headers.accept ?? "" },
          });
          if (response.tls.authorized !== true || !["TLSv1.2", "TLSv1.3"].includes(response.tls.protocol ?? "")) {
            throw new Error("OPENAPI_TLS_VERIFICATION_FAILED");
          }
          return {
            ...response,
            tls: {
              authorized: true as const,
              servername: response.tls.servername,
              protocol: response.tls.protocol as "TLSv1.2" | "TLSv1.3",
            },
          };
        }
        catch (error) {
          if (request.signal.aborted) throw abortReason(request.signal);
          const code = error instanceof Error ? error.message : "";
          if (code === "OPENAPI_TLS_VERIFICATION_FAILED") throw new Error("WEBSITE_TLS_VERIFICATION_FAILED");
          if (code === "OPENAPI_DNS_REBINDING_BLOCKED") throw new Error("WEBSITE_DNS_REBINDING_BLOCKED");
          throw new Error("WEBSITE_FETCH_FAILED");
        }
      },
    },
  };
}

export type WebsiteLiveDependencies = Readonly<{
  fetch?: typeof fetch;
  clock?: () => Date;
  resolver?: WebsiteProviderControls["resolver"];
  transport?: WebsiteProviderControls["transport"];
  controlTransport?: NodePinnedJsonTransport;
}>;

export function createConfiguredWebsiteAnalysisAdapter(
  environmentValue: RuntimeEnvironment,
  dependencies: WebsiteLiveDependencies,
): AnalysisAdapter {
  const environment = configuredEnvironment(environmentValue);
  if (!dependencies || dependencies.clock !== undefined
    && typeof dependencies.clock !== "function") throw new Error("WEBSITE_LIVE_CONFIGURATION_REQUIRED");
  const clock = dependencies.clock ?? (() => new Date());
  const network = configuredNetwork(dependencies.resolver, dependencies.transport);
  const controls = dependencies.controlTransport ?? createNodePinnedJsonTransport();
  const hostedScriptOrigin = new URL(environment.PAGE2WEBMCP_PUBLIC_ORIGIN).origin;
  const ownership = bearerClient(controls, environment.PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN, environment.PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN);
  const policy = bearerClient(controls, environment.PAGE2WEBMCP_EGRESS_POLICY_ORIGIN, environment.PAGE2WEBMCP_EGRESS_POLICY_TOKEN);
  const proxy = bearerClient(controls, environment.PAGE2WEBMCP_EGRESS_PROXY_ORIGIN, environment.PAGE2WEBMCP_EGRESS_PROXY_TOKEN);
  const leases = bearerClient(controls, environment.PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN, environment.PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN);
  const secrets = bearerClient(controls, environment.PAGE2WEBMCP_SECRET_STORE_ORIGIN, environment.PAGE2WEBMCP_SECRET_STORE_TOKEN);
  const auth = bearerClient(controls, environment.PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN, environment.PAGE2WEBMCP_AUTH_HANDOFF_TOKEN);
  const evidence = bearerClient(controls, environment.PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN, environment.PAGE2WEBMCP_EVIDENCE_STORE_TOKEN);
  const observer = bearerClient(controls, environment.PAGE2WEBMCP_CDP_OBSERVER_ORIGIN, environment.PAGE2WEBMCP_CDP_OBSERVER_TOKEN);
  const browser = controlClient(controls, environment.PAGE2WEBMCP_BROWSER_USE_API_ORIGIN, {
    "x-browser-use-api-key": environment.PAGE2WEBMCP_BROWSER_USE_API_KEY,
    "x-page2webmcp-browser-gateway-version": String(WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION),
  });

  return async (source, signal) => {
    if (source.sourceType !== "website") throw new Error("SOURCE_TYPE_UNSUPPORTED");
    if (!source.organizationId || !source.projectId || !source.id
      || ![source.organizationId, source.projectId, source.id].every((value) => identifierPattern.test(value))) {
      throw new Error("WEBSITE_SOURCE_OWNERSHIP_REQUIRED");
    }
    if (!Number.isSafeInteger(source.leaseGeneration) || (source.leaseGeneration ?? 0) < 1) {
      throw new Error("WEBSITE_SOURCE_DELIVERY_REQUIRED");
    }
    const deliveryGeneration = source.leaseGeneration as number;
    if (!source.sourceConfiguration || typeof source.sourceConfiguration !== "object"
      || Array.isArray(source.sourceConfiguration)
      || !same(source.sourceConfiguration, { kind: "website" })) {
      throw new Error("WEBSITE_SOURCE_CONFIGURATION_REQUIRED");
    }
    if (!validateTargetUrl(source.sourceUrl).ok) throw new Error("WEBSITE_URL_BLOCKED");
    const sourceUrl = new URL(source.sourceUrl);
    if (sourceUrl.search || sourceUrl.hash) throw new Error("WEBSITE_URL_BLOCKED");
    const targetOrigin = sourceUrl.origin;
    const ownershipIdentity = {
      organizationId: source.organizationId,
      projectId: source.projectId,
      runId: source.id,
    };
    const envelope = (operation: string, payload: Record<string, unknown>) => ({
      gatewayProtocolVersion: WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION,
      idempotencyKey: `website:${source.id}:${deliveryGeneration}:${operation}:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`,
      ownership: ownershipIdentity,
      ...payload,
    });
    const validResponseMetadata = (response: Record<string, unknown>, request: ReturnType<typeof envelope>) =>
      response.gatewayProtocolVersion === WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION
      && response.idempotencyKey === request.idempotencyKey && same(response.ownership, ownershipIdentity);
    const stateful = async (
      client: ControlClient,
      path: string,
      operation: string,
      payload: Record<string, unknown>,
      requestSignal: AbortSignal,
    ) => {
      const request = envelope(operation, payload);
      const response = await client.request(path, request, requestSignal);
      if (!validResponseMetadata(response, request)) {
        throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
      }
      return { request, response };
    };
    const routes = routePolicy(targetOrigin).routes;
    const policyInput = { denyByDefault: true, ttlSeconds: SESSION_TTL_MS / 1_000, routes, targetOrigin } as const;
    let reference: string | undefined;
    let expiresAt: string | undefined;
    let primaryError: unknown;
    try {
      const issuedRequest = envelope("policy-issue", policyInput);
      const issuedResponse = await policy.request(WEBSITE_LIVE_CONTROL_PATHS.policyIssue, issuedRequest, signal);
      assertReference(issuedResponse.reference);
      reference = issuedResponse.reference;
      const issuedExpiry = typeof issuedResponse.expiresAt === "string" ? Date.parse(issuedResponse.expiresAt) : NaN;
      const issuedAt = clock().getTime();
      if (!Number.isFinite(issuedExpiry) || issuedExpiry <= issuedAt || issuedExpiry - issuedAt > SESSION_TTL_MS) {
        throw new Error("WEBSITE_EGRESS_POLICY_ATTESTATION_FAILED");
      }
      expiresAt = issuedResponse.expiresAt as string;
      if (!validResponseMetadata(issuedResponse, issuedRequest)
        || !same(issuedResponse, { ...issuedRequest, reference, expiresAt })) {
        throw new Error("WEBSITE_EGRESS_POLICY_ATTESTATION_FAILED");
      }
      const appliedResult = await stateful(proxy, WEBSITE_LIVE_CONTROL_PATHS.policyApply, "policy-apply", {
        denyByDefault: true, expiresAt, routes, targetOrigin, reference,
      }, signal);
      if (!same(appliedResult.response, { ...appliedResult.request, enforced: true })) {
        throw new Error("WEBSITE_EGRESS_POLICY_ATTESTATION_FAILED");
      }
      const stopGateway = async (providerSessionId: string, reason: "completed" | "failed" | "cancelled") => {
        const result = await stateful(browser, WEBSITE_LIVE_CONTROL_PATHS.browserStop, "browser-stop", {
          providerSessionId, reason,
        }, cleanupSignal());
        if (!same(result.response, { ...result.request, stopped: true })) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
      };
      const reconcileGateway = async (providerSessionId: string) => {
        const result = await stateful(browser, WEBSITE_LIVE_CONTROL_PATHS.browserReconcile, "browser-reconcile", {
          providerSessionId,
        }, cleanupSignal());
        if (!same(result.response, { ...result.request, reconciled: true, terminated: true })) {
          throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
        }
      };
      const adapter = createWebsiteAnalysisAdapter({
        clock,
        provider: { hostedScriptOrigin, ...network },
        ownership: {
          challenges: {
            load: async (input) => {
              const result = await stateful(ownership, WEBSITE_LIVE_CONTROL_PATHS.ownershipChallenge, "ownership-load", input, signal);
              const challenge = result.response as unknown as WebsiteOwnershipChallenge;
              if (challenge.targetOrigin !== input.targetOrigin) {
                throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
              }
              return {
                method: challenge.method, targetOrigin: challenge.targetOrigin,
                token: challenge.token, expiresAt: challenge.expiresAt,
              };
            },
          },
          replayStore: {
            consume: async (key, challengeExpiresAt) => {
              const { response } = await stateful(ownership, WEBSITE_LIVE_CONTROL_PATHS.ownershipReplay, "ownership-replay", {
                key, expiresAt: challengeExpiresAt,
              }, signal);
              return response.key === key && response.expiresAt === challengeExpiresAt && response.consumed === true;
            },
          },
        },
        browser: {
          expiresAt,
          proxyPolicyReference: { reference, expiresAt },
          controls: {
            clock,
            leases: {
              claim: async (input) => {
                const { response } = await stateful(leases, WEBSITE_LIVE_CONTROL_PATHS.leaseClaim, "lease-claim", input, signal);
                assertIdentifier(response.leaseId);
                if (!Object.entries(input).every(([key, value]) => same(response[key], value))) {
                  throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
                }
                return { leaseId: response.leaseId };
              },
              release: async (leaseId) => {
                const { response } = await stateful(leases, WEBSITE_LIVE_CONTROL_PATHS.leaseRelease, "lease-release", { leaseId }, cleanupSignal());
                if (response.leaseId !== leaseId || response.released !== true) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
              },
            },
            secretReferences: {
              put: async (input) => {
                const valueDigest = createHash("sha256").update(input.value, "utf8").digest("hex");
                const { response } = await stateful(secrets, WEBSITE_LIVE_CONTROL_PATHS.secretPut, `secret-put-${input.purpose}`, {
                  ...input, valueDigest, kmsKeyId: environment.PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID,
                }, signal);
                assertReference(response.reference);
                if (response.expiresAt !== input.expiresAt || response.purpose !== input.purpose
                  || response.valueDigest !== valueDigest || "value" in response
                  || response.kmsKeyId !== environment.PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID) {
                  throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
                }
                return { reference: response.reference, expiresAt: input.expiresAt };
              },
              revoke: async (secretReference) => {
                const { response } = await stateful(secrets, WEBSITE_LIVE_CONTROL_PATHS.secretRevoke,
                  `secret-revoke-${createHash("sha256").update(secretReference).digest("hex")}`, {
                    reference: secretReference,
                  }, cleanupSignal());
                if (response.reference !== secretReference || response.revoked !== true) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
              },
            },
            transport: {
              start: async (request, browserSignal) => {
                const protocol = envelope("browser-start", { request });
                const response = await browser.request(WEBSITE_LIVE_CONTROL_PATHS.browserStart, protocol, browserSignal);
                assertIdentifier(response.providerSessionId);
                try {
                  if (response.gatewayProtocolVersion !== WEBSITE_LIVE_GATEWAY_PROTOCOL_VERSION
                    || response.idempotencyKey !== protocol.idempotencyKey || !same(response.ownership, ownershipIdentity)
                    || response.apiVersion !== "v4" || response.model !== "browser-use-2.0"
                    || !exactSecretUrl(response.liveUrl, "https:") || !exactSecretUrl(response.cdpUrl, "wss:")
                    || typeof response.appliedPolicyDigest !== "string" || !/^[a-f0-9]{64}$/.test(response.appliedPolicyDigest)) {
                    throw new Error("BROWSER_PROVIDER_RESPONSE_INVALID");
                  }
                  return {
                    providerSessionId: response.providerSessionId,
                    liveUrl: response.liveUrl,
                    cdpUrl: response.cdpUrl,
                    appliedPolicyDigest: response.appliedPolicyDigest,
                  };
                } catch (error) {
                  try { await stopGateway(response.providerSessionId, "failed"); }
                  catch { /* reconciliation below remains mandatory after ambiguous stop */ }
                  try { await reconcileGateway(response.providerSessionId); }
                  catch { /* cleanup cannot weaken the primary validation failure */ }
                  throw error;
                }
              },
              stop: stopGateway,
              reconcile: reconcileGateway,
            },
          },
        },
        authentication: {
          store: {
            open: async (input) => {
              const { response } = await stateful(auth, WEBSITE_LIVE_CONTROL_PATHS.authOpen, "auth-open", input, signal);
              assertIdentifier(response.handoffId);
              if (response.targetOrigin !== input.targetOrigin || response.liveReference !== input.liveReference
                || response.expiresAt !== input.expiresAt) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
              return { handoffId: response.handoffId };
            },
            wait: async (handoffId, waitSignal) => {
              const { response } = await stateful(auth, WEBSITE_LIVE_CONTROL_PATHS.authWait, "auth-wait", { handoffId }, waitSignal);
              if (response.handoffId !== handoffId || !same(response.ownership, ownershipIdentity)) {
                throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
              }
              return response.completion;
            },
            close: async (handoffId, outcome) => {
              const { response } = await stateful(auth, WEBSITE_LIVE_CONTROL_PATHS.authClose, "auth-close", {
                handoffId, outcome,
              }, cleanupSignal());
              if (response.handoffId !== handoffId || response.outcome !== outcome || response.closed !== true) {
                throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
              }
            },
          },
        },
        explorer: {
          observe: async (input) => {
            const enforcedPolicy = routePolicy(input.targetOrigin);
            const request = {
              phase: input.phase,
              targetOrigin: input.targetOrigin,
              sourceUrl: input.sourceUrl,
              cdpReference: input.cdpReference,
              routePolicy: enforcedPolicy,
              routePolicyDigest: policyDigest(enforcedPolicy),
            };
            const { response } = await stateful(observer, WEBSITE_LIVE_CONTROL_PATHS.observe, `observe-${input.phase}`, request, input.signal);
            if (response.phase !== input.phase || response.targetOrigin !== input.targetOrigin
              || response.cdpReference !== input.cdpReference || response.routePolicyDigest !== request.routePolicyDigest
              || response.enforced !== true || typeof response.requiresAuthentication !== "boolean") {
              throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
            }
            return {
              observations: response.observations as WebsiteObservationInput,
              requiresAuthentication: response.requiresAuthentication,
            };
          },
        },
        evidenceStore: {
          put: async (record: WebsiteEvidence) => {
            const { response } = await stateful(evidence, WEBSITE_LIVE_CONTROL_PATHS.evidencePut, "evidence-put", { record }, signal);
            if (response.reference !== record.reference || response.organizationId !== record.organizationId
              || response.projectId !== record.projectId || response.analysisRunId !== record.analysisRunId) {
              throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
            }
            return { reference: record.reference };
          },
        },
      });
      return await adapter(source, signal);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const [client, operation] of [[proxy, "policy-proxy-revoke"], [policy, "policy-store-revoke"]] as const) {
        if (!reference) continue;
        try {
          const { response } = await stateful(client, WEBSITE_LIVE_CONTROL_PATHS.policyRevoke, operation, { reference }, cleanupSignal());
          if (response.reference !== reference || response.revoked !== true) throw new Error("WEBSITE_CONTROL_RESPONSE_INVALID");
        } catch (error) { cleanupErrors.push(error); }
      }
      if (primaryError === undefined && cleanupErrors.length > 0) throw new Error("WEBSITE_EGRESS_POLICY_CLEANUP_FAILED");
    }
  };
}
