import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryControlPlaneRepository, type RepositoryActor } from "./control-plane.ts";
import { computeSourceIdentityHash } from "./source-identity.ts";

const actor: RepositoryActor = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
};

test("worker source identity hashing exactly matches the persisted immutable source snapshot", async () => {
  const repository = new InMemoryControlPlaneRepository();
  repository.seedMembershipForTest(actor);
  const project = await repository.createProject(actor, {
    name: "Widgets",
    sourceType: "website",
    url: "https://widgets.example/app",
    sourceConfiguration: { kind: "website" },
    idempotencyKey: "source-identity-parity",
    inputHash: "source-identity-parity",
  });
  const [source] = await repository.listProjectSources(actor, project.id);
  const [snapshot] = await repository.listSourceSnapshots(actor, project.id);

  assert.equal(snapshot!.sourceIdentityHash, computeSourceIdentityHash(
    source!.sourceType,
    source!.sourceUrl,
    source!.sourceConfiguration,
  ));
});
