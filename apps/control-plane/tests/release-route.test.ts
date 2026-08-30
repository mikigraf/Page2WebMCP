import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { POST as verify } from "../app/api/capabilities/verify/route.ts";
import { GET as getArtifact } from "../app/api/releases/[artifact]/route.ts";
import { POST as publish } from "../app/api/projects/[projectId]/releases/route.ts";
import { authenticate, issueSession } from "../src/auth.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import {
  InMemoryControlPlaneRepository,
  type AnalysisResult,
  type RepositoryActor,
  type VerificationRecord,
  type VerificationRequest
} from "../../../packages/database/src/control-plane.ts";
import { setControlPlaneRepositoryForTest } from "../../../packages/database/src/factory.ts";
import { deriveVerification } from "../src/releases.ts";

const owner = authenticate("owner@example.test", "fixture-password")!;
const editor = authenticate("editor@example.test", "fixture-password")!;

async function fixture(
  repository: InMemoryControlPlaneRepository,
  evidence: AnalysisResult["evidence"] = acmeCapabilityEvidence()
    .filter(({ reference }) => reference !== acmeCapabilityPlans("https://acme.example")[1]!.evidence[0]!.reference)
) {
  const candidate = compileWebMcpRelease(acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name !== "get_order_status"));
  const project = await repository.createProject(owner, {
    name: "Acme",
    sourceType: "website",
    url: "https://acme.example/",
    idempotencyKey: "release-project",
    inputHash: "release-project"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "release-analysis",
    inputHash: "analysis"
  });
  await repository.claimAnalysis("worker", 60_000);
  const persistedPlans = acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name !== "get_order_status");
  await repository.completeAnalysis("worker", run.id, {
    capabilities: persistedPlans.map((plan) => ({ plan, status: "proposed" as const })),
    evidence,
    release: {
      code: candidate.code,
      contentHash: candidate.contentHash,
      allowedOrigin: "https://acme.example",
      manifest: candidate.manifest
    }
  });
  return { project, run, candidate };
}

test("verification binds the reviewed complete plan, not a same-name shallow capability", () => {
  const reviewedPlan = acmeCapabilityPlans("https://acme.example")
    .find((plan) => plan.tool.name === "find_order")!;
  const mutation = acmeCapabilityPlans("https://acme.example")
    .find((plan) => plan.tool.name === "create_support_ticket")!;
  const substitutions = [
    { ...mutation, tool: { ...mutation.tool, name: reviewedPlan.tool.name } },
    { ...reviewedPlan, request: { ...reviewedPlan.request, pathTemplate: "/api/other-orders" } },
    { ...reviewedPlan, authentication: { ...reviewedPlan.authentication, requiredScopes: ["orders:admin"] } },
    {
      ...reviewedPlan,
      schemas: {
        ...reviewedPlan.schemas,
        input: {
          ...reviewedPlan.schemas.input,
          properties: { query: { type: "string" as const, minLength: 1, maxLength: 12 } },
        },
      },
    },
  ];

  for (const substitutedPlan of substitutions) {
    const candidate = compileWebMcpRelease([substitutedPlan]);
    const planDigest = createHash("sha256").update(JSON.stringify(reviewedPlan)).digest("hex");
    const verification = deriveVerification("run-reviewed", "https://acme.example", {
      capabilities: [],
      evidence: acmeCapabilityEvidence(),
      release: {
        code: candidate.code,
        contentHash: candidate.contentHash,
        allowedOrigin: candidate.allowedOrigin,
        manifest: candidate.manifest,
      },
    }, [{
      id: "capability-reviewed",
      organizationId: "org-reviewed",
      projectId: "project-reviewed",
      analysisRunId: "run-reviewed",
      stableName: reviewedPlan.tool.name,
      riskTier: reviewedPlan.effects.riskTier as "R0" | "R1" | "R2",
      status: "proposed",
      version: 1,
      plan: reviewedPlan,
      planDigest,
      reviewedPlanDigest: planDigest,
    }]);
    assert.equal(verification.schema, false, substitutedPlan.tool.name);
    assert.equal(verification.selectionScore, 0, substitutedPlan.tool.name);
  }
});

class TamperedEvidenceRepository extends InMemoryControlPlaneRepository {
  constructor(private readonly tamper: (evidence: AnalysisResult["evidence"], runId: string) => AnalysisResult["evidence"]) {
    super();
  }

  override async getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined> {
    const result = await super.getAnalysisResult(actor, runId);
    return result ? { ...result, evidence: this.tamper(result.evidence, runId) } : result;
  }
}

test("verification rejects missing, changed, cross-run, and expired evidence references", async (context) => {
  const cases: Array<[string, (evidence: AnalysisResult["evidence"], runId: string) => AnalysisResult["evidence"]]> = [
    ["missing", (evidence) => evidence.slice(0, 1)],
    ["changed", (evidence) => evidence.map((item, index) => index === 0 ? { ...item, content: `${item.content}:changed` } : item)],
    ["cross-run", (evidence) => evidence.map((item) => ({ ...item, analysisRunId: "00000000-0000-0000-0000-000000000000" }))],
    ["expired", (evidence) => evidence.map((item) => ({ ...item, expiresAt: "2020-01-01T00:00:00.000Z" }))],
  ];

  for (const [name, tamper] of cases) {
    await context.test(name, async () => {
      const repository = new TamperedEvidenceRepository(tamper);
      setControlPlaneRepositoryForTest(repository);
      const { project, run } = await fixture(repository);
      await approveTicket(repository, project.id);
      const response = await verify(verificationRequest(project.id, run.id));
      assert.equal(response.status, 409);
      assert.deepEqual((await response.json()).error, {
        code: "RELEASE_GATE_FAILED",
        retryable: false,
        details: ["EVIDENCE_MISSING_OR_EXPIRED"],
      });
    });
  }
});

class ExpiringEvidenceRepository extends InMemoryControlPlaneRepository {
  #expired = false;

  expireEvidence(): void {
    this.#expired = true;
  }

  override async getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined> {
    const result = await super.getAnalysisResult(actor, runId);
    return this.#expired && result ? { ...result, evidence: [] } : result;
  }
}

class CapabilityChangeAfterVerificationRepository extends InMemoryControlPlaneRepository {
  #pendingApproval?: { capabilityId: string; expectedVersion: number };

  approveAfterNextVerification(capabilityId: string, expectedVersion: number): void {
    this.#pendingApproval = { capabilityId, expectedVersion };
  }

  override async saveVerification(
    actor: RepositoryActor,
    projectId: string,
    input: VerificationRequest
  ): Promise<VerificationRecord> {
    const verification = await super.saveVerification(actor, projectId, input);
    const pendingApproval = this.#pendingApproval;
    if (pendingApproval) {
      this.#pendingApproval = undefined;
      await this.reviewCapability(actor, pendingApproval.capabilityId, {
        action: "approve",
        expectedVersion: pendingApproval.expectedVersion
      });
    }
    return verification;
  }
}

function request(projectId: string, runId: string, key: string, actor = owner, extra: Record<string, unknown> = {}): Request {
  return new Request(`https://control.example/api/projects/${projectId}/releases`, {
    method: "POST",
    headers: {
      cookie: `page2webmcp_session=${issueSession(actor)}`,
      origin: "https://control.example",
      "content-type": "application/json",
      "idempotency-key": key
    },
    body: JSON.stringify({ analysisRunId: runId, ...extra })
  });
}

function verificationRequest(projectId: string, runId: string): Request {
  return new Request("https://control.example/api/capabilities/verify", {
    method: "POST",
    headers: {
      cookie: `page2webmcp_session=${issueSession(owner)}`,
      origin: "https://control.example",
      "content-type": "application/json"
    },
    body: JSON.stringify({ projectId, analysisRunId: runId })
  });
}

async function approveTicket(repository: InMemoryControlPlaneRepository, projectId: string): Promise<void> {
  const ticket = (await repository.listCapabilities(owner, projectId))
    .find((item) => item.stableName === "create_support_ticket");
  assert.ok(ticket);
  await repository.reviewCapability(owner, ticket.id, { action: "approve", expectedVersion: 1 });
}

test("verification and publication fail closed when exact-run evidence is absent", async () => {
  const repository = new TamperedEvidenceRepository(() => []);
  setControlPlaneRepositoryForTest(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);

  const verification = await verify(verificationRequest(project.id, run.id));
  assert.equal(verification.status, 409);
  assert.deepEqual((await verification.json()).error, {
    code: "RELEASE_GATE_FAILED",
    retryable: false,
    details: ["EVIDENCE_MISSING_OR_EXPIRED"]
  });

  const publication = await publish(
    request(project.id, run.id, "publish-without-evidence"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(publication.status, 409);
  assert.deepEqual((await publication.json()).error, {
    code: "RELEASE_GATE_FAILED",
    retryable: false,
    details: ["EVIDENCE_MISSING_OR_EXPIRED"]
  });
});

test("publication cannot reuse verification after its exact-run evidence expires", async () => {
  const repository = new ExpiringEvidenceRepository();
  setControlPlaneRepositoryForTest(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);

  const verification = await verify(verificationRequest(project.id, run.id));
  assert.equal(verification.status, 200);
  assert.equal((await verification.json()).verification.eligible, true);

  repository.expireEvidence();
  const publication = await publish(
    request(project.id, run.id, "publish-after-evidence-expiry"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(publication.status, 409);
  assert.deepEqual((await publication.json()).error, {
    code: "RELEASE_GATE_FAILED",
    retryable: false,
    details: ["EVIDENCE_MISSING_OR_EXPIRED"]
  });
});

test("analysis ingestion rejects a worker artifact that downgrades vetted untrusted content", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const canonical = compileWebMcpRelease(acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name === "get_order_status"));
  const code = canonical.code.replaceAll('"untrusted":true', '"untrusted":false');
  const downgradedManifest = structuredClone(canonical.manifest);
  downgradedManifest.plans[0]!.annotations.untrusted = false;
  const project = await repository.createProject(owner, {
    name: "Acme",
    sourceType: "website",
    url: "https://acme.example/",
    idempotencyKey: "untrusted-project",
    inputHash: "untrusted-project"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "untrusted-analysis",
    inputHash: "untrusted-analysis"
  });
  await repository.claimAnalysis("worker", 60_000);
  const reviewedPlan = acmeCapabilityPlans("https://acme.example")
    .find((plan) => plan.tool.name === "get_order_status")!;
  await assert.rejects(repository.completeAnalysis("worker", run.id, {
    capabilities: [{ plan: reviewedPlan, status: "proposed" }],
    evidence: acmeCapabilityEvidence().filter(({ reference }) => reference === reviewedPlan.evidence[0]!.reference),
    release: {
      code,
      contentHash: createHash("sha256").update(code).digest("hex"),
      allowedOrigin: "https://acme.example",
      manifest: downgradedManifest
    }
  }), { code: "INVALID_STATE" });
});

test("publication derives verification from persisted state and requires R1 review", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const { project, run } = await fixture(repository);

  const denied = await publish(
    request(project.id, run.id, "publish-before-review"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, "REVIEW_REQUIRED");

  const ticket = (await repository.listCapabilities(owner, project.id))
    .find((item) => item.stableName === "create_support_ticket")!;
  await repository.reviewCapability(owner, ticket.id, { action: "approve", expectedVersion: 1 });

  const published = await publish(
    request(project.id, run.id, "publish-after-review"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(published.status, 201);
  const body = await published.json();
  assert.equal(body.release.status, "published");
  assert.match(body.release.url, /^\/api\/releases\/[0-9a-f]{64}\.js$/);
  assert.match(body.release.sri, /^sha384-/);

  const duplicate = await publish(
    request(project.id, run.id, "publish-after-review"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal((await duplicate.json()).release.id, body.release.id);
});

test("publication rejects caller reports, non-owners, and serves immutable exact bytes", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const { project, run, candidate } = await fixture(repository);
  const ticket = (await repository.listCapabilities(owner, project.id))
    .find((item) => item.stableName === "create_support_ticket")!;
  await repository.reviewCapability(owner, ticket.id, { action: "approve", expectedVersion: 1 });

  const forged = await publish(
    request(project.id, run.id, "forged-report", owner, { report: { schema: true } }),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(forged.status, 400);

  const forbidden = await publish(
    request(project.id, run.id, "editor-publish", editor),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(forbidden.status, 403);

  const response = await publish(
    request(project.id, run.id, "real-publish"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  const release = (await response.json()).release;
  const artifact = await getArtifact(
    new Request(`https://control.example${release.url}`),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("etag"), `"${release.contentHash}"`);
  assert.match(artifact.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(artifact.headers.get("access-control-allow-origin"), "https://acme.example");
  assert.equal(artifact.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(artifact.headers.get("x-page2webmcp-integrity"), release.sri);
  assert.equal(await artifact.text(), candidate.code);

  const notModified = await getArtifact(
    new Request(`https://control.example${release.url}`, {
      headers: { "if-none-match": `"${release.contentHash}"` }
    }),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), "");

  const malformed = await getArtifact(
    new Request("https://control.example/api/releases/not-a-hash.js"),
    { params: Promise.resolve({ artifact: "not-a-hash.js" }) }
  );
  assert.equal(malformed.status, 404);
});

test("blocking a proposed capability publishes the deterministic reviewed subset", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const { project, run } = await fixture(repository);
  const ticket = (await repository.listAnalysisCapabilities(owner, run.id))
    .find((item) => item.stableName === "create_support_ticket")!;
  await repository.reviewCapability(owner, ticket.id, { action: "block", expectedVersion: 1 });

  const response = await publish(
    request(project.id, run.id, "publish-with-ticket-blocked"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const release = (await response.json()).release;
  const expected = compileWebMcpRelease(acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name === "find_order"));
  assert.equal(release.contentHash, expected.contentHash);

  const artifact = await getArtifact(
    new Request(`https://control.example${release.url}`),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  const code = await artifact.text();
  assert.equal(code, expected.code);
  assert.match(code, /find_order/);
  assert.doesNotMatch(code, /create_support_ticket/);
});

test("a capability change after subset verification rejects stale publication and a retry restores the tool", async () => {
  const repository = new CapabilityChangeAfterVerificationRepository();
  setControlPlaneRepositoryForTest(repository);
  const { project, run, candidate } = await fixture(repository);
  const ticket = (await repository.listAnalysisCapabilities(owner, run.id))
    .find((item) => item.stableName === "create_support_ticket");
  assert.ok(ticket);
  const blocked = await repository.reviewCapability(owner, ticket.id, {
    action: "block",
    expectedVersion: ticket.version
  });
  repository.approveAfterNextVerification(blocked.id, blocked.version);

  const raced = await publish(
    request(project.id, run.id, "publish-across-capability-change"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(raced.status, 409);
  assert.deepEqual((await raced.json()).error, {
    code: "RELEASE_GATE_FAILED",
    retryable: false,
    details: ["CAPABILITIES_CHANGED"]
  });

  const retried = await publish(
    request(project.id, run.id, "publish-across-capability-change"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(retried.status, 201, JSON.stringify(await retried.clone().json()));
  const release = (await retried.json()).release;
  assert.equal(release.contentHash, candidate.contentHash);

  const artifact = await getArtifact(
    new Request(`https://control.example${release.url}`),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  const code = await artifact.text();
  assert.equal(code, candidate.code);
  assert.match(code, /find_order/);
  assert.match(code, /create_support_ticket/);
});
