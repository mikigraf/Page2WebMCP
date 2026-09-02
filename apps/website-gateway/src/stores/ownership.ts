import { randomBytes } from "node:crypto";
import { MAX_OWNERSHIP_CHALLENGE_TTL_MS } from "../constants.ts";
import { sha256Hex } from "../canonical.ts";

export type OwnershipChallenge = Readonly<{
  method: "dns_txt" | "well_known";
  targetOrigin: string;
  token: string;
  expiresAt: string;
}>;

export type OwnershipState = "missing" | "pending" | "verified" | "expired" | "failed";

type AttestationRecord = Readonly<{
  organizationId: string;
  projectId: string;
  sourceIdentityHash: string;
  sourceUrl: string;
  challenge: OwnershipChallenge;
  expiresAtMs: number;
  state: Exclude<OwnershipState, "missing" | "expired">;
}>;

export type OwnershipBinding = Readonly<{
  organizationId: string;
  projectId: string;
  sourceIdentityHash: string;
  sourceUrl: string;
  targetOrigin: string;
}>;

export type OwnershipVerifier = Readonly<{
  verify(
    challenge: OwnershipChallenge,
    signal: AbortSignal,
  ): Promise<Readonly<{ verified: boolean; reason?: string }>>;
}>;

export type OwnershipStore = Readonly<{
  issue(binding: OwnershipBinding, now: Date): Readonly<{ state: OwnershipState; challenge: OwnershipChallenge }>;
  status(binding: OwnershipBinding, now: Date): Readonly<{ state: OwnershipState; challenge?: OwnershipChallenge }>;
  record(binding: OwnershipBinding, now: Date): AttestationRecord | undefined;
  settle(binding: OwnershipBinding, verified: boolean, now: Date): Readonly<{ state: OwnershipState; challenge?: OwnershipChallenge }>;
  verified(
    input: Readonly<{ organizationId: string; projectId: string; targetOrigin: string }>,
    now: Date,
  ): AttestationRecord | undefined;
}>;

function key(binding: Readonly<{ organizationId: string; projectId: string; sourceIdentityHash: string }>): string {
  return `${binding.organizationId}\0${binding.projectId}\0${binding.sourceIdentityHash}`;
}

export function createOwnershipStore(): OwnershipStore {
  const records = new Map<string, AttestationRecord>();

  const live = (identity: string, now: Date): AttestationRecord | undefined => {
    const record = records.get(identity);
    if (!record) return undefined;
    if (record.expiresAtMs <= now.getTime()) { records.delete(identity); return undefined; }
    return record;
  };

  const store: OwnershipStore = {
    issue(binding, now) {
      const existing = live(key(binding), now);
      if (existing && existing.state === "verified" && existing.challenge.targetOrigin === binding.targetOrigin) {
        return { state: "verified", challenge: existing.challenge };
      }
      const expiresAtMs = now.getTime() + MAX_OWNERSHIP_CHALLENGE_TTL_MS;
      const challenge: OwnershipChallenge = {
        method: "dns_txt",
        targetOrigin: binding.targetOrigin,
        token: randomBytes(36).toString("base64url"),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      records.set(key(binding), {
        organizationId: binding.organizationId,
        projectId: binding.projectId,
        sourceIdentityHash: binding.sourceIdentityHash,
        sourceUrl: binding.sourceUrl,
        challenge,
        expiresAtMs,
        state: "pending",
      });
      return { state: "pending", challenge };
    },
    status(binding, now) {
      const record = live(key(binding), now);
      if (!record) return { state: records.has(key(binding)) ? "expired" : "missing" };
      return { state: record.state, challenge: record.challenge };
    },
    record: (binding, now) => live(key(binding), now),
    settle(binding, verified, now) {
      const record = live(key(binding), now);
      if (!record) return { state: "missing" };
      const settled: AttestationRecord = { ...record, state: verified ? "verified" : "failed" };
      records.set(key(binding), settled);
      return { state: settled.state, challenge: settled.challenge };
    },
    verified(input, now) {
      for (const identity of [...records.keys()]) {
        const record = live(identity, now);
        if (record && record.state === "verified" && record.organizationId === input.organizationId
          && record.projectId === input.projectId
          && record.challenge.targetOrigin === input.targetOrigin) return record;
      }
      return undefined;
    },
  };
  return store;
}

export function challengeDigest(challenge: OwnershipChallenge): string {
  return sha256Hex(challenge.token);
}

export type ReplayStore = Readonly<{ consume(key: string, expiresAt: string, now: Date): boolean }>;

/** Single-use keys with a bounded horizon; per-process, so a restart forgets them. */
export function createReplayStore(): ReplayStore {
  const consumed = new Map<string, number>();
  return {
    consume(replayKey, expiresAt, now) {
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now.getTime()
        || expiry - now.getTime() > MAX_OWNERSHIP_CHALLENGE_TTL_MS) return false;
      for (const [stored, expiresAtMs] of consumed) {
        if (expiresAtMs <= now.getTime()) consumed.delete(stored);
      }
      if (consumed.has(replayKey)) return false;
      consumed.set(replayKey, expiry);
      return true;
    },
  };
}
