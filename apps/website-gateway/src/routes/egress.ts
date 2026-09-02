import { badRequest, conflict, unavailable } from "../errors.ts";
import { PolicyRejected, validRoutes, type PolicyStore } from "../stores/policies.ts";
import type { EgressEnforcer } from "../stores/enforcement.ts";
import { SECRET_REFERENCE } from "../constants.ts";
import { workerResponse, type WorkerEnvelope } from "../envelope.ts";
import type { RouteResult } from "./types.ts";

export function issuePolicy(store: PolicyStore, envelope: WorkerEnvelope, now: Date): RouteResult {
  const { denyByDefault, ttlSeconds, routes, targetOrigin } = envelope.payload;
  if (typeof targetOrigin !== "string") throw badRequest("GATEWAY_POLICY_REQUEST_INVALID");
  try {
    const issued = store.issue({
      denyByDefault: denyByDefault === true,
      ttlSeconds: typeof ttlSeconds === "number" ? ttlSeconds : Number.NaN,
      routes: routes as never,
      targetOrigin,
      idempotencyKey: envelope.idempotencyKey,
    }, now);
    return { status: 200, body: workerResponse(envelope, issued) };
  } catch (error) {
    if (error instanceof PolicyRejected) throw badRequest(`GATEWAY_${error.message}`);
    throw error;
  }
}

export function revokeIssuedPolicy(store: PolicyStore, envelope: WorkerEnvelope): RouteResult {
  const reference = envelope.payload.reference;
  if (typeof reference !== "string" || !SECRET_REFERENCE.test(reference)) {
    throw badRequest("GATEWAY_POLICY_REQUEST_INVALID");
  }
  if (!store.revoke(reference)) throw conflict("GATEWAY_POLICY_UNKNOWN");
  return { status: 200, body: workerResponse(envelope, { revoked: true }) };
}

export function revokeEnforcedPolicy(enforcer: EgressEnforcer, envelope: WorkerEnvelope): RouteResult {
  const reference = envelope.payload.reference;
  if (typeof reference !== "string" || !SECRET_REFERENCE.test(reference)) {
    throw badRequest("GATEWAY_POLICY_REQUEST_INVALID");
  }
  // Attests only that this proxy is no longer enforcing the reference, which is
  // true whether or not it was ever installed here.
  enforcer.revoke(reference);
  return { status: 200, body: workerResponse(envelope, { revoked: true }) };
}

export function applyPolicy(
  enforcer: EgressEnforcer,
  store: PolicyStore | undefined,
  envelope: WorkerEnvelope,
  now: Date,
): RouteResult {
  const { denyByDefault, expiresAt, routes, targetOrigin, reference } = envelope.payload;
  if (denyByDefault !== true || typeof targetOrigin !== "string" || typeof expiresAt !== "string"
    || typeof reference !== "string" || !SECRET_REFERENCE.test(reference)
    || !validRoutes(routes, targetOrigin)) throw badRequest("GATEWAY_POLICY_REQUEST_INVALID");
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) throw conflict("GATEWAY_POLICY_EXPIRED");
  // When the issuing store is co-located, the applied policy must be exactly the
  // one that was issued. When it is not, this proxy can only verify the request
  // is internally consistent (see the deployment notes).
  if (store && !store.matching(reference, { routes, targetOrigin, expiresAt }, now)) {
    throw conflict("GATEWAY_POLICY_NOT_ISSUED");
  }
  try {
    enforcer.install({ reference, denyByDefault: true, routes, targetOrigin, expiresAtMs: expiry });
  } catch {
    throw unavailable("GATEWAY_POLICY_ENFORCEMENT_FAILED");
  }
  if (!enforcer.check({ method: "GET", url: `${targetOrigin}/`, now })
    || enforcer.check({ method: "POST", url: `${targetOrigin}/`, now })) {
    enforcer.revoke(reference);
    throw unavailable("GATEWAY_POLICY_ENFORCEMENT_FAILED");
  }
  return { status: 200, body: workerResponse(envelope, { enforced: true }) };
}
