import { SECRET_REFERENCE } from "../constants.ts";
import { badRequest, conflict } from "../errors.ts";
import { SecretRejected, type SecretStore } from "../stores/secrets.ts";
import type { WorkerEnvelope } from "../envelope.ts";
import type { RouteResult } from "./types.ts";

export function putSecret(store: SecretStore, envelope: WorkerEnvelope, now: Date): RouteResult {
  const { value, purpose, expiresAt, valueDigest, kmsKeyId } = envelope.payload;
  if (typeof value !== "string" || typeof purpose !== "string" || typeof expiresAt !== "string"
    || typeof valueDigest !== "string" || typeof kmsKeyId !== "string") {
    throw badRequest("GATEWAY_SECRET_REQUEST_INVALID");
  }
  try {
    const stored = store.put({
      value, purpose, expiresAt, valueDigest, kmsKeyId, ownership: envelope.ownership,
    }, now);
    // The response is built field by field: the plaintext is never in scope for it.
    return {
      status: 200,
      body: {
        gatewayProtocolVersion: envelope.gatewayProtocolVersion,
        idempotencyKey: envelope.idempotencyKey,
        ownership: envelope.ownership,
        purpose,
        expiresAt: stored.expiresAt,
        kmsKeyId,
        valueDigest,
        reference: stored.reference,
      },
    };
  } catch (error) {
    if (error instanceof SecretRejected) throw badRequest(`GATEWAY_${error.message}`);
    throw error;
  }
}

export function revokeSecret(store: SecretStore, envelope: WorkerEnvelope): RouteResult {
  const reference = envelope.payload.reference;
  if (typeof reference !== "string" || !SECRET_REFERENCE.test(reference)) {
    throw badRequest("GATEWAY_SECRET_REQUEST_INVALID");
  }
  if (!store.revoke(reference)) throw conflict("GATEWAY_SECRET_UNKNOWN");
  return {
    status: 200,
    body: {
      gatewayProtocolVersion: envelope.gatewayProtocolVersion,
      idempotencyKey: envelope.idempotencyKey,
      ownership: envelope.ownership,
      reference,
      revoked: true,
    },
  };
}
