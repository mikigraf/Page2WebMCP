import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalJson, sha256Hex } from "../canonical.ts";
import { HANDOFF_PARAMETER, HASH_REFERENCE, HEX64, MAX_SESSION_TTL_MS } from "../constants.ts";
import { badRequest, conflict, forbidden, notFound, unavailable } from "../errors.ts";
import { colocated, type GatewayContext } from "../context.ts";
import { userResponse, type UserEnvelope } from "../envelope.ts";
import { readGatewaySecret } from "../stores/secrets.ts";
import type { AuthenticationSignal, CheckpointRecord } from "../stores/checkpoints.ts";
import { respondHtml } from "../http/respond.ts";
import { readFormBody } from "../http/body.ts";
import { portalUrlFor } from "./portal-url.ts";
import type { RouteResult } from "./types.ts";

type CheckpointClaim = Readonly<{
  checkpointReference: string;
  targetOrigin: string;
  expiresAt: string;
}>;

function claim(envelope: UserEnvelope): CheckpointClaim {
  const checkpoint = envelope.checkpoint ?? {};
  const { checkpointReference, targetOrigin, targetOriginDigest, expiresAt } = checkpoint;
  if (typeof checkpointReference !== "string" || !HASH_REFERENCE.test(checkpointReference)
    || typeof targetOrigin !== "string" || typeof targetOriginDigest !== "string"
    || !HEX64.test(targetOriginDigest) || sha256Hex(targetOrigin) !== targetOriginDigest
    || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
    throw badRequest("GATEWAY_CHECKPOINT_REQUEST_INVALID");
  }
  return { checkpointReference, targetOrigin, expiresAt };
}

function scoped(context: GatewayContext, envelope: UserEnvelope, input: CheckpointClaim): CheckpointRecord | undefined {
  const record = context.checkpoints.find(input.checkpointReference);
  if (!record) return undefined;
  if (record.attestation.organizationId !== envelope.scope.organizationId
    || record.attestation.projectId !== envelope.scope.projectId) throw forbidden("GATEWAY_CHECKPOINT_OWNER_MISMATCH");
  if (record.terminal || record.attestation.expiresAt !== input.expiresAt
    || Date.parse(record.attestation.expiresAt) <= context.clock().getTime()) return undefined;
  return record;
}

export function authenticationEvidenceReference(signal: AuthenticationSignal): string {
  return `urn:sha256:${sha256Hex(canonicalJson({
    authenticatedOrigin: signal.authenticatedOrigin,
    observedAt: signal.observedAt,
    signals: [...new Set(signal.signals)].sort(),
    version: 1,
  }))}`;
}

export function loadAuthenticationPortal(context: GatewayContext, envelope: UserEnvelope): RouteResult {
  const input = claim(envelope);
  const record = scoped(context, envelope, input);
  if (!record) {
    return { status: 200, body: userResponse(envelope, {
      state: "expired", targetOrigin: input.targetOrigin, expiresAt: input.expiresAt,
    }) };
  }
  if (record.authentication) {
    return { status: 200, body: userResponse(envelope, {
      state: "ready", targetOrigin: input.targetOrigin, expiresAt: input.expiresAt,
    }) };
  }
  const origin = context.configuration.authHandoffPublicOrigin;
  if (!origin) throw unavailable("GATEWAY_PORTAL_ORIGIN_UNCONFIGURED");
  if (sha256Hex(input.targetOrigin) !== record.attestation.targetOriginDigest) {
    throw forbidden("GATEWAY_CHECKPOINT_ORIGIN_MISMATCH");
  }
  const handoffId = record.handoffId ?? randomBytes(24).toString("base64url");
  const portalUrl = portalUrlFor(origin, handoffId);
  if (!portalUrl) throw unavailable("GATEWAY_PORTAL_URL_UNSAFE");
  context.checkpoints.bindHumanHandoff(record, input.targetOrigin, handoffId);
  return { status: 200, body: userResponse(envelope, {
    state: "waiting", targetOrigin: input.targetOrigin, expiresAt: input.expiresAt, portalUrl,
  }) };
}

export function authenticationPortalStatus(context: GatewayContext, envelope: UserEnvelope): RouteResult {
  const input = claim(envelope);
  const record = scoped(context, envelope, input);
  if (!record) {
    return { status: 200, body: userResponse(envelope, {
      status: "expired", targetOrigin: input.targetOrigin, expiresAt: input.expiresAt,
    }) };
  }
  if (record.authentication && record.authenticationEvidenceReference) {
    return { status: 200, body: userResponse(envelope, {
      status: "ready",
      targetOrigin: input.targetOrigin,
      expiresAt: input.expiresAt,
      authenticationEvidenceReference: record.authenticationEvidenceReference,
    }) };
  }
  return { status: 200, body: userResponse(envelope, {
    status: "waiting", targetOrigin: input.targetOrigin, expiresAt: input.expiresAt,
  }) };
}

function page(title: string, message: string, form?: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escape(title)}</title><style>body{font:16px system-ui;margin:3rem auto;max-width:40rem}</style>`
    + `</head><body><h1>${escape(title)}</h1><p>${escape(message)}</p>${form ?? ""}</body></html>`;
}

function handoffParameter(url: URL): string {
  if (url.searchParams.size !== 1) throw badRequest("GATEWAY_PORTAL_REQUEST_INVALID");
  const handoff = url.searchParams.get("handoff");
  if (typeof handoff !== "string" || !HANDOFF_PARAMETER.test(handoff)) {
    throw badRequest("GATEWAY_PORTAL_REQUEST_INVALID");
  }
  return handoff;
}

/**
 * The human-facing pages. They disclose the target origin the owner is being
 * asked to sign in to and nothing else: no provider session, no CDP or live
 * URL, no cookies, no tokens.
 */
export function renderPortal(context: GatewayContext, url: URL, response: ServerResponse): void {
  const handoff = handoffParameter(url);
  const record = context.checkpoints.byHandoff(handoff, context.clock());
  if (!record || !record.targetOrigin) {
    respondHtml(response, 404, page("Sign-in link unavailable",
      "This sign-in link has expired or was already completed. Ask for a new one from the project page."));
    return;
  }
  if (record.authentication) {
    respondHtml(response, 200, page("Sign-in confirmed",
      `Page2WebMCP has confirmed a signed-in session on ${record.targetOrigin}. You can close this page.`));
    return;
  }
  respondHtml(response, 200, page("Finish signing in",
    `Sign in to ${record.targetOrigin} in the browser session that was opened for this analysis,`
    + " then confirm below so Page2WebMCP can verify the session state.",
    `<form method="post" action="/portal/verify">`
    + `<input type="hidden" name="handoff" value="${handoff}">`
    + `<button type="submit">I have signed in</button></form>`));
}

export function renderStatus(context: GatewayContext, url: URL, response: ServerResponse): void {
  const handoff = handoffParameter(url);
  const record = context.checkpoints.byHandoff(handoff, context.clock());
  if (!record || !record.targetOrigin) {
    respondHtml(response, 404, page("Nothing to show", "This sign-in link has expired or was already completed."));
    return;
  }
  respondHtml(response, 200, record.authentication
    ? page("Signed in", `A signed-in session on ${record.targetOrigin} has been confirmed.`)
    : page("Waiting", `Waiting for a signed-in session on ${record.targetOrigin}.`));
}

export async function verifyPortal(
  context: GatewayContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const form = await readFormBody(request);
  const handoff = form.get("handoff");
  if ([...form.keys()].length !== 1 || typeof handoff !== "string" || !HANDOFF_PARAMETER.test(handoff)) {
    throw badRequest("GATEWAY_PORTAL_REQUEST_INVALID");
  }
  const now = context.clock();
  const record = context.checkpoints.byHandoff(handoff, now);
  if (!record || !record.targetOrigin) throw notFound("GATEWAY_PORTAL_HANDOFF_UNKNOWN");
  if (record.authentication) {
    respondHtml(response, 200, page("Sign-in confirmed",
      `Page2WebMCP has confirmed a signed-in session on ${record.targetOrigin}. You can close this page.`));
    return;
  }
  if (!context.authenticationObserver) throw unavailable("GATEWAY_AUTHENTICATION_OBSERVER_UNAVAILABLE");
  if (!colocated(context, "ttl-secret-store")) throw unavailable("GATEWAY_SECRET_RESOLUTION_UNAVAILABLE");
  const cdpUrl = readGatewaySecret(record.attestation.cdpReference, now);
  if (!cdpUrl) throw conflict("GATEWAY_CHECKPOINT_SECRET_EXPIRED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("GATEWAY_OBSERVATION_TIMEOUT")), MAX_SESSION_TTL_MS / 10);
  timer.unref?.();
  let signal: AuthenticationSignal;
  try {
    signal = await context.authenticationObserver.observe({
      targetOrigin: record.targetOrigin,
      cdpUrl,
      signal: controller.signal,
    });
  } catch {
    throw conflict("GATEWAY_AUTHENTICATION_NOT_OBSERVED");
  } finally { clearTimeout(timer); }
  if (!signal || signal.authenticatedOrigin !== record.targetOrigin) {
    throw conflict("GATEWAY_AUTHENTICATION_NOT_OBSERVED");
  }
  context.checkpoints.recordAuthentication(record, {
    authenticatedOrigin: signal.authenticatedOrigin,
    observedAt: signal.observedAt,
    signals: [...new Set(signal.signals)].sort(),
  }, authenticationEvidenceReference(signal));
  respondHtml(response, 200, page("Sign-in confirmed",
    `Page2WebMCP has confirmed a signed-in session on ${record.targetOrigin}. You can close this page.`));
}
