import { IDENTIFIER } from "../constants.ts";
import { badRequest, conflict } from "../errors.ts";
import { LeaseRejected, type LeaseStore } from "../stores/leases.ts";
import { assertOwnershipMatches, workerResponse, type WorkerEnvelope } from "../envelope.ts";
import type { RouteResult } from "./types.ts";

export function claimLease(store: LeaseStore, envelope: WorkerEnvelope, now: Date): RouteResult {
  const { organizationId, projectId, runId, targetOrigin, expiresAt, policyDigest } = envelope.payload;
  assertOwnershipMatches(envelope, { organizationId, projectId, runId }, "GATEWAY_LEASE_OWNERSHIP_MISMATCH");
  if (typeof targetOrigin !== "string" || typeof expiresAt !== "string"
    || typeof policyDigest !== "string" || !/^[0-9a-f]{64}$/.test(policyDigest)) {
    throw badRequest("GATEWAY_LEASE_REQUEST_INVALID");
  }
  try {
    const claimed = store.claim({
      ownership: envelope.ownership,
      targetOrigin,
      expiresAt,
      policyDigest,
      idempotencyKey: envelope.idempotencyKey,
    }, now);
    return { status: 200, body: workerResponse(envelope, { leaseId: claimed.leaseId }) };
  } catch (error) {
    if (error instanceof LeaseRejected) {
      throw error.message === "LEASE_TTL_INVALID"
        ? badRequest("GATEWAY_LEASE_TTL_INVALID")
        : conflict("GATEWAY_LEASE_HELD");
    }
    throw error;
  }
}

export function releaseLease(store: LeaseStore, envelope: WorkerEnvelope, now: Date): RouteResult {
  const leaseId = envelope.payload.leaseId;
  if (typeof leaseId !== "string" || !IDENTIFIER.test(leaseId)) throw badRequest("GATEWAY_LEASE_REQUEST_INVALID");
  if (!store.release(leaseId, now)) throw conflict("GATEWAY_LEASE_NOT_HELD");
  return { status: 200, body: workerResponse(envelope, { released: true }) };
}
