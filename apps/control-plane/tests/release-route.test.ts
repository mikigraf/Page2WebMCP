import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { POST as verify } from "../app/api/capabilities/verify/route.ts";
import { GET as getArtifact } from "../app/api/releases/[artifact]/route.ts";
import { POST as publish } from "../app/api/projects/[projectId]/releases/route.ts";
import { authenticate, issueSession } from "../src/auth.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import {
  InMemoryControlPlaneRepository,
  type AnalysisResult,
  type RepositoryActor,
  type VerificationRecord,
  type VerificationRequest
} from "../../../packages/database/src/control-plane.ts";
import { setControlPlaneRepositoryForTest } from "../../../packages/database/src/factory.ts";

const owner = authenticate("owner@example.test", "fixture-password")!;
const editor = authenticate("editor@example.test", "fixture-password")!;

async function fixture(
  repository: InMemoryControlPlaneRepository,
  evidence: AnalysisResult["evidence"] = [{ source: "openapi", operation: "findOrder" }]
) {
  const candidate = compileWebMcpRelease([
    { name: "find_order", description: "find order", readOnly: true },
    { name: "create_support_ticket", description: "create support ticket", readOnly: false, requiresConfirmation: true }
  ], "https://acme.example");
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
  await repository.completeAnalysis("worker", run.id, {
    capabilities: [
      { stableName: "find_order", riskTier: "R0", status: "proposed" },
      { stableName: "create_support_ticket", riskTier: "R1", status: "proposed" },
      { stableName: "delete_account", riskTier: "R3", status: "blocked" }
    ],
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
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const { project, run } = await fixture(repository, []);
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

test("publication rejects a worker artifact that downgrades vetted untrusted content", async () => {
  const repository = new InMemoryControlPlaneRepository();
  setControlPlaneRepositoryForTest(repository);
  const canonical = compileWebMcpRelease([{
    name: "get_order_status",
    description: "get order status",
    readOnly: true
  }], "https://acme.example");
  const code = canonical.code.replaceAll('"untrustedContent":true', '"untrustedContent":false');
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
  await repository.completeAnalysis("worker", run.id, {
    capabilities: [{ stableName: "get_order_status", riskTier: "R0", status: "proposed" }],
    evidence: [{ source: "openapi", operation: "getOrderStatus" }],
    release: {
      code,
      contentHash: createHash("sha256").update(code).digest("hex"),
      allowedOrigin: "https://acme.example",
      manifest: {
        version: 2,
        allowedOrigin: "https://acme.example",
        tools: [{
          name: "get_order_status",
          readOnly: true,
          untrustedContent: false,
          requiresConfirmation: false
        }]
      }
    }
  });

  const response = await publish(
    request(project.id, run.id, "publish-downgraded-untrusted-content"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "RELEASE_GATE_FAILED");
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
  assert.match(body.release.sri, /^sha256-/);

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
  const expected = compileWebMcpRelease([
    { name: "find_order", description: "find order", readOnly: true, requiresConfirmation: false }
  ], "https://acme.example");
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
