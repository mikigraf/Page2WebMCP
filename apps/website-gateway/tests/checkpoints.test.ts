import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBrowserUseResumeAttestation,
  browserUseSuspensionCheckpointReference,
} from "../../../packages/providers/src/browser-use-v4.ts";
import { startGateway, testEnvironment, canonicalJson, sha256Hex, TEST_KMS_KEY_ID, TEST_TOKENS, type GatewayHarness } from "./harness.ts";

const authToken = TEST_TOKENS["authentication-handoff"];
const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT = "44444444-4444-4444-8444-444444444444";
const WORKFLOW_RUN = "55555555-5555-4555-8555-555555555555";
const WORKFLOW_TASK = "66666666-6666-4666-8666-666666666666";
const TARGET_ORIGIN = "https://widgets.example";
const ownership = { organizationId: ORGANIZATION, projectId: PROJECT, runId: RUN };

function workerEnvelope(operation: string, payload: Record<string, unknown>): Record<string, unknown> {
  const identity = { ...payload };
  delete identity.outcome;
  return {
    gatewayProtocolVersion: 1,
    idempotencyKey: `website:${RUN}:authentication:${operation}:${sha256Hex(canonicalJson(identity))}`,
    ownership,
    ...payload,
  };
}

function uiEnvelope(checkpointReference: string, expiresAt: string, suffix: string): Record<string, unknown> {
  return {
    gatewayProtocolVersion: 1,
    idempotencyKey: `website-ui:${sha256Hex(suffix)}`,
    scope: { organizationId: ORGANIZATION, projectId: PROJECT },
    workflow: { workflowRunId: WORKFLOW_RUN, analysisRunId: RUN, workflowTaskId: WORKFLOW_TASK },
    checkpoint: {
      sourceSnapshotId: SNAPSHOT,
      sourceIdentityHash: "b".repeat(64),
      targetOrigin: TARGET_ORIGIN,
      targetOriginDigest: sha256Hex(TARGET_ORIGIN),
      checkpointReference,
      expiresAt,
    },
  };
}

const observedAt = "2026-08-31T12:01:00.000Z";
const browserUseUpstream = {
  verifyCredentials: async () => ({ apiVersion: "v4" as const, authenticated: true as const, model: "browser-use-2.0" as const }),
  startSession: async () => { throw new Error("UNUSED"); },
  stopSession: async () => undefined,
  reconcileSession: async () => ({ terminated: true as const }),
};

const authenticationObserver = {
  observe: async (input: Readonly<{ targetOrigin: string }>) => ({
    authenticatedOrigin: input.targetOrigin,
    observedAt,
    signals: ["account_control"] as const,
  }),
};

const evidenceContent = JSON.stringify({ version: 1, kind: "public" });
const publicEvidenceReference = `urn:sha256:${sha256Hex(evidenceContent)}`;

async function prepared(current: Date, gateway: GatewayHarness) {
  const expiresAt = new Date(current.getTime() + 9 * 60_000).toISOString();
  const key = (operation: string, payload: Record<string, unknown>) => ({
    gatewayProtocolVersion: 1,
    idempotencyKey: `website:${RUN}:1:${operation}:${sha256Hex(canonicalJson(payload))}`,
    ownership,
    ...payload,
  });
  const routes = [{ methods: ["GET", "HEAD"], origin: TARGET_ORIGIN, pathPrefix: "/" }];
  const issued = await gateway.json("/v1/website-egress-policies/issue",
    key("policy-issue", { denyByDefault: true, ttlSeconds: 540, routes, targetOrigin: TARGET_ORIGIN }),
    { token: TEST_TOKENS["egress-policy-store"] });
  const egressPolicyReference = String(issued.body?.reference);

  const claimed = await gateway.json("/v1/browser-leases/claim", key("lease-claim", {
    ...ownership, targetOrigin: TARGET_ORIGIN, expiresAt, policyDigest: "c".repeat(64),
  }), { token: TEST_TOKENS["browser-lease-store"] });
  const leaseId = String(claimed.body?.leaseId);

  const secret = async (purpose: string, value: string) => {
    const response = await gateway.json("/v1/ttl-secrets/put", key(`secret-put-${purpose}`, {
      value, purpose, expiresAt, valueDigest: sha256Hex(value), kmsKeyId: TEST_KMS_KEY_ID,
    }), { token: TEST_TOKENS["ttl-secret-store"] });
    return String(response.body?.reference);
  };
  const liveReference = await secret("browser_live_url", "https://live.browser-use.com/session/1");
  const cdpReference = await secret("browser_cdp_url", "wss://cdp.browser-use.com/session/1");

  await gateway.json("/v1/website-evidence/put", key("evidence-put", {
    record: {
      organizationId: ORGANIZATION, projectId: PROJECT, analysisRunId: RUN,
      source: "runtime", content: evidenceContent, reference: publicEvidenceReference,
    },
  }), { token: TEST_TOKENS["evidence-store"] });

  const binding = {
    sourceSnapshotId: SNAPSHOT,
    sourceIdentityHash: "b".repeat(64),
    targetOriginDigest: sha256Hex(TARGET_ORIGIN),
    publicEvidenceReference,
    egressPolicyReference,
    egressPolicyDigest: "d".repeat(64),
    ...ownership,
    providerSessionId: "provider-session-1",
    liveReference,
    cdpReference,
    leaseId,
    browserPolicyDigest: "c".repeat(64),
    expiresAt,
  };
  return { binding, expiresAt, egressPolicyReference, leaseId, cdpReference };
}

function resumePayload(checkpointReference: string, expiresAt: string, overrides: Record<string, unknown> = {}) {
  return {
    checkpointReference,
    ...ownership,
    sourceSnapshotId: SNAPSHOT,
    sourceIdentityHash: "b".repeat(64),
    targetOriginDigest: sha256Hex(TARGET_ORIGIN),
    expiresAt,
    ...overrides,
  };
}

async function createdCheckpoint(current: Date, gateway: GatewayHarness) {
  const context = await prepared(current, gateway);
  const created = await gateway.json("/v1/authentication/checkpoints/create",
    workerEnvelope("checkpoint-create", { binding: context.binding }), { token: authToken });
  return { ...context, created };
}

test("checkpoint create binds the exact run and returns an attestation with no session material", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, authenticationObserver, browserUseUpstream });
  try {
    const { created, binding } = await createdCheckpoint(current, gateway);
    assert.equal(created.status, 200);
    const attestation = created.body?.attestation as Record<string, unknown>;
    assert.ok(attestation);
    assert.equal(attestation.suspended, true);
    assert.equal(attestation.authenticationCheckpointProtocolVersion, 1);
    assert.equal(attestation.providerSessionIdDigest, sha256Hex("provider-session-1"));
    assert.equal("providerSessionId" in (created.body ?? {}), false);
    assert.doesNotMatch(created.raw, /provider-session-1/);
    assert.doesNotMatch(created.raw, /cdp\.browser-use\.com/);
    const { checkpointReference, ...content } = attestation;
    assert.equal(checkpointReference, browserUseSuspensionCheckpointReference(content as never));
    assert.equal(attestation.expiresAt, binding.expiresAt);
  } finally { await gateway.close(); }
});

test("checkpoint create refuses an expired lease and an expired secret", async () => {
  let current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, authenticationObserver, browserUseUpstream });
  try {
    const context = await prepared(current, gateway);
    current = new Date(current.getTime() + 10 * 60_000);
    const created = await gateway.json("/v1/authentication/checkpoints/create",
      workerEnvelope("checkpoint-create", { binding: context.binding }), { token: authToken });
    assert.equal(created.status, 409);
  } finally { await gateway.close(); }
});

test("checkpoint create refuses a binding whose lease or secret belongs to another run", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, authenticationObserver, browserUseUpstream });
  try {
    const { binding } = await prepared(current, gateway);
    const foreign = await gateway.json("/v1/authentication/checkpoints/create",
      workerEnvelope("checkpoint-create", { binding: { ...binding, leaseId: "lease-unknown" } }), { token: authToken });
    assert.equal(foreign.status, 409);
    const foreignSecret = await gateway.json("/v1/authentication/checkpoints/create",
      workerEnvelope("checkpoint-create", { binding: { ...binding, cdpReference: "secretref:unknown" } }), { token: authToken });
    assert.equal(foreignSecret.status, 409);
  } finally { await gateway.close(); }
});

test("resume admits exactly one success and rejects the replay", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, authenticationObserver, browserUseUpstream });
  try {
    const { created, expiresAt, cdpReference } = await createdCheckpoint(current, gateway);
    const reference = String((created.body?.attestation as Record<string, unknown>).checkpointReference);

    const portal = await gateway.json("/v1/authentication/checkpoints/portal",
      uiEnvelope(reference, expiresAt, "portal"), { token: authToken });
    assert.equal(portal.status, 200);
    assert.equal(portal.body?.state, "waiting");
    const portalUrl = new URL(String(portal.body?.portalUrl));
    const handoff = portalUrl.searchParams.get("handoff")!;

    const verified = await fetch(`${gateway.origin}/portal/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handoff }).toString(),
    });
    assert.equal(verified.status, 200);

    const status = await gateway.json("/v1/authentication/checkpoints/status",
      uiEnvelope(reference, expiresAt, "status"), { token: authToken });
    assert.equal(status.body?.status, "ready");
    assert.match(String(status.body?.authenticationEvidenceReference), /^urn:sha256:[0-9a-f]{64}$/);

    const workerStatus = await gateway.json("/v1/authentication/checkpoints/status",
      workerEnvelope("checkpoint-status", resumePayload(reference, expiresAt)), { token: authToken });
    assert.equal(workerStatus.body?.status, "ready");

    const payload = resumePayload(reference, expiresAt);
    const resumed = await gateway.json("/v1/authentication/checkpoints/resume",
      workerEnvelope("checkpoint-resume", payload), { token: authToken });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body?.resumed, true);
    assert.equal(resumed.body?.cdpReference, cdpReference);
    assert.equal(resumed.body?.publicEvidenceReference, publicEvidenceReference);
    const attestation = assertBrowserUseResumeAttestation(resumed.body?.suspensionAttestation, {
      checkpointReference: reference, ...ownership, sourceSnapshotId: SNAPSHOT,
      sourceIdentityHash: "b".repeat(64), targetOriginDigest: sha256Hex(TARGET_ORIGIN), expiresAt,
    });
    assert.equal(attestation.cdpReference, resumed.body?.cdpReference);
    assert.deepEqual(resumed.body?.authentication, {
      authenticatedOrigin: TARGET_ORIGIN, observedAt, signals: ["account_control"],
    });

    const replayed = await gateway.json("/v1/authentication/checkpoints/resume",
      workerEnvelope("checkpoint-resume", payload), { token: authToken });
    assert.equal(replayed.status, 409);
    assert.equal(replayed.body?.resumed, undefined);
  } finally { await gateway.close(); }
});

test("resume refuses a wrong owner, a wrong checkpoint, an unverified human handoff and an expired checkpoint", async () => {
  let current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, authenticationObserver, browserUseUpstream });
  try {
    const { created, expiresAt } = await createdCheckpoint(current, gateway);
    const reference = String((created.body?.attestation as Record<string, unknown>).checkpointReference);

    const unverified = await gateway.json("/v1/authentication/checkpoints/resume",
      workerEnvelope("checkpoint-resume", resumePayload(reference, expiresAt)), { token: authToken });
    assert.equal(unverified.status, 409);

    await gateway.json("/v1/authentication/checkpoints/portal", uiEnvelope(reference, expiresAt, "portal"), { token: authToken });

    const unknown = await gateway.json("/v1/authentication/checkpoints/resume",
      workerEnvelope("checkpoint-resume", resumePayload(`urn:sha256:${"9".repeat(64)}`, expiresAt)), { token: authToken });
    assert.equal(unknown.status, 404);

    const wrongOwner = {
      ...resumePayload(reference, expiresAt),
      organizationId: "77777777-7777-4777-8777-777777777777",
    };
    const foreign = await gateway.json("/v1/authentication/checkpoints/resume", {
      gatewayProtocolVersion: 1,
      idempotencyKey: `website:${RUN}:authentication:checkpoint-resume:${sha256Hex(canonicalJson(wrongOwner))}`,
      ownership: { ...ownership, organizationId: "77777777-7777-4777-8777-777777777777" },
      ...wrongOwner,
    }, { token: authToken });
    assert.equal(foreign.status, 403);

    current = new Date(current.getTime() + 10 * 60_000);
    const expired = await gateway.json("/v1/authentication/checkpoints/resume",
      workerEnvelope("checkpoint-resume", resumePayload(reference, expiresAt)), { token: authToken });
    assert.equal(expired.status, 409);
  } finally { await gateway.close(); }
});

test("finalize and reconcile report the cleanup they actually performed", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, authenticationObserver, browserUseUpstream });
  try {
    const { created, expiresAt } = await createdCheckpoint(current, gateway);
    const reference = String((created.body?.attestation as Record<string, unknown>).checkpointReference);
    const payload = { ...resumePayload(reference, expiresAt), outcome: "completed" };
    const finalized = await gateway.json("/v1/authentication/checkpoints/finalize",
      workerEnvelope("checkpoint-finalize", payload), { token: authToken });
    assert.equal(finalized.status, 200);
    assert.equal(finalized.body?.finalized, true);
    const resources = finalized.body?.cleanupResources as Array<Record<string, unknown>>;
    assert.equal(resources.length, 7);
    assert.deepEqual([...resources].map(({ resource }) => resource).sort(), [
      "authentication_handoff_checkpoint", "browser_lease", "browser_session", "cdp_observation_lease",
      "egress_policy_proxy", "evidence_lease", "ttl_secrets",
    ]);
    assert.ok(resources.every((item) => /^[0-9a-f]{64}$/.test(String(item.identityDigest))));
    const disposition = (resource: string) =>
      resources.find((item) => item.resource === resource)?.disposition;
    assert.equal(disposition("authentication_handoff_checkpoint"), "destroyed");
    assert.equal(disposition("browser_lease"), "released");
    assert.equal(disposition("browser_session"), "destroyed");
    assert.equal(disposition("egress_policy_proxy"), "revoked");
    assert.equal(disposition("evidence_lease"), "retained_immutable");
    assert.equal(disposition("ttl_secrets"), "destroyed");

    const reconciled = await gateway.json("/v1/authentication/checkpoints/reconcile",
      workerEnvelope("checkpoint-reconcile", payload), { token: authToken });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body?.reconciled, true);
    assert.equal(reconciled.body?.terminated, true);
    assert.equal((reconciled.body?.cleanupResources as unknown[]).length, 7);
  } finally { await gateway.close(); }
});

test("binding-form reconcile reports ownership honestly for a checkpoint it never created", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current, authenticationObserver, browserUseUpstream });
  try {
    const { binding } = await prepared(current, gateway);
    const aborted = await gateway.json("/v1/authentication/checkpoints/reconcile",
      workerEnvelope("checkpoint-abort", { binding, outcome: "failed" }), { token: authToken });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body?.reconciled, true);
    assert.equal(aborted.body?.checkpointOwned, false);
    assert.equal(aborted.body?.terminated, false);
  } finally { await gateway.close(); }
});
