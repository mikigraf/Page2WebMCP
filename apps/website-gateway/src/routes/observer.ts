import { canonicalJson, sameJson, sha256Hex } from "../canonical.ts";
import { HEX64, SECRET_REFERENCE, UPSTREAM_TIMEOUT_MS } from "../constants.ts";
import { badRequest, conflict, unavailable } from "../errors.ts";
import { colocated, type GatewayContext } from "../context.ts";
import { workerResponse, type WorkerEnvelope } from "../envelope.ts";
import { readGatewaySecret } from "../stores/secrets.ts";
import type { RouteResult } from "./types.ts";

function expectedPolicy(targetOrigin: string): Record<string, unknown> {
  return { denyByDefault: true, routes: [{ methods: ["GET", "HEAD"], origin: targetOrigin, pathPrefix: "/" }] };
}

export async function observe(context: GatewayContext, envelope: WorkerEnvelope): Promise<RouteResult> {
  const { phase, targetOrigin, sourceUrl, cdpReference, routePolicy, routePolicyDigest } = envelope.payload;
  if (!["unauthenticated", "authenticated"].includes(String(phase)) || typeof targetOrigin !== "string"
    || typeof sourceUrl !== "string" || typeof cdpReference !== "string" || !SECRET_REFERENCE.test(cdpReference)
    || typeof routePolicyDigest !== "string" || !HEX64.test(routePolicyDigest)) {
    throw badRequest("GATEWAY_OBSERVATION_REQUEST_INVALID");
  }
  if (!sameJson(routePolicy, expectedPolicy(targetOrigin))
    || sha256Hex(canonicalJson(routePolicy)) !== routePolicyDigest) {
    throw badRequest("GATEWAY_OBSERVATION_POLICY_INVALID");
  }
  let source: URL;
  try { source = new URL(sourceUrl); } catch { throw badRequest("GATEWAY_OBSERVATION_REQUEST_INVALID"); }
  if (source.origin !== targetOrigin) throw badRequest("GATEWAY_OBSERVATION_POLICY_INVALID");
  if (!colocated(context, "ttl-secret-store")) throw unavailable("GATEWAY_SECRET_RESOLUTION_UNAVAILABLE");
  const now = context.clock();
  const cdpUrl = readGatewaySecret(cdpReference, now);
  if (!cdpUrl) throw conflict("GATEWAY_OBSERVATION_SECRET_EXPIRED");
  if (!context.cdpObserver) throw unavailable("GATEWAY_CDP_OBSERVER_UNAVAILABLE");

  let consulted = 0;
  const allow = (method: string, url: string): boolean => {
    consulted += 1;
    if (!["GET", "HEAD"].includes(method)) return false;
    let candidate: URL;
    try { candidate = new URL(url); } catch { return false; }
    if (candidate.origin !== targetOrigin) return false;
    return context.enforcer.check({ method, url, now: context.clock() });
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("GATEWAY_OBSERVATION_TIMEOUT")), UPSTREAM_TIMEOUT_MS * 6);
  timer.unref?.();
  let observed;
  try {
    observed = await context.cdpObserver.observe({
      phase: phase as "unauthenticated" | "authenticated",
      targetOrigin,
      sourceUrl,
      cdpUrl,
      allow,
      signal: controller.signal,
    });
  } catch {
    throw unavailable("GATEWAY_OBSERVATION_FAILED");
  } finally { clearTimeout(timer); }
  if (!observed || typeof observed.requiresAuthentication !== "boolean" || !observed.observations) {
    throw unavailable("GATEWAY_OBSERVATION_FAILED");
  }
  // `enforced` is only claimed when the deny-by-default gate above was actually
  // consulted for the traffic this observation produced.
  if (consulted === 0) throw unavailable("GATEWAY_OBSERVATION_ENFORCEMENT_UNPROVEN");
  return {
    status: 200,
    body: workerResponse(envelope, {
      enforced: true,
      requiresAuthentication: observed.requiresAuthentication,
      observations: observed.observations,
    }),
  };
}
