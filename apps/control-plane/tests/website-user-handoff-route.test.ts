import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GET as projectDetail } from "../app/api/projects/[projectId]/route.ts";
import {
  GET as ownershipStatus,
  POST as mutateOwnership,
} from "../app/api/projects/[projectId]/website-ownership/route.ts";
import { POST as analyze } from "../app/api/projects/analyze/route.ts";
import { GET as analysisStatus } from "../app/api/analysis-runs/[runId]/route.ts";
import { GET as workflowStatus } from "../app/api/workflow-runs/[runId]/route.ts";
import {
  InMemoryControlPlaneRepository,
  RepositoryError,
} from "../../../packages/database/src/control-plane.ts";
import type {
  WebsiteOwnershipState,
  WebsiteUserHandoffBinding,
  WebsiteUserHandoffPort,
} from "../src/website-user-handoff.ts";
import { setWebsiteUserHandoffPortForTest } from "../src/website-user-handoff.ts";
import { authenticatedHeaders, installTestRepository, owner, viewer } from "./auth-test-helpers.ts";

const pendingOwnership: WebsiteOwnershipState = {
  state: "pending",
  method: "well_known",
  targetOrigin: "https://widgets.example",
  expiresAt: "2026-09-01T12:10:00.000Z",
  instructions: {
    url: "https://widgets.example/.well-known/page2webmcp-verification.txt",
    content: `page2webmcp-verification=${"A".repeat(43)}\norigin=https://widgets.example\nexpires=2026-09-01T12:10:00.000Z\n`,
  },
};
const verifiedOwnership: WebsiteOwnershipState = {
  state: "verified",
  targetOrigin: "https://widgets.example",
};
function handoffPort(input: Readonly<{
  ownership?: WebsiteOwnershipState;
  onBinding?: (binding: WebsiteUserHandoffBinding) => void;
}> = {}): WebsiteUserHandoffPort {
  const ownership = input.ownership ?? verifiedOwnership;
  return {
    ownershipStatus: async (binding) => { input.onBinding?.(binding); return ownership; },
    issueOwnershipChallenge: async (binding) => { input.onBinding?.(binding); return ownership; },
    checkOwnership: async (binding) => { input.onBinding?.(binding); return ownership; },
  };
}

async function websiteProject(repository: InMemoryControlPlaneRepository) {
  return repository.createProject(owner, {
    name: "Widgets support",
    sourceType: "website",
    url: "https://widgets.example/support",
    sourceConfiguration: { kind: "website" },
    idempotencyKey: `website-project-${crypto.randomUUID()}`,
    inputHash: "website-project-input",
  });
}

function routeContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function runContext(runId: string) {
  return { params: Promise.resolve({ runId }) };
}

test("an authenticated user obtains and checks active-source ownership instructions before analysis", async () => {
  const repository = installTestRepository();
  const project = await websiteProject(repository);
  const [source] = await repository.listProjectSources(owner, project.id);
  const [snapshot] = await repository.listSourceSnapshots(owner, project.id);
  const bindings: WebsiteUserHandoffBinding[] = [];
  setWebsiteUserHandoffPortForTest(handoffPort({
    ownership: pendingOwnership,
    onBinding: (binding) => bindings.push(binding),
  }));
  const headers = authenticatedHeaders(owner);

  const challenge = await mutateOwnership(new Request(
    `https://control.example/api/projects/${project.id}/website-ownership`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "ownership-challenge-route" },
      body: JSON.stringify({ action: "challenge" }),
    },
  ), routeContext(project.id));
  assert.equal(challenge.status, 200);
  assert.deepEqual(await challenge.json(), {
    ownership: pendingOwnership,
    canAnalyze: false,
  });

  setWebsiteUserHandoffPortForTest(handoffPort({ ownership: verifiedOwnership }));
  const checked = await mutateOwnership(new Request(
    `https://control.example/api/projects/${project.id}/website-ownership`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "ownership-check-route" },
      body: JSON.stringify({ action: "check" }),
    },
  ), routeContext(project.id));
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { ownership: verifiedOwnership, canAnalyze: true });

  const current = await ownershipStatus(new Request(
    `https://control.example/api/projects/${project.id}/website-ownership`,
    { headers: { cookie: headers.cookie } },
  ), routeContext(project.id));
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { ownership: verifiedOwnership, canAnalyze: true });

  assert.deepEqual(bindings[0], {
    organizationId: owner.organizationId,
    projectId: project.id,
    projectSourceId: source!.id,
    sourceSnapshotId: snapshot!.id,
    sourceIdentityHash: snapshot!.sourceIdentityHash,
    sourceUrl: "https://widgets.example/support",
    targetOrigin: "https://widgets.example",
  });
  assert.doesNotMatch(JSON.stringify(await (await projectDetail(new Request(
    `https://control.example/api/projects/${project.id}`,
    { headers: { cookie: headers.cookie } },
  ), routeContext(project.id))).json()), /operator_token|secretref:|cdp/i);
});

test("ownership mutation requires session-bound CSRF and website projects", async () => {
  const repository = installTestRepository();
  const website = await websiteProject(repository);
  let controlCalls = 0;
  setWebsiteUserHandoffPortForTest(handoffPort({ onBinding: () => { controlCalls += 1; } }));
  const signed = authenticatedHeaders(owner);
  const missingCsrf = await mutateOwnership(new Request(
    `https://control.example/api/projects/${website.id}/website-ownership`,
    {
      method: "POST",
      headers: { cookie: signed.cookie, "content-type": "application/json", "idempotency-key": "ownership-no-csrf" },
      body: JSON.stringify({ action: "check" }),
    },
  ), routeContext(website.id));
  assert.equal(missingCsrf.status, 403);

  const viewerHeaders = authenticatedHeaders(viewer);
  const viewerDenied = await mutateOwnership(new Request(
    `https://control.example/api/projects/${website.id}/website-ownership`,
    {
      method: "POST",
      headers: {
        ...viewerHeaders,
        "content-type": "application/json",
        "idempotency-key": "ownership-viewer-denied",
      },
      body: JSON.stringify({ action: "check" }),
    },
  ), routeContext(website.id));
  assert.equal(viewerDenied.status, 403);
  assert.equal((await viewerDenied.json()).code, "FORBIDDEN");
  assert.equal(controlCalls, 0);

  const openapi = await repository.createProject(owner, {
    name: "Widgets API",
    sourceType: "openapi",
    url: "https://widgets.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: "https://widgets.example",
      testPageUrl: "https://widgets.example/test",
      environment: "test",
    },
    idempotencyKey: "openapi-project-handoff-route",
    inputHash: "openapi-project-handoff-route",
  });
  const wrongSource = await ownershipStatus(new Request(
    `https://control.example/api/projects/${openapi.id}/website-ownership`,
    { headers: { cookie: signed.cookie } },
  ), routeContext(openapi.id));
  assert.equal(wrongSource.status, 409);
  assert.equal((await wrongSource.json()).code, "SOURCE_TYPE_UNSUPPORTED");

  const missingProject = await ownershipStatus(new Request(
    "https://control.example/api/projects/99999999-9999-4999-8999-999999999999/website-ownership",
    { headers: { cookie: signed.cookie } },
  ), routeContext("99999999-9999-4999-8999-999999999999"));
  assert.equal(missingProject.status, 404);
  assert.equal((await missingProject.json()).code, "NOT_FOUND");
});

test("website ownership handoffs cannot cross tenant boundaries", async () => {
  const repository = installTestRepository();
  const project = await websiteProject(repository);
  const otherMembership = {
    ...owner,
    organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  repository.seedMembershipForTest(otherMembership);
  let controlCalls = 0;
  setWebsiteUserHandoffPortForTest(handoffPort({ onBinding: () => { controlCalls += 1; } }));
  const headers: Record<string, string> = {
    ...authenticatedHeaders(owner),
    "x-page2webmcp-organization-id": otherMembership.organizationId,
  };

  const ownership = await ownershipStatus(new Request(
    `https://control.example/api/projects/${project.id}/website-ownership`,
    { headers: { cookie: headers["cookie"]!, "x-page2webmcp-organization-id": headers["x-page2webmcp-organization-id"]! } },
  ), routeContext(project.id));
  assert.equal(ownership.status, 404);
  assert.equal((await ownership.json()).code, "NOT_FOUND");

  assert.equal(controlCalls, 0);
});

test("website analysis is rejected until the exact active source is externally attested", async () => {
  const repository = installTestRepository();
  const project = await websiteProject(repository);
  const headers = authenticatedHeaders(owner);
  setWebsiteUserHandoffPortForTest(handoffPort({ ownership: pendingOwnership }));
  const blocked = await analyze(new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": "analysis-before-ownership" },
    body: JSON.stringify({ projectId: project.id }),
  }));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "WEBSITE_OWNERSHIP_REQUIRED");
  assert.equal(await repository.getLatestAnalysis(owner, project.id), undefined);

  setWebsiteUserHandoffPortForTest(handoffPort({ ownership: verifiedOwnership }));
  const accepted = await analyze(new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": "analysis-after-ownership" },
    body: JSON.stringify({ projectId: project.id }),
  }));
  assert.equal(accepted.status, 202);
  assert.match((await accepted.json()).runId, /^[0-9a-f-]{36}$/);
});

test("website analysis atomically pins the attested source and reports a concurrent source change", async () => {
  const repository = installTestRepository();
  const project = await websiteProject(repository);
  const [source] = await repository.listProjectSources(owner, project.id);
  const [snapshot] = await repository.listSourceSnapshots(owner, project.id);
  const enqueue = repository.enqueueAnalysis.bind(repository);
  let expectedSource: unknown;
  repository.enqueueAnalysis = async (_actor, input) => {
    expectedSource = input.expectedSource;
    throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
  };
  setWebsiteUserHandoffPortForTest(handoffPort({ ownership: verifiedOwnership }));
  const headers = authenticatedHeaders(owner);
  const response = await analyze(new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": "analysis-source-race" },
    body: JSON.stringify({ projectId: project.id }),
  }));
  repository.enqueueAnalysis = enqueue;

  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "SOURCE_SNAPSHOT_STALE");
  assert.deepEqual(expectedSource, {
    projectSourceId: source!.id,
    sourceSnapshotId: snapshot!.id,
    sourceIdentityHash: snapshot!.sourceIdentityHash,
  });
  assert.equal(await repository.getLatestAnalysis(owner, project.id), undefined);
});

test("accepted website analysis idempotency replay does not depend on a later ownership-store response", async () => {
  const repository = installTestRepository();
  const project = await websiteProject(repository);
  const headers = authenticatedHeaders(owner);
  let ownershipCalls = 0;
  setWebsiteUserHandoffPortForTest(handoffPort({
    ownership: verifiedOwnership,
    onBinding: () => { ownershipCalls += 1; },
  }));
  const request = () => new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "idempotency-key": "analysis-owned-replay" },
    body: JSON.stringify({ projectId: project.id }),
  });
  const first = await analyze(request());
  assert.equal(first.status, 202);
  const firstBody = await first.json();

  setWebsiteUserHandoffPortForTest({
    ...handoffPort(),
    ownershipStatus: async () => { throw new Error("WEBSITE_HANDOFF_UNAVAILABLE"); },
  });
  const replay = await analyze(request());
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(ownershipCalls, 1);
});

test("website run projections expose only exact durable authentication wait and terminal phases", async () => {
  const repository = installTestRepository();
  const project = await websiteProject(repository);
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "website-authentication-run",
    inputHash: "website-authentication-run",
  });
  const headers = authenticatedHeaders(owner);

  const workflow = await workflowStatus(new Request(
    `https://control.example/api/workflow-runs/${run.id}`,
    { headers: { cookie: headers.cookie } },
  ), runContext(run.id));
  assert.equal(workflow.status, 200);
  const projected = await workflow.json();
  assert.deepEqual(projected.websiteUserHandoff, {
    ownership: {
      endpoint: `/api/projects/${project.id}/website-ownership`,
      requiredBeforeAnalysis: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(projected.websiteUserHandoff), /authentication|handoffUrl|cdp|secretref:/i);

  const analysis = await analysisStatus(new Request(
    `https://control.example/api/analysis-runs/${run.id}`,
    { headers: { cookie: headers.cookie } },
  ), runContext(run.id));
  assert.equal(analysis.status, 200);
  assert.deepEqual((await analysis.json()).websiteUserHandoff, projected.websiteUserHandoff);

  const snapshot = (await repository.listSourceSnapshots(owner, project.id))[0];
  assert.ok(snapshot);
  const claim = await repository.claimAnalysis("website-authentication-projection-worker", 60_000, ["website"]);
  assert.equal(claim?.id, run.id);
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await repository.waitAnalysisForAuthentication("website-authentication-projection-worker", run.id, {
    checkpointReference: `urn:sha256:${"c".repeat(64)}`,
    sourceSnapshotId: claim!.sourceSnapshotId,
    sourceIdentityHash: snapshot.sourceIdentityHash,
    targetOriginDigest: createHash("sha256").update("https://widgets.example", "utf8").digest("hex"),
    expiresAt,
    idempotencyKey: "website-authentication-projection-wait",
    inputHash: "website-authentication-projection-wait",
  }, claim!.leaseGeneration);

  const waitingWorkflow = await workflowStatus(new Request(
    `https://control.example/api/workflow-runs/${run.id}`,
    { headers: { cookie: headers.cookie } },
  ), runContext(run.id));
  assert.equal(waitingWorkflow.status, 200);
  const waitingProjection = (await waitingWorkflow.json()).websiteUserHandoff;
  assert.deepEqual(waitingProjection, {
    ownership: {
      endpoint: `/api/projects/${project.id}/website-ownership`,
      requiredBeforeAnalysis: true,
    },
    authentication: {
      endpoint: `/api/workflow-runs/${run.id}/website-authentication`,
      state: "waiting",
    },
  });
  assert.doesNotMatch(JSON.stringify(waitingProjection), /handoffUrl|portalUrl|cdp|secretref:/i);

  const waitingAnalysis = await analysisStatus(new Request(
    `https://control.example/api/analysis-runs/${run.id}`,
    { headers: { cookie: headers.cookie } },
  ), runContext(run.id));
  assert.equal(waitingAnalysis.status, 200);
  assert.deepEqual((await waitingAnalysis.json()).websiteUserHandoff, waitingProjection);

  await repository.cancelWorkflow(owner, {
    runId: run.id,
    idempotencyKey: "website-authentication-projection-cancel",
    inputHash: "website-authentication-projection-cancel",
  });
  const cancelledWorkflow = await workflowStatus(new Request(
    `https://control.example/api/workflow-runs/${run.id}`,
    { headers: { cookie: headers.cookie } },
  ), runContext(run.id));
  assert.equal(cancelledWorkflow.status, 200);
  const cancelledProjection = (await cancelledWorkflow.json()).websiteUserHandoff;
  assert.deepEqual(cancelledProjection, {
    ownership: {
      endpoint: `/api/projects/${project.id}/website-ownership`,
      requiredBeforeAnalysis: true,
    },
    authentication: {
      endpoint: `/api/workflow-runs/${run.id}/website-authentication`,
      state: "cancelled",
    },
  });
  const cancelledAnalysis = await analysisStatus(new Request(
    `https://control.example/api/analysis-runs/${run.id}`,
    { headers: { cookie: headers.cookie } },
  ), runContext(run.id));
  assert.equal(cancelledAnalysis.status, 200);
  assert.deepEqual((await cancelledAnalysis.json()).websiteUserHandoff, cancelledProjection);
});
