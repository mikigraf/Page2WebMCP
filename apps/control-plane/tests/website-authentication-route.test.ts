import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  GET as authenticationState,
  POST as mutateAuthentication,
} from "../app/api/workflow-runs/[runId]/website-authentication/route.ts";
import {
  InMemoryControlPlaneRepository,
  type ClaimedAnalysisRunRecord,
} from "../../../packages/database/src/control-plane.ts";
import {
  setWebsiteAuthenticationHandoffPortForTest,
  type WebsiteAuthenticationHandoffBinding,
  type WebsiteAuthenticationHandoffPort,
} from "../src/website-user-handoff.ts";
import { authenticatedHeaders, installTestRepository, owner, viewer } from "./auth-test-helpers.ts";

const CHECKPOINT_REFERENCE = `urn:sha256:${"a".repeat(64)}`;
const EVIDENCE_REFERENCE = `urn:sha256:${"b".repeat(64)}`;
const TARGET_ORIGIN = "https://widgets.example";
const TEST_NOW = new Date("2099-09-01T12:00:00.000Z");
const EXPIRES_AT = "2099-09-01T12:08:00.000Z";

function runContext(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

async function waitingWebsite(
  repository: InMemoryControlPlaneRepository,
  suffix: string,
  expiresAt = EXPIRES_AT,
): Promise<Readonly<{
  projectId: string;
  runId: string;
  claim: ClaimedAnalysisRunRecord;
  sourceIdentityHash: string;
}>> {
  const project = await repository.createProject(owner, {
    name: `Authentication UI ${suffix}`,
    sourceType: "website",
    url: `${TARGET_ORIGIN}/support`,
    sourceConfiguration: { kind: "website" },
    idempotencyKey: `authentication-ui-project-${suffix}`,
    inputHash: `authentication-ui-project-${suffix}`,
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: `authentication-ui-analysis-${suffix}`,
    inputHash: `authentication-ui-analysis-${suffix}`,
  });
  const snapshot = (await repository.listSourceSnapshots(owner, project.id))[0];
  assert.ok(snapshot);
  const claim = await repository.claimAnalysis(`authentication-ui-worker-${suffix}`, 60_000, ["website"]);
  assert.equal(claim?.id, run.id);
  await repository.waitAnalysisForAuthentication(`authentication-ui-worker-${suffix}`, run.id, {
    checkpointReference: CHECKPOINT_REFERENCE,
    sourceSnapshotId: claim!.sourceSnapshotId,
    sourceIdentityHash: snapshot.sourceIdentityHash,
    targetOriginDigest: createHash("sha256").update(TARGET_ORIGIN, "utf8").digest("hex"),
    expiresAt,
    idempotencyKey: `authentication-ui-wait-${suffix}`,
    inputHash: `authentication-ui-wait-${suffix}`,
  }, claim!.leaseGeneration);
  return { projectId: project.id, runId: run.id, claim: claim!, sourceIdentityHash: snapshot.sourceIdentityHash };
}

function handoffPort(input: Readonly<{
  onPortal?: (binding: WebsiteAuthenticationHandoffBinding) => void;
  onCheck?: (binding: WebsiteAuthenticationHandoffBinding, idempotencyKey: string) => void;
  checkState?: "ready" | "failed" | "cancelled" | "expired";
}> = {}): WebsiteAuthenticationHandoffPort {
  return {
    loadAuthenticationPortal: async (binding) => {
      input.onPortal?.(binding);
      return {
        state: "waiting",
        targetOrigin: TARGET_ORIGIN,
        expiresAt: EXPIRES_AT,
        portalUrl: "https://authentication.example/portal?handoff=fixture-safe-reference",
      };
    },
    checkAuthentication: async (binding, idempotencyKey) => {
      input.onCheck?.(binding, idempotencyKey);
      if (input.checkState && input.checkState !== "ready") {
        return {
          state: input.checkState,
          targetOrigin: TARGET_ORIGIN,
          expiresAt: EXPIRES_AT,
        };
      }
      return {
        state: "ready",
        targetOrigin: TARGET_ORIGIN,
        expiresAt: EXPIRES_AT,
        authenticationEvidenceReference: EVIDENCE_REFERENCE,
      };
    },
  };
}

test("website authentication GET restores a safe exact portal for editors while viewers receive no action URL", async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository(
    () => TEST_NOW,
  ));
  const waiting = await waitingWebsite(repository, "projection");
  const bindings: WebsiteAuthenticationHandoffBinding[] = [];
  setWebsiteAuthenticationHandoffPortForTest(handoffPort({ onPortal: (binding) => bindings.push(binding) }));

  const ownerResponse = await authenticationState(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`,
    { headers: { cookie: authenticatedHeaders(owner).cookie } },
  ), runContext(waiting.runId));
  assert.equal(ownerResponse.status, 200);
  assert.deepEqual(await ownerResponse.json(), {
    authentication: {
      state: "waiting",
      targetOrigin: TARGET_ORIGIN,
      expiresAt: EXPIRES_AT,
      canAct: true,
      portalUrl: "https://authentication.example/portal?handoff=fixture-safe-reference",
    },
  });
  assert.equal(bindings.length, 1);
  assert.deepEqual(bindings[0], {
    organizationId: owner.organizationId,
    projectId: waiting.projectId,
    workflowRunId: waiting.runId,
    analysisRunId: waiting.runId,
    workflowTaskId: waiting.claim.workflowTaskId,
    sourceSnapshotId: waiting.claim.sourceSnapshotId,
    sourceIdentityHash: waiting.sourceIdentityHash,
    targetOrigin: TARGET_ORIGIN,
    targetOriginDigest: createHash("sha256").update(TARGET_ORIGIN, "utf8").digest("hex"),
    checkpointReference: CHECKPOINT_REFERENCE,
    expiresAt: EXPIRES_AT,
  });

  const viewerResponse = await authenticationState(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`,
    { headers: { cookie: authenticatedHeaders(viewer).cookie } },
  ), runContext(waiting.runId));
  assert.equal(viewerResponse.status, 200);
  const viewerBody = await viewerResponse.json();
  assert.deepEqual(viewerBody, {
    authentication: {
      state: "waiting",
      targetOrigin: TARGET_ORIGIN,
      expiresAt: EXPIRES_AT,
      canAct: false,
    },
  });
  assert.equal(bindings.length, 1, "viewer GET must not request an actionable gateway portal");
  assert.doesNotMatch(JSON.stringify(viewerBody), /portal|secretref|cdp|providerSession|token|cookie/i);
});

test("an expired durable checkpoint never opens a portal and remains recoverable after reconciliation", async () => {
  let now = new Date("2000-01-01T12:00:00.000Z");
  const expiresAt = "2000-01-01T12:08:00.000Z";
  const repository = installTestRepository(new InMemoryControlPlaneRepository(() => now));
  const waiting = await waitingWebsite(repository, "expired", expiresAt);
  let portalCalls = 0;
  setWebsiteAuthenticationHandoffPortForTest(handoffPort({ onPortal: () => { portalCalls += 1; } }));
  const request = () => new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`,
    { headers: { cookie: authenticatedHeaders(owner).cookie } },
  );

  const beforeReconciliation = await authenticationState(request(), runContext(waiting.runId));
  assert.equal(beforeReconciliation.status, 200);
  assert.deepEqual(await beforeReconciliation.json(), {
    authentication: {
      state: "expired",
      targetOrigin: TARGET_ORIGIN,
      expiresAt,
      canAct: false,
    },
  });
  assert.equal(portalCalls, 0);

  now = new Date("2000-01-01T12:09:00.000Z");
  assert.equal(await repository.reconcileWorkflows("authentication-expiry-reconciler"), 1);
  const afterRestart = await authenticationState(request(), runContext(waiting.runId));
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(await afterRestart.json(), {
    authentication: {
      state: "expired",
      targetOrigin: TARGET_ORIGIN,
      expiresAt,
      canAct: false,
    },
  });
  assert.equal(portalCalls, 0);
});

test("server-verified authentication evidence atomically resumes once and survives a fresh route load", async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository(
    () => TEST_NOW,
  ));
  const waiting = await waitingWebsite(repository, "resume");
  let checks = 0;
  setWebsiteAuthenticationHandoffPortForTest(handoffPort({ onCheck: () => { checks += 1; } }));
  const headers = authenticatedHeaders(owner);
  const request = (idempotencyKey = "authentication-ui-resume") => new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ action: "check" }),
    },
  );

  const resumed = await mutateAuthentication(request(), runContext(waiting.runId));
  assert.equal(resumed.status, 200);
  const resumedBody = {
    authentication: {
      state: "resumed",
      targetOrigin: TARGET_ORIGIN,
      expiresAt: EXPIRES_AT,
      canAct: false,
    },
  };
  assert.deepEqual(await resumed.json(), resumedBody);
  const checkpoint = await repository.getWebsiteAuthenticationWait(owner, waiting.runId);
  assert.equal(checkpoint?.state, "consumed");
  assert.equal(checkpoint?.authenticationEvidenceReference, EVIDENCE_REFERENCE);
  assert.equal((await repository.getAnalysis(owner, waiting.runId)).status, "queued");

  const replay = await mutateAuthentication(request("authentication-ui-resume-new-tab"), runContext(waiting.runId));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), resumedBody);
  assert.equal(checks, 1, "durable consumed state must make a replay independent of the gateway");

  const reloaded = await authenticationState(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`,
    { headers: { cookie: headers.cookie } },
  ), runContext(waiting.runId));
  assert.equal(reloaded.status, 200);
  assert.deepEqual(await reloaded.json(), resumedBody);
});

test("a failed gateway status durably fails the exact wait and restart loads only PostgreSQL state", async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository(() => TEST_NOW));
  const waiting = await waitingWebsite(repository, "gateway-failed");
  let checks = 0;
  setWebsiteAuthenticationHandoffPortForTest(handoffPort({
    checkState: "failed",
    onCheck: () => { checks += 1; },
  }));
  const headers = authenticatedHeaders(owner);
  const failed = await mutateAuthentication(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "authentication-ui-failed" },
      body: JSON.stringify({ action: "check" }),
    },
  ), runContext(waiting.runId));
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), {
    authentication: {
      state: "failed",
      targetOrigin: TARGET_ORIGIN,
      expiresAt: EXPIRES_AT,
      canAct: false,
    },
  });
  assert.equal((await repository.getWebsiteAuthenticationWait(owner, waiting.runId))?.state, "failed");
  assert.equal((await repository.getWorkflowRun(owner, waiting.runId)).status, "failed");

  const reloaded = await authenticationState(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`,
    { headers: { cookie: headers.cookie } },
  ), runContext(waiting.runId));
  assert.equal(reloaded.status, 200);
  assert.equal((await reloaded.json()).authentication.state, "failed");
  assert.equal(checks, 1, "terminal reload must not depend on gateway availability");
});

test("gateway cancellation is persisted through workflow cancellation while an early expiry fails closed", async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository(() => TEST_NOW));
  const cancelledWait = await waitingWebsite(repository, "gateway-cancelled");
  setWebsiteAuthenticationHandoffPortForTest(handoffPort({ checkState: "cancelled" }));
  const headers = authenticatedHeaders(owner);
  const statusRequest = (runId: string, key: string) => new Request(
    `https://control.example/api/workflow-runs/${runId}/website-authentication`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ action: "check" }),
    },
  );
  const cancelled = await mutateAuthentication(
    statusRequest(cancelledWait.runId, "authentication-gateway-cancelled"),
    runContext(cancelledWait.runId),
  );
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).authentication.state, "cancelled");
  assert.equal((await repository.getWorkflowRun(owner, cancelledWait.runId)).status, "cancelled");

  const earlyExpiryRepository = installTestRepository(new InMemoryControlPlaneRepository(() => TEST_NOW));
  const expiredWait = await waitingWebsite(earlyExpiryRepository, "gateway-early-expired");
  setWebsiteAuthenticationHandoffPortForTest(handoffPort({ checkState: "expired" }));
  const rejected = await mutateAuthentication(
    statusRequest(expiredWait.runId, "authentication-gateway-early-expired"),
    runContext(expiredWait.runId),
  );
  assert.equal(rejected.status, 502);
  assert.equal((await rejected.json()).code, "WEBSITE_HANDOFF_RESPONSE_INVALID");
  assert.equal((await earlyExpiryRepository.getWebsiteAuthenticationWait(owner, expiredWait.runId))?.state, "waiting");
  assert.equal((await earlyExpiryRepository.getWorkflowRun(owner, expiredWait.runId)).status, "waiting");
});

test("authentication mutations enforce fresh tenant identity, viewer denial, CSRF, and bounded idempotency", async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository(
    () => TEST_NOW,
  ));
  const waiting = await waitingWebsite(repository, "authorization");
  let externalCalls = 0;
  setWebsiteAuthenticationHandoffPortForTest(handoffPort({ onCheck: () => { externalCalls += 1; } }));
  const ownerHeaders = authenticatedHeaders(owner);

  const noCsrf = await mutateAuthentication(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`, {
      method: "POST",
      headers: { cookie: ownerHeaders.cookie, "content-type": "application/json", "idempotency-key": "auth-no-csrf" },
      body: JSON.stringify({ action: "check" }),
    },
  ), runContext(waiting.runId));
  assert.equal(noCsrf.status, 403);

  const viewerHeaders = authenticatedHeaders(viewer);
  const viewerDenied = await mutateAuthentication(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`, {
      method: "POST",
      headers: { ...viewerHeaders, "content-type": "application/json", "idempotency-key": "auth-viewer-denied" },
      body: JSON.stringify({ action: "check" }),
    },
  ), runContext(waiting.runId));
  assert.equal(viewerDenied.status, 403);
  assert.equal((await viewerDenied.json()).code, "FORBIDDEN");

  const foreignViewer = {
    ...viewer,
    organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  repository.seedMembershipForTest(foreignViewer);
  const foreignViewerHeaders = {
    ...authenticatedHeaders(viewer),
    "x-page2webmcp-organization-id": foreignViewer.organizationId,
  };
  const foreignViewerDenied = await mutateAuthentication(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`, {
      method: "POST",
      headers: { ...foreignViewerHeaders, "content-type": "application/json", "idempotency-key": "auth-viewer-foreign" },
      body: JSON.stringify({ action: "check" }),
    },
  ), runContext(waiting.runId));
  assert.equal(foreignViewerDenied.status, 404);
  assert.equal((await foreignViewerDenied.json()).code, "NOT_FOUND");

  const randomViewerDenied = await mutateAuthentication(new Request(
    "https://control.example/api/workflow-runs/55555555-5555-4555-8555-555555555555/website-authentication", {
      method: "POST",
      headers: { ...viewerHeaders, "content-type": "application/json", "idempotency-key": "auth-viewer-random" },
      body: JSON.stringify({ action: "check" }),
    },
  ), runContext("55555555-5555-4555-8555-555555555555"));
  assert.equal(randomViewerDenied.status, 404);
  assert.equal((await randomViewerDenied.json()).code, "NOT_FOUND");

  const other = { ...owner, organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  repository.seedMembershipForTest(other);
  const otherHeaders = {
    ...authenticatedHeaders(owner),
    "x-page2webmcp-organization-id": other.organizationId,
  };
  const tenantDenied = await mutateAuthentication(new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`, {
      method: "POST",
      headers: { ...otherHeaders, "content-type": "application/json", "idempotency-key": "auth-tenant-denied" },
      body: JSON.stringify({ action: "check" }),
    },
  ), runContext(waiting.runId));
  assert.equal(tenantDenied.status, 404);
  assert.equal((await tenantDenied.json()).code, "NOT_FOUND");
  assert.equal(externalCalls, 0);
});

test("cancellation durably queues one worker-owned cleanup and is restart idempotent", async () => {
  const repository = installTestRepository(new InMemoryControlPlaneRepository(
    () => TEST_NOW,
  ));
  const waiting = await waitingWebsite(repository, "cancel");
  setWebsiteAuthenticationHandoffPortForTest(handoffPort());
  const headers = authenticatedHeaders(owner);
  const request = (idempotencyKey = "authentication-ui-cancel") => new Request(
    `https://control.example/api/workflow-runs/${waiting.runId}/website-authentication`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ action: "cancel" }),
    },
  );

  const cancelled = await mutateAuthentication(request(), runContext(waiting.runId));
  assert.equal(cancelled.status, 200);
  assert.equal((await repository.getWebsiteAuthenticationWait(owner, waiting.runId))?.state, "cancelled");
  const recovered = await mutateAuthentication(request("authentication-ui-cancel-new-tab"), runContext(waiting.runId));
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), {
    authentication: {
      state: "cancelled",
      targetOrigin: TARGET_ORIGIN,
      expiresAt: EXPIRES_AT,
      canAct: false,
    },
  });
  const cleanup = await repository.claimWebsiteAuthenticationCleanup("authentication-ui-cleanup-worker", 60_000);
  assert.equal(cleanup?.analysisRunId, waiting.runId);
  assert.equal(cleanup?.terminalState, "cancelled");
  assert.match(cleanup?.cleanupIdempotencyKey ?? "", /^website-auth-cleanup:[0-9a-f]{64}$/);
});
