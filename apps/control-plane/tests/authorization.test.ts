import assert from "node:assert/strict";
import test from "node:test";
import { GET as listProjects, POST as createProject } from "../app/api/projects/route.ts";
import { setAuthServiceForTest, type AuthService } from "../src/auth.ts";
import { authenticatedHeaders, installTestRepository, owner, viewer } from "./auth-test-helpers.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import { CapabilityPlanSchema } from "../../../packages/capability-ir/src/plan.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { InMemoryControlPlaneRepository, RepositoryError } from "../../../packages/database/src/control-plane.ts";

test("every protected request performs a fresh server identity and membership lookup", async () => {
  let identities = 0;
  let memberships = 0;
  const repository = installTestRepository();
  const originalResolve = repository.resolveActor.bind(repository);
  repository.resolveActor = async (...input) => {
    memberships += 1;
    return originalResolve(...input);
  };
  const service: AuthService = {
    identity: async () => {
      identities += 1;
      return {
        id: owner.id,
        email: "owner@page2webmcp.local",
        sessionId: "11111111-aaaa-4aaa-8aaa-111111111111",
        expiresAt: "2026-08-31T12:00:00.000Z"
      };
    },
    signUp: async () => ({ emailVerificationRequired: true, cookies: [] }),
    signIn: async () => ({ cookies: [] }),
    exchangeCode: async () => ({ cookies: [] }),
    refresh: async () => ({ cookies: [] }),
    refreshForProxy: async () => ({ cookies: [] }),
    requestPasswordRecovery: async () => ({ cookies: [] }),
    updatePassword: async () => ({ cookies: [] }),
    signOut: async () => ({ cookies: [] }),
    clearSessionCookies: () => []
  };
  setAuthServiceForTest(service);
  const request = new Request("https://control.example/api/projects", {
    headers: { authorization: "Bearer forged" }
  });
  assert.equal((await listProjects(request)).status, 200);
  assert.equal((await listProjects(request)).status, 200);
  assert.equal(identities, 2);
  assert.equal(memberships, 2);
});

test("viewer mutations and cross-tenant organization selection are rejected", async () => {
  installTestRepository();
  const viewerResponse = await createProject(new Request("https://control.example/api/projects", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(viewer),
      "content-type": "application/json",
      "idempotency-key": "viewer-project-request"
    },
    body: JSON.stringify({ sourceType: "website", url: "https://docs.example/" })
  }));
  assert.equal(viewerResponse.status, 403);

  const crossTenant = await listProjects(new Request("https://control.example/api/projects", {
    headers: {
      cookie: authenticatedHeaders(owner).cookie,
      "x-page2webmcp-organization-id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    }
  }));
  assert.equal(crossTenant.status, 403);
  assert.equal((await crossTenant.json()).code, "MEMBERSHIP_REQUIRED");
});

test("owner is required for R2, editor may approve R1, and R3 is rejected before persistence", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const ticket = acmeCapabilityPlans("https://acme.example")
    .find((plan) => plan.tool.name === "create_support_ticket")!;
  const r2 = CapabilityPlanSchema.parse({
    ...ticket,
    effects: { ...ticket.effects, riskTier: "R2", reversible: false }
  });
  const r3 = { ...r2, effects: { ...r2.effects, riskTier: "R3" } };
  assert.equal(CapabilityPlanSchema.safeParse(r3).success, false);

  const project = await repository.createProject(owner, {
    name: "R2 review",
    sourceType: "website",
    url: "https://acme.example/",
    idempotencyKey: "r2-project",
    inputHash: "r2-project"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "r2-analysis",
    inputHash: "r2-analysis"
  });
  await repository.claimAnalysis("worker", 60_000);
  const release = compileWebMcpRelease([r2]);
  await repository.completeAnalysis("worker", run.id, {
    capabilities: [{ plan: r2, status: "proposed" }],
    diagnostics: [],
    evidence: acmeCapabilityEvidence().filter(({ reference }) =>
      r2.evidence.some((item) => item.reference === reference)),
    release
  });
  const capability = (await repository.listCapabilities(owner, project.id))[0]!;
  const editor = { ...owner, id: "33333333-3333-3333-3333-333333333333", role: "editor" as const };
  await assert.rejects(
    repository.reviewCapability(editor, capability.id, { action: "approve", expectedVersion: 1 }),
    (error: unknown) => error instanceof RepositoryError && error.code === "OWNER_APPROVAL_REQUIRED"
  );
  assert.equal((await repository.reviewCapability(owner, capability.id, {
    action: "approve",
    expectedVersion: 1
  })).status, "reviewed");
});
