import { GATEWAY_PROTOCOL_VERSION, IDEMPOTENCY_KEY, IDENTIFIER } from "./constants.ts";
import { badRequest, forbidden } from "./errors.ts";
import { isPlainRecord, sameJson } from "./canonical.ts";

export type Ownership = Readonly<{ organizationId: string; projectId: string; runId: string }>;

export type WorkerEnvelope = Readonly<{
  gatewayProtocolVersion: 1;
  idempotencyKey: string;
  ownership: Ownership;
  payload: Record<string, unknown>;
}>;

const RESERVED = new Set(["gatewayProtocolVersion", "idempotencyKey", "ownership"]);

/** Parses the worker's control envelope. Unknown protocol versions fail closed. */
export function parseWorkerEnvelope(body: Record<string, unknown>): WorkerEnvelope {
  if (body.gatewayProtocolVersion !== GATEWAY_PROTOCOL_VERSION) {
    throw badRequest("GATEWAY_PROTOCOL_VERSION_UNSUPPORTED");
  }
  if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    throw badRequest("GATEWAY_IDEMPOTENCY_KEY_INVALID");
  }
  const ownership = body.ownership;
  if (!isPlainRecord(ownership)
    || Object.keys(ownership).sort().join(",") !== "organizationId,projectId,runId"
    || !Object.values(ownership).every((value) => typeof value === "string" && IDENTIFIER.test(value))) {
    throw badRequest("GATEWAY_OWNERSHIP_INVALID");
  }
  const payload: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(body)) if (!RESERVED.has(name)) payload[name] = value;
  return {
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    idempotencyKey: body.idempotencyKey,
    ownership: ownership as unknown as Ownership,
    payload,
  };
}

/** Echoes the envelope the worker sent plus the fields this control attests. */
export function workerResponse(envelope: WorkerEnvelope, attested: Record<string, unknown>): Record<string, unknown> {
  return {
    gatewayProtocolVersion: envelope.gatewayProtocolVersion,
    idempotencyKey: envelope.idempotencyKey,
    ownership: envelope.ownership,
    ...envelope.payload,
    ...attested,
  };
}

export function assertOwnershipMatches(envelope: WorkerEnvelope, claimed: unknown, code: string): void {
  if (!sameJson(envelope.ownership, claimed)) throw forbidden(code);
}

export type UserEnvelope = Readonly<{
  gatewayProtocolVersion: 1;
  idempotencyKey: string;
  scope: Readonly<{ organizationId: string; projectId: string }>;
  workflow?: Record<string, unknown>;
  checkpoint?: Record<string, unknown>;
  source?: Record<string, unknown>;
}>;

/** Parses the control plane's operator-facing envelope (`website-ui:` keys). */
export function parseUserEnvelope(body: Record<string, unknown>): UserEnvelope | undefined {
  if (body.gatewayProtocolVersion !== GATEWAY_PROTOCOL_VERSION) return undefined;
  if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) return undefined;
  const scope = body.scope;
  if (!isPlainRecord(scope) || Object.keys(scope).sort().join(",") !== "organizationId,projectId"
    || !Object.values(scope).every((value) => typeof value === "string" && IDENTIFIER.test(value))) return undefined;
  const workflow = isPlainRecord(body.workflow) ? body.workflow : undefined;
  const checkpoint = isPlainRecord(body.checkpoint) ? body.checkpoint : undefined;
  const source = isPlainRecord(body.source) ? body.source : undefined;
  if (!source && !(workflow && checkpoint)) return undefined;
  return {
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    idempotencyKey: body.idempotencyKey,
    scope: scope as unknown as UserEnvelope["scope"],
    workflow,
    checkpoint,
    source,
  };
}

export function userResponse(envelope: UserEnvelope, attested: Record<string, unknown>): Record<string, unknown> {
  return {
    gatewayProtocolVersion: envelope.gatewayProtocolVersion,
    idempotencyKey: envelope.idempotencyKey,
    scope: envelope.scope,
    ...(envelope.workflow ? { workflow: envelope.workflow } : {}),
    ...(envelope.checkpoint ? { checkpoint: envelope.checkpoint } : {}),
    ...(envelope.source ? { source: envelope.source } : {}),
    ...attested,
  };
}
