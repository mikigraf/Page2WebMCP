import { randomUUID } from "node:crypto";
import { MAX_LEASE_TTL_MS } from "../constants.ts";

export type LeaseOwnership = Readonly<{ organizationId: string; projectId: string; runId: string }>;

export type LeaseClaimInput = Readonly<{
  ownership: LeaseOwnership;
  targetOrigin: string;
  expiresAt: string;
  policyDigest: string;
  idempotencyKey: string;
}>;

type LeaseRecord = Readonly<{
  leaseId: string;
  ownership: LeaseOwnership;
  targetOrigin: string;
  expiresAtMs: number;
  expiresAt: string;
  policyDigest: string;
}>;

export type LeaseStore = Readonly<{
  claim(input: LeaseClaimInput, now: Date): Readonly<{ leaseId: string }>;
  release(leaseId: string, now: Date): boolean;
  active(leaseId: string, now: Date): LeaseRecord | undefined;
}>;

export class LeaseRejected extends Error {
  constructor(reason: "LEASE_TTL_INVALID" | "LEASE_HELD" | "LEASE_UNKNOWN") {
    super(reason);
    this.name = "LeaseRejected";
  }
}

/**
 * Exclusive per-run browser lease. State is per-process: a restart drops every
 * lease, so an operator must run one replica of the lease control per pool.
 */
export function createLeaseStore(): LeaseStore {
  const byLeaseId = new Map<string, LeaseRecord>();
  const activeByRun = new Map<string, string>();
  const byIdempotencyKey = new Map<string, string>();

  const live = (leaseId: string | undefined, now: Date): LeaseRecord | undefined => {
    if (!leaseId) return undefined;
    const record = byLeaseId.get(leaseId);
    if (!record) return undefined;
    if (record.expiresAtMs <= now.getTime()) {
      byLeaseId.delete(leaseId);
      if (activeByRun.get(record.ownership.runId) === leaseId) activeByRun.delete(record.ownership.runId);
      return undefined;
    }
    return record;
  };

  return {
    claim(input, now) {
      const expiry = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry - now.getTime() > MAX_LEASE_TTL_MS) {
        throw new LeaseRejected("LEASE_TTL_INVALID");
      }
      const replayed = live(byIdempotencyKey.get(input.idempotencyKey), now);
      if (replayed) return { leaseId: replayed.leaseId };
      if (live(activeByRun.get(input.ownership.runId), now)) throw new LeaseRejected("LEASE_HELD");
      const leaseId = `lease-${randomUUID()}`;
      byLeaseId.set(leaseId, {
        leaseId,
        ownership: input.ownership,
        targetOrigin: input.targetOrigin,
        expiresAtMs: expiry,
        expiresAt: input.expiresAt,
        policyDigest: input.policyDigest,
      });
      activeByRun.set(input.ownership.runId, leaseId);
      byIdempotencyKey.set(input.idempotencyKey, leaseId);
      return { leaseId };
    },
    release(leaseId, now) {
      const record = live(leaseId, now);
      if (!record || activeByRun.get(record.ownership.runId) !== leaseId) return false;
      byLeaseId.delete(leaseId);
      activeByRun.delete(record.ownership.runId);
      return true;
    },
    active: (leaseId, now) => live(leaseId, now),
  };
}
