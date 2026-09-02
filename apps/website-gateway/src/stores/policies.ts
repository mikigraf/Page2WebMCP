import { randomUUID } from "node:crypto";
import { MAX_POLICY_TTL_MS } from "../constants.ts";
import { sameJson } from "../canonical.ts";
import type { EgressRoute } from "./enforcement.ts";

export type PolicyIssueInput = Readonly<{
  denyByDefault: boolean;
  ttlSeconds: number;
  routes: readonly EgressRoute[];
  targetOrigin: string;
  idempotencyKey: string;
}>;

type PolicyRecord = Readonly<{
  reference: string;
  routes: readonly EgressRoute[];
  targetOrigin: string;
  expiresAt: string;
  expiresAtMs: number;
  revoked: boolean;
}>;

export type PolicyStore = Readonly<{
  issue(input: PolicyIssueInput, now: Date): Readonly<{ reference: string; expiresAt: string }>;
  matching(
    reference: string,
    expected: Readonly<{ routes: readonly EgressRoute[]; targetOrigin: string; expiresAt: string }>,
    now: Date,
  ): PolicyRecord | undefined;
  live(reference: string, now: Date): PolicyRecord | undefined;
  revoke(reference: string): boolean;
}>;

export class PolicyRejected extends Error {
  constructor(reason: "POLICY_TTL_INVALID" | "POLICY_ROUTES_INVALID") {
    super(reason);
    this.name = "PolicyRejected";
  }
}

/** A route set is acceptable only when it is read-only and confined to the target origin. */
export function validRoutes(routes: unknown, targetOrigin: string): routes is readonly EgressRoute[] {
  return Array.isArray(routes) && routes.length === 1
    && sameJson(routes, [{ methods: ["GET", "HEAD"], origin: targetOrigin, pathPrefix: "/" }]);
}

export function createPolicyStore(): PolicyStore {
  const byReference = new Map<string, PolicyRecord>();
  const byIdempotencyKey = new Map<string, string>();

  const store: PolicyStore = {
    issue(input, now) {
      if (input.denyByDefault !== true) throw new PolicyRejected("POLICY_ROUTES_INVALID");
      if (!validRoutes(input.routes, input.targetOrigin)) throw new PolicyRejected("POLICY_ROUTES_INVALID");
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1
        || input.ttlSeconds * 1_000 > MAX_POLICY_TTL_MS) throw new PolicyRejected("POLICY_TTL_INVALID");
      const existing = byIdempotencyKey.get(input.idempotencyKey);
      const replayed = existing ? byReference.get(existing) : undefined;
      if (replayed && !replayed.revoked && replayed.expiresAtMs > now.getTime()) {
        return { reference: replayed.reference, expiresAt: replayed.expiresAt };
      }
      const expiresAtMs = now.getTime() + input.ttlSeconds * 1_000;
      const expiresAt = new Date(expiresAtMs).toISOString();
      const reference = `secretref:policy.${randomUUID()}`;
      byReference.set(reference, {
        reference, routes: input.routes, targetOrigin: input.targetOrigin,
        expiresAt, expiresAtMs, revoked: false,
      });
      byIdempotencyKey.set(input.idempotencyKey, reference);
      return { reference, expiresAt };
    },
    live(reference, now) {
      const record = byReference.get(reference);
      if (!record || record.revoked || record.expiresAtMs <= now.getTime()) return undefined;
      return record;
    },
    matching(reference, expected, now) {
      const record = store.live(reference, now);
      if (!record || record.targetOrigin !== expected.targetOrigin || record.expiresAt !== expected.expiresAt
        || !sameJson(record.routes, expected.routes)) return undefined;
      return record;
    },
    revoke(reference) {
      const record = byReference.get(reference);
      if (!record) return false;
      byReference.set(reference, { ...record, revoked: true });
      return true;
    },
  };
  return store;
}
