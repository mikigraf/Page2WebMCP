import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/capabilities/[capabilityId]/review/route.ts";
import { authenticate, issueSession } from "../src/auth.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { setControlPlaneRepositoryForTest } from "../../../packages/database/src/factory.ts";

const owner = authenticate("owner@example.test", "fixture-password")!;
const editor = authenticate("editor@example.test", "fixture-password")!;

async function fixture(repository: InMemoryControlPlaneRepository) {
  const project = await repository.createProject(owner, {
    name: "Acme",
    sourceType: "website",
    url: "https://acme.example/",
    idempotencyKey: "review-project",
    inputHash: "review-project"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "review-analysis",
    inputHash: "input"
  });
  await repository.claimAnalysis("worker", 60_000);
  await repository.completeAnalysis("worker", run.id, {
    capabilities: [
      { stableName: "find_order", riskTier: "R0", status: "proposed" },
      { stableName: "create_support_ticket", riskTier: "R1", status: "proposed" },
      { stableName: "delete_account", riskTier: "R3", status: "blocked" }
    ],
    evidence: [],
    release: { code: "export {};", contentHash: "candidate", allowedOrigin: "https://acme.example" }
  });
  return repository.listCapabilities(owner, project.id);
}

function reviewRequest(capabilityId: string, actor: typeof owner, body: unknown): Request {
  return new Request(`https://control.example/api/capabilities/${capabilityId}/review`, {
    method: "POST",
    headers: {
      cookie: `page2webmcp_session=${issueSession(actor)}`,
      origin: "https://control.example",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

test("review loads risk from persisted capability and advances an optimistic version", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const capabilities = await fixture(repository);
  const ticket = capabilities.find((item) => item.stableName === "create_support_ticket")!;
  const response = await POST(
    reviewRequest(ticket.id, owner, { action: "approve", expectedVersion: 1 }),
    { params: Promise.resolve({ capabilityId: ticket.id }) }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.capability.status, "reviewed");
  assert.equal(body.capability.version, 2);

  const stale = await POST(
    reviewRequest(ticket.id, owner, { action: "approve", expectedVersion: 1 }),
    { params: Promise.resolve({ capabilityId: ticket.id }) }
  );
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "VERSION_CONFLICT");
});

test("R1 requires owner, R3 remains blocked, and caller-supplied risk is rejected", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const capabilities = await fixture(repository);
  const ticket = capabilities.find((item) => item.stableName === "create_support_ticket")!;
  const blocked = capabilities.find((item) => item.stableName === "delete_account")!;

  const editorResponse = await POST(
    reviewRequest(ticket.id, editor, { action: "approve", expectedVersion: 1 }),
    { params: Promise.resolve({ capabilityId: ticket.id }) }
  );
  assert.equal(editorResponse.status, 403);
  assert.equal((await editorResponse.json()).code, "OWNER_APPROVAL_REQUIRED");

  const r3 = await POST(
    reviewRequest(blocked.id, owner, { action: "approve", expectedVersion: 1 }),
    { params: Promise.resolve({ capabilityId: blocked.id }) }
  );
  assert.equal(r3.status, 409);
  assert.equal((await r3.json()).code, "HIGH_RISK_ACTION");

  const forgedRisk = await POST(
    reviewRequest(ticket.id, owner, { action: "approve", expectedVersion: 1, riskTier: "R0" }),
    { params: Promise.resolve({ capabilityId: ticket.id }) }
  );
  assert.equal(forgedRisk.status, 400);

  const malformedId = await POST(
    reviewRequest("not-a-uuid", owner, { action: "approve", expectedVersion: 1 }),
    { params: Promise.resolve({ capabilityId: "not-a-uuid" }) }
  );
  assert.equal(malformedId.status, 404);
});
