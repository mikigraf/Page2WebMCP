import assert from "node:assert/strict";
import test from "node:test";
import { GET as getRun } from "../app/api/analysis-runs/[runId]/route.ts";
import { POST as analyze } from "../app/api/projects/analyze/route.ts";
import { authenticate, issueSession } from "../src/auth.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { setControlPlaneRepositoryForTest } from "../../../packages/database/src/factory.ts";

const actor = authenticate("owner@example.test", "fixture-password")!;
const cookie = `page2webmcp_session=${issueSession(actor)}`;

async function createFixtureProject(repository: InMemoryControlPlaneRepository, sourceType: "website" | "openapi" | "github") {
  return repository.createProject(actor, {
    name: "Acme Support",
    sourceType,
    url: sourceType === "github"
      ? "https://github.com/acme/support"
      : sourceType === "openapi"
        ? "https://acme.example/openapi.json"
        : "https://acme.example/",
    idempotencyKey: `project-${sourceType}-${crypto.randomUUID()}`,
    inputHash: `project-${sourceType}`
  });
}

function analysisRequest(projectId: string, key: string, sessionCookie = cookie): Request {
  return new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: {
      cookie: sessionCookie,
      origin: "https://control.example",
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({ projectId })
  });
}

for (const sourceType of ["website", "openapi", "github"] as const) {
  test(`analysis is bound to the persisted ${sourceType} project and exposes durable run state`, async () => {
    const repository = new InMemoryControlPlaneRepository();
    setControlPlaneRepositoryForTest(repository);
    const project = await createFixtureProject(repository, sourceType);

    const response = await analyze(analysisRequest(project.id, `analysis-${sourceType}`));
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.match(accepted.runId, /^[0-9a-f-]{36}$/);

    const status = await getRun(
      new Request(`https://control.example/api/analysis-runs/${accepted.runId}`, { headers: { cookie } }),
      { params: Promise.resolve({ runId: accepted.runId }) }
    );
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.run.status, "succeeded");
    assert.equal(body.projectId, project.id);
    if (sourceType === "github") {
      assert.equal(body.result.draftPullRequest.draft, true);
    } else {
      assert.deepEqual(body.capabilities.map((item: { stableName: string; status: string }) => [item.stableName, item.status]), [
        ["create_support_ticket", "proposed"],
        ["delete_account", "blocked"],
        ["find_order", "proposed"],
        ["get_order_status", "proposed"]
      ]);
    }
  });
}

test("analysis requires authentication and an idempotency key", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const project = await createFixtureProject(repository, "website");
  assert.equal((await analyze(analysisRequest(project.id, "anonymous", ""))).status, 401);

  const missingKey = new Request("https://control.example/api/projects/analyze", {
    method: "POST",
    headers: { cookie, origin: "https://control.example", "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id })
  });
  const response = await analyze(missingKey);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "IDEMPOTENCY_KEY_REQUIRED");
});

test("duplicate analysis requests return the original run", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const project = await createFixtureProject(repository, "openapi");
  const first = await analyze(analysisRequest(project.id, "same-analysis"));
  const second = await analyze(analysisRequest(project.id, "same-analysis"));
  assert.equal((await second.json()).runId, (await first.json()).runId);
});

test("fixture execution drains earlier queued work until the requested run completes", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const earlier = await createFixtureProject(repository, "website");
  await repository.enqueueAnalysis(actor, {
    projectId: earlier.id,
    idempotencyKey: "earlier-analysis",
    inputHash: "earlier"
  });
  const target = await createFixtureProject(repository, "openapi");
  const response = await analyze(analysisRequest(target.id, "target-analysis"));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "succeeded");
});
