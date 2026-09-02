import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GatewayConfiguration } from "./config.ts";
import type { GatewayDependencies } from "./dependencies.ts";
import type { GatewayContext } from "./context.ts";
import { authorizeControl, assertControlServed } from "./authz.ts";
import { badRequest, gatewayCode, gatewayStatus, notFound, GatewayError } from "./errors.ts";
import { parseUserEnvelope, parseWorkerEnvelope, type UserEnvelope, type WorkerEnvelope } from "./envelope.ts";
import { readJsonBody } from "./http/body.ts";
import { respondHtml, respondJson } from "./http/respond.ts";
import { handleReadiness } from "./readiness.ts";
import { CONTROL_ROUTES, POLICY_REVOKE_CONTROLS, POLICY_REVOKE_PATH } from "./routes/table.ts";
import { createCheckpointStore } from "./stores/checkpoints.ts";
import { createEgressEnforcer } from "./stores/enforcement.ts";
import { createEvidenceStore } from "./stores/evidence.ts";
import { createLeaseStore } from "./stores/leases.ts";
import { createOwnershipStore, createReplayStore } from "./stores/ownership.ts";
import { createPolicyStore } from "./stores/policies.ts";
import { createSecretStore } from "./stores/secrets.ts";
import { claimLease, releaseLease } from "./routes/leases.ts";
import { applyPolicy, issuePolicy, revokeEnforcedPolicy, revokeIssuedPolicy } from "./routes/egress.ts";
import { putSecret, revokeSecret } from "./routes/secrets.ts";
import { getEvidence, putEvidence } from "./routes/evidence.ts";
import {
  reconcileBrowserSession,
  startBrowserSession,
  stopBrowserSession,
} from "./routes/browser-use.ts";
import {
  checkSourceAttestation,
  consumeReplayKey,
  consumeSourceAttestation,
  issueSourceAttestation,
  loadOwnershipChallenge,
  sourceAttestationStatus,
} from "./routes/ownership.ts";
import {
  checkpointStatus,
  createCheckpoint,
  finalizeCheckpoint,
  reconcileCheckpoint,
  resumeCheckpoint,
} from "./routes/checkpoints.ts";
import {
  authenticationPortalStatus,
  loadAuthenticationPortal,
  renderPortal,
  renderStatus,
  verifyPortal,
} from "./routes/portal.ts";
import { observe } from "./routes/observer.ts";
import type { RouteResult } from "./routes/types.ts";

const HUMAN_PATHS = new Set(["/portal", "/status", "/portal/verify"]);

function gatewayContext(configuration: GatewayConfiguration, dependencies: GatewayDependencies): GatewayContext {
  const secrets = configuration.controls.has("ttl-secret-store") && configuration.kmsKeyId && configuration.kmsRootKey
    ? createSecretStore(configuration.kmsKeyId, configuration.kmsRootKey)
    : undefined;
  return {
    configuration,
    clock: dependencies.clock ?? (() => new Date()),
    checkpoints: createCheckpointStore(),
    enforcer: dependencies.egressEnforcer ?? createEgressEnforcer(),
    evidence: createEvidenceStore(),
    leases: createLeaseStore(),
    ownership: createOwnershipStore(),
    policies: createPolicyStore(),
    replays: createReplayStore(),
    secrets,
    browserUseUpstream: dependencies.browserUseUpstream,
    ownershipVerifier: dependencies.ownershipVerifier,
    authenticationObserver: dependencies.authenticationObserver,
    cdpObserver: dependencies.cdpObserver,
  };
}

async function dispatch(
  context: GatewayContext,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<RouteResult> {
  const now = context.clock();
  const worker = (): WorkerEnvelope => parseWorkerEnvelope(body);
  const user = (): UserEnvelope => {
    const parsed = parseUserEnvelope(body);
    if (!parsed) throw badRequest("GATEWAY_REQUEST_ENVELOPE_INVALID");
    return parsed;
  };
  switch (path) {
    case "/v1/browser-leases/claim": return claimLease(context.leases, worker(), now);
    case "/v1/browser-leases/release": return releaseLease(context.leases, worker(), now);
    case "/v1/website-egress-policies/issue": return issuePolicy(context.policies, worker(), now);
    case "/v1/website-egress-policies/apply":
      return applyPolicy(
        context.enforcer,
        context.configuration.controls.has("egress-policy-store") ? context.policies : undefined,
        worker(),
        now,
      );
    case "/v1/ttl-secrets/put":
      if (!context.secrets) throw notFound("GATEWAY_CONTROL_NOT_SERVED");
      return putSecret(context.secrets, worker(), now);
    case "/v1/ttl-secrets/revoke":
      if (!context.secrets) throw notFound("GATEWAY_CONTROL_NOT_SERVED");
      return revokeSecret(context.secrets, worker());
    case "/v1/website-evidence/put": return putEvidence(context.evidence, worker());
    case "/v1/website-evidence/get": return getEvidence(context.evidence, worker());
    case "/v1/website-observations/observe": return observe(context, worker());
    case "/v1/website-ownership/source-attestations/issue":
      return issueSourceAttestation(context.ownership, user(), now);
    case "/v1/website-ownership/source-attestations/status":
      return sourceAttestationStatus(context.ownership, user(), now);
    case "/v1/website-ownership/source-attestations/check":
      return checkSourceAttestation(context.ownership, context.ownershipVerifier, user(), now, signal);
    case "/v1/website-ownership/source-attestations/consume":
      return consumeSourceAttestation(context.ownership, worker(), now);
    case "/v1/website-ownership/challenges/load":
      return loadOwnershipChallenge(context.ownership, worker(), now);
    case "/v1/website-ownership/replays/consume":
      return consumeReplayKey(context.replays, worker(), now);
    case "/v1/authentication/checkpoints/create": return createCheckpoint(context, worker());
    case "/v1/authentication/checkpoints/resume": return resumeCheckpoint(context, worker());
    case "/v1/authentication/checkpoints/finalize": return finalizeCheckpoint(context, worker());
    case "/v1/authentication/checkpoints/reconcile": return reconcileCheckpoint(context, worker());
    case "/v1/authentication/checkpoints/portal": return loadAuthenticationPortal(context, user());
    case "/v1/authentication/checkpoints/status":
      return parseUserEnvelope(body)
        ? authenticationPortalStatus(context, user())
        : checkpointStatus(context, worker());
    case "/v1/browser-use-v4/sessions/start":
      return startBrowserSession(requiredUpstream(context), worker(), now);
    case "/v1/browser-use-v4/sessions/stop":
      return stopBrowserSession(requiredUpstream(context), worker());
    case "/v1/browser-use-v4/sessions/reconcile":
      return reconcileBrowserSession(requiredUpstream(context), worker());
    default: throw notFound("GATEWAY_ROUTE_UNKNOWN");
  }
}

function requiredUpstream(context: GatewayContext) {
  if (!context.browserUseUpstream) throw new GatewayError("GATEWAY_BROWSER_USE_UPSTREAM_UNAVAILABLE", 503);
  return context.browserUseUpstream;
}

async function handlePolicyRevoke(
  context: GatewayContext,
  request: IncomingMessage,
  body: Record<string, unknown>,
): Promise<RouteResult> {
  const envelope = parseWorkerEnvelope(body);
  let lastError: unknown = notFound("GATEWAY_CONTROL_NOT_SERVED");
  for (const control of POLICY_REVOKE_CONTROLS) {
    if (!context.configuration.controls.has(control)) continue;
    try { authorizeControl(context.configuration, control, request); }
    catch (error) { lastError = error; continue; }
    return control === "egress-policy-store"
      ? revokeIssuedPolicy(context.policies, envelope)
      : revokeEnforcedPolicy(context.enforcer, envelope);
  }
  throw lastError;
}

async function route(
  context: GatewayContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://gateway.invalid");
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (path === "/v1/readiness") {
    if (method !== "GET") throw new GatewayError("GATEWAY_METHOD_NOT_ALLOWED", 405);
    await handleReadiness(context.configuration, context.browserUseUpstream, request, response);
    return;
  }
  if (HUMAN_PATHS.has(path)) {
    assertControlServed(context.configuration, "authentication-handoff");
    if (path === "/portal/verify") {
      if (method !== "POST") throw new GatewayError("GATEWAY_METHOD_NOT_ALLOWED", 405);
      await verifyPortal(context, request, response);
      return;
    }
    if (method !== "GET") throw new GatewayError("GATEWAY_METHOD_NOT_ALLOWED", 405);
    if (path === "/portal") renderPortal(context, url, response);
    else renderStatus(context, url, response);
    return;
  }

  const definition = path === POLICY_REVOKE_PATH ? undefined : CONTROL_ROUTES[path];
  if (!definition && path !== POLICY_REVOKE_PATH) throw notFound("GATEWAY_ROUTE_UNKNOWN");
  if (method !== "POST") throw new GatewayError("GATEWAY_METHOD_NOT_ALLOWED", 405);

  if (path === POLICY_REVOKE_PATH) {
    if (!POLICY_REVOKE_CONTROLS.some((control) => context.configuration.controls.has(control))) {
      throw notFound("GATEWAY_CONTROL_NOT_SERVED");
    }
    const body = await readJsonBody(request);
    const result = await handlePolicyRevoke(context, request, body);
    respondJson(response, result.status, result.body);
    return;
  }

  authorizeControl(context.configuration, definition!.control, request);
  const body = await readJsonBody(request);
  const controller = new AbortController();
  request.once("close", () => controller.abort(new Error("GATEWAY_REQUEST_ABORTED")));
  const result = await dispatch(context, path, body, controller.signal);
  respondJson(response, result.status, result.body);
}

/**
 * Builds the reference website control gateway. Nothing here logs a credential,
 * an API key, a cookie, a CDP or live URL, page content, or human credentials:
 * failures are reported as stable codes only.
 */
export function createWebsiteGatewayServer(
  configuration: GatewayConfiguration,
  dependencies: GatewayDependencies = {},
): Server {
  const context = gatewayContext(configuration, dependencies);
  const server = createServer((request, response) => {
    route(context, request, response).catch((error) => {
      if (response.headersSent) { response.destroy(); return; }
      const status = gatewayStatus(error);
      const code = gatewayCode(error);
      const wantsHtml = HUMAN_PATHS.has(new URL(request.url ?? "/", "http://gateway.invalid").pathname);
      if (wantsHtml) {
        respondHtml(response, status,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unavailable</title></head>`
          + `<body><h1>Unavailable</h1><p>${code}</p></body></html>`);
        return;
      }
      respondJson(response, status, { error: code });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on("close", () => context.secrets?.dispose());
  return server;
}
