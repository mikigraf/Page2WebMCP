import { HEX64, IDENTIFIER, MAX_OWNERSHIP_CHALLENGE_TTL_MS } from "../constants.ts";
import { badRequest, conflict, unavailable } from "../errors.ts";
import {
  challengeDigest,
  OWNERSHIP_METHODS,
  type OwnershipBinding,
  type OwnershipMethod,
  type OwnershipStore,
  type OwnershipVerifier,
  type ReplayStore,
} from "../stores/ownership.ts";
import { assertOwnershipMatches, userResponse, workerResponse, type UserEnvelope, type WorkerEnvelope } from "../envelope.ts";
import type { RouteResult } from "./types.ts";

function exactHttpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.origin === value && url.href === `${value}/` ? value : undefined;
  } catch { return undefined; }
}

function binding(envelope: UserEnvelope): OwnershipBinding {
  const source = envelope.source ?? {};
  const targetOrigin = exactHttpsOrigin(source.targetOrigin);
  const sourceUrl = source.sourceUrl;
  if (!targetOrigin || typeof sourceUrl !== "string"
    || typeof source.sourceIdentityHash !== "string" || !HEX64.test(source.sourceIdentityHash)) {
    throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID");
  }
  let parsed: URL;
  try { parsed = new URL(sourceUrl); } catch { throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID"); }
  if (parsed.origin !== targetOrigin || parsed.protocol !== "https:") {
    throw badRequest("GATEWAY_OWNERSHIP_ORIGIN_MISMATCH");
  }
  return {
    organizationId: envelope.scope.organizationId,
    projectId: envelope.scope.projectId,
    sourceIdentityHash: source.sourceIdentityHash,
    sourceUrl,
    targetOrigin,
  };
}

function stateBody(
  envelope: UserEnvelope,
  state: string,
  challenge: Readonly<{ method: string; token: string; expiresAt: string }> | undefined,
  targetOrigin: string,
): RouteResult {
  if (state === "pending" && challenge) {
    return {
      status: 200,
      body: userResponse(envelope, {
        state, method: challenge.method, token: challenge.token, targetOrigin, expiresAt: challenge.expiresAt,
      }),
    };
  }
  return {
    status: 200,
    body: userResponse(envelope, {
      state,
      targetOrigin,
      ...(challenge ? { expiresAt: challenge.expiresAt } : {}),
    }),
  };
}

function requestedMethod(envelope: UserEnvelope): OwnershipMethod | undefined {
  const method = envelope.source?.method;
  if (method === undefined) return undefined;
  if (!OWNERSHIP_METHODS.includes(method as OwnershipMethod)) throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID");
  return method as OwnershipMethod;
}

export function issueSourceAttestation(store: OwnershipStore, envelope: UserEnvelope, now: Date): RouteResult {
  const input = binding(envelope);
  const issued = store.issue(input, now, requestedMethod(envelope));
  return stateBody(envelope, issued.state, issued.challenge, input.targetOrigin);
}

export function sourceAttestationStatus(store: OwnershipStore, envelope: UserEnvelope, now: Date): RouteResult {
  const input = binding(envelope);
  const status = store.status(input, now);
  return stateBody(envelope, status.state, status.challenge, input.targetOrigin);
}

export async function checkSourceAttestation(
  store: OwnershipStore,
  verifier: OwnershipVerifier | undefined,
  envelope: UserEnvelope,
  now: Date,
  signal: AbortSignal,
): Promise<RouteResult> {
  const input = binding(envelope);
  const record = store.record(input, now);
  if (!record) return stateBody(envelope, store.status(input, now).state, undefined, input.targetOrigin);
  if (record.state === "verified") return stateBody(envelope, "verified", record.challenge, input.targetOrigin);
  if (!verifier) throw unavailable("GATEWAY_OWNERSHIP_VERIFIER_UNAVAILABLE");
  let outcome;
  try { outcome = await verifier.verify(record.challenge, signal); }
  catch { throw unavailable("GATEWAY_OWNERSHIP_VERIFICATION_UNAVAILABLE"); }
  const settled = store.settle(input, outcome?.verified === true, now);
  return stateBody(envelope, settled.state, settled.challenge, input.targetOrigin);
}

export function consumeSourceAttestation(
  store: OwnershipStore,
  envelope: WorkerEnvelope,
  now: Date,
): RouteResult {
  const { organizationId, projectId, runId, sourceIdentityHash, sourceUrl, targetOrigin } = envelope.payload;
  assertOwnershipMatches(envelope, { organizationId, projectId, runId }, "GATEWAY_OWNERSHIP_MISMATCH");
  const origin = exactHttpsOrigin(targetOrigin);
  if (!origin || typeof sourceUrl !== "string" || typeof sourceIdentityHash !== "string"
    || !HEX64.test(sourceIdentityHash)) throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID");
  let parsed: URL;
  try { parsed = new URL(sourceUrl); } catch { throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID"); }
  if (parsed.origin !== origin) throw badRequest("GATEWAY_OWNERSHIP_ORIGIN_MISMATCH");
  const record = store.record({
    organizationId: envelope.ownership.organizationId,
    projectId: envelope.ownership.projectId,
    sourceIdentityHash,
    sourceUrl,
    targetOrigin: origin,
  }, now);
  if (!record || record.state !== "verified" || record.challenge.targetOrigin !== origin) {
    throw conflict("GATEWAY_OWNERSHIP_NOT_VERIFIED");
  }
  return {
    status: 200,
    body: workerResponse(envelope, { bound: true, challengeDigest: challengeDigest(record.challenge) }),
  };
}

export function loadOwnershipChallenge(
  store: OwnershipStore,
  envelope: WorkerEnvelope,
  now: Date,
): RouteResult {
  const { organizationId, projectId, runId, targetOrigin } = envelope.payload;
  assertOwnershipMatches(envelope, { organizationId, projectId, runId }, "GATEWAY_OWNERSHIP_MISMATCH");
  const origin = exactHttpsOrigin(targetOrigin);
  if (!origin) throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID");
  const record = store.verified({
    organizationId: envelope.ownership.organizationId,
    projectId: envelope.ownership.projectId,
    targetOrigin: origin,
  }, now);
  if (!record) throw conflict("GATEWAY_OWNERSHIP_NOT_VERIFIED");
  return {
    status: 200,
    body: {
      gatewayProtocolVersion: envelope.gatewayProtocolVersion,
      idempotencyKey: envelope.idempotencyKey,
      ownership: envelope.ownership,
      method: record.challenge.method,
      targetOrigin: record.challenge.targetOrigin,
      token: record.challenge.token,
      expiresAt: record.challenge.expiresAt,
    },
  };
}

export function consumeReplayKey(store: ReplayStore, envelope: WorkerEnvelope, now: Date): RouteResult {
  const { key, expiresAt } = envelope.payload;
  if (typeof key !== "string" || !IDENTIFIER.test(key) || typeof expiresAt !== "string") {
    throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID");
  }
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry - now.getTime() > MAX_OWNERSHIP_CHALLENGE_TTL_MS) {
    throw badRequest("GATEWAY_OWNERSHIP_REQUEST_INVALID");
  }
  return { status: 200, body: workerResponse(envelope, { consumed: store.consume(key, expiresAt, now) }) };
}
