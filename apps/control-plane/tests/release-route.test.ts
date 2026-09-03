import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { POST as verify } from "../app/api/capabilities/verify/route.ts";
import { GET as getArtifact } from "../app/api/releases/[artifact]/route.ts";
import { POST as publishCompatibility } from "../app/api/releases/publish/route.ts";
import { GET as projectDetail } from "../app/api/projects/[projectId]/route.ts";
import { POST as publish } from "../app/api/projects/[projectId]/releases/route.ts";
import { POST as verifyInstallation } from "../app/api/projects/[projectId]/releases/[releaseId]/installation/route.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import {
  InMemoryControlPlaneRepository,
  liveCandidateVerifierScopeDigest,
  liveInstallationVerifierScopeDigest,
  type AnalysisResult,
  type PublishedReleaseState,
  type PublishRequest,
  type ReleaseRecord,
  type RepositoryActor,
  type VerificationRecord,
  type VerificationRequest
} from "../../../packages/database/src/control-plane.ts";
import {
  setReleaseArtifactStoreForTest,
  type ReleaseArtifactPublication,
  type ReleaseArtifactStore,
} from "../src/artifact-storage.ts";
import { canonicalVerifierJson } from "../src/release-verifier-protocol-v2.ts";
import { deriveVerification } from "../src/releases.ts";
import {
  LIVE_RELEASE_VERIFIER_PROTOCOL_VERSION,
  REQUIRED_CANDIDATE_CHECKS,
  setReleaseVerificationPortForTest,
  type CandidateVerificationReport,
  type InstalledVerificationInput,
  type InstalledVerificationReport,
  type ReleaseVerificationPort,
} from "../src/release-verification.ts";
import {
  authenticatedHeaders,
  editor,
  hermeticReleaseVerificationPort,
  installTestRepository,
  owner,
} from "./auth-test-helpers.ts";

const HOSTED_ARTIFACT_PREFIX =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const LOCAL_ARTIFACT_PREFIX =
  "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases";

function artifactPublication(
  input: Readonly<{ contentHash: string; integrity: string }>,
  localOnly = false,
): ReleaseArtifactPublication {
  const artifactUrl = `${localOnly ? LOCAL_ARTIFACT_PREFIX : HOSTED_ARTIFACT_PREFIX}/${input.contentHash}.js`;
  return {
    artifactUrl,
    downloadUrl: `${artifactUrl}?download=page2webmcp-${input.contentHash}.js`,
    contentHash: input.contentHash,
    integrity: input.integrity,
    localOnly,
  };
}

function exactInstalledReport(
  input: InstalledVerificationInput,
  overrides: Partial<InstalledVerificationReport> = {},
): InstalledVerificationReport {
  return {
    observedArtifactUrl: input.artifactUrl,
    observedDownloadUrl: input.downloadUrl,
    observedLocalOnly: input.localOnly,
    observedIntegrity: input.integrity,
    executedArtifactUrl: input.selfHostedUrl ?? input.artifactUrl,
    servedContentHash: input.contentHash,
    executedContentHash: input.contentHash,
    observedTargetOrigin: input.targetOrigin,
    registeredTools: [...input.expectedTools],
    webMcpImplementation: "native",
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    executionEvidence: {
      authenticatedRead: { toolName: "find_order", authenticated: true, succeeded: true },
      confirmedReversibleMutation: {
        toolName: "create_support_ticket", confirmation: "explicit", reversible: true, succeeded: true, effectCount: 1,
      },
      authoritativeFinalState: {
        mutationToolName: "create_support_ticket", source: "target", verified: true,
      },
    },
    csp: { hosted: "allowed" },
    ...overrides,
  };
}

function liveVerifierAttestation<Operation extends "candidate" | "installation">(
  operation: Operation,
  scopeDigest: string,
  payload: unknown,
) {
  const attestedAt = new Date();
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const attestationId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  return {
    protocolVersion: LIVE_RELEASE_VERIFIER_PROTOCOL_VERSION,
    attestationId,
    requestId,
    nonceDigest: digest(`nonce:${attestationId}`),
    operation,
    scopeDigest,
    payloadDigest: digest(canonicalVerifierJson(payload)),
    issuedAt: new Date(attestedAt.getTime() - 1_000).toISOString(),
    attestedAt: attestedAt.toISOString(),
    expiresAt: new Date(attestedAt.getTime() + 60_000).toISOString(),
  } as const;
}

function liveVerificationPort(verifierOriginDigest: string): ReleaseVerificationPort {
  return {
    ...hermeticReleaseVerificationPort,
    mode: "live",
    readiness: async () => ({
      protocolVersion: LIVE_RELEASE_VERIFIER_PROTOCOL_VERSION,
      mode: "live",
      webMcpImplementation: "native",
      verifierOriginDigest,
    }),
    verifyCandidate: async (input, signal) => ({
      report: await hermeticReleaseVerificationPort.verifyCandidate(input, signal) as CandidateVerificationReport,
      verifierAttestation: liveVerifierAttestation("candidate", liveCandidateVerifierScopeDigest({
        projectId: input.liveContext!.projectId,
        analysisRunId: input.liveContext!.analysisRunId,
        sourceIdentityHash: input.liveContext!.sourceIdentityHash,
        targetOrigin: input.targetOrigin,
        environment: input.liveContext!.environment,
        contentHash: input.contentHash,
      }), {
        code: input.code,
        contentHash: input.contentHash,
        integrity: input.integrity,
        manifest: input.manifest,
        targetOrigin: input.targetOrigin,
        expectedTools: input.expectedTools,
      }),
    }),
    verifyInstalled: async (input, signal) => ({
      report: await hermeticReleaseVerificationPort.verifyInstalled(input, signal) as InstalledVerificationReport,
      verifierAttestation: liveVerifierAttestation("installation", liveInstallationVerifierScopeDigest({
        projectId: input.liveContext!.projectId,
        releaseId: input.liveContext!.releaseId,
        installationOperationId: input.liveContext!.installationOperationId,
        sourceIdentityHash: input.liveContext!.sourceIdentityHash,
        pageUrl: input.pageUrl,
        targetOrigin: input.targetOrigin,
        environment: input.liveContext!.environment,
        selectedHash: input.contentHash,
      }), {
        pageUrl: input.pageUrl,
        artifactUrl: input.artifactUrl,
        downloadUrl: input.downloadUrl,
        localOnly: input.localOnly,
        contentHash: input.contentHash,
        integrity: input.integrity,
        manifest: input.manifest,
        targetOrigin: input.targetOrigin,
        expectedTools: input.expectedTools,
        ...(input.selfHostedUrl ? { selfHostedUrl: input.selfHostedUrl } : {}),
      }),
    }),
  };
}

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
    url: "https://acme.example",
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
    diagnostics: [],
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

async function openApiFixture(repository: InMemoryControlPlaneRepository) {
  const targetOrigin = "https://support.example";
  const plans = acmeCapabilityPlans(targetOrigin)
    .filter((plan) => plan.tool.name !== "get_order_status");
  const candidate = compileWebMcpRelease(plans);
  const project = await repository.createProject(owner, {
    name: "Independent support API",
    sourceType: "openapi",
    url: "https://specs.example/openapi.yaml",
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin,
      testPageUrl: `${targetOrigin}/webmcp-test`,
      environment: "test",
    },
    idempotencyKey: "openapi-release-project",
    inputHash: "openapi-release-project",
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "openapi-release-analysis",
    inputHash: "openapi-release-analysis",
  });
  await repository.claimAnalysis("worker", 60_000);
  await repository.completeAnalysis("worker", run.id, {
    capabilities: plans.map((plan) => ({ plan, status: "proposed" as const })),
    diagnostics: [],
    evidence: acmeCapabilityEvidence()
      .filter(({ reference }) => reference !== acmeCapabilityPlans(targetOrigin)[1]!.evidence[0]!.reference),
    release: {
      code: candidate.code,
      contentHash: candidate.contentHash,
      allowedOrigin: targetOrigin,
      manifest: candidate.manifest,
    },
  });
  await approveTicket(repository, project.id);
  return { project, run, candidate, targetOrigin };
}

async function nextWebsiteAnalysis(
  repository: InMemoryControlPlaneRepository,
  projectId: string,
  suffix: string,
) {
  const plans = acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name !== "get_order_status");
  const candidate = compileWebMcpRelease(plans);
  const run = await repository.enqueueAnalysis(owner, {
    projectId,
    idempotencyKey: `release-analysis-${suffix}`,
    inputHash: `release-analysis-${suffix}`,
  });
  await repository.claimAnalysis("worker", 60_000);
  await repository.completeAnalysis("worker", run.id, {
    capabilities: plans.map((plan) => ({ plan, status: "proposed" as const })),
    diagnostics: [],
    evidence: acmeCapabilityEvidence()
      .filter(({ reference }) => reference !== acmeCapabilityPlans("https://acme.example")[1]!.evidence[0]!.reference),
    release: {
      code: candidate.code,
      contentHash: candidate.contentHash,
      allowedOrigin: "https://acme.example",
      manifest: candidate.manifest,
    },
  });
  const ticket = (await repository.listAnalysisCapabilities(owner, run.id))
    .find((item) => item.stableName === "create_support_ticket");
  assert.ok(ticket);
  await repository.reviewCapability(owner, ticket.id, { action: "approve", expectedVersion: ticket.version });
  return { run, candidate };
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
      diagnostics: [],
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
      installTestRepository(repository);
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

class OrderedPublicationRepository extends InMemoryControlPlaneRepository {
  readonly events: string[] = [];

  override async saveVerification(
    actor: RepositoryActor,
    projectId: string,
    input: VerificationRequest,
  ): Promise<VerificationRecord> {
    const verification = await super.saveVerification(actor, projectId, input);
    this.events.push("verification");
    return verification;
  }

  override async publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord> {
    this.events.push("database");
    return super.publishRelease(actor, input);
  }
}

class FailFirstPublicationRepository extends InMemoryControlPlaneRepository {
  attempts = 0;

  override async publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("SIMULATED_DATABASE_FAILURE");
    return super.publishRelease(actor, input);
  }
}

class CorruptPublicationReturnRepository extends InMemoryControlPlaneRepository {
  override async publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord> {
    const release = await super.publishRelease(actor, input);
    return {
      ...release,
      capabilityStateDigest: "0".repeat(64),
      code: `${release.code}\n// corrupt return`,
      sri: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      manifest: { ...(release.manifest as Record<string, unknown>), releaseId: "0".repeat(64) },
    };
  }
}

class LegacyLatestReleaseRepository extends InMemoryControlPlaneRepository {
  override async getLatestPublishedRelease(
    actor: RepositoryActor,
    projectId: string,
  ): Promise<PublishedReleaseState | undefined> {
    const state = await super.getLatestPublishedRelease(actor, projectId);
    if (!state) return undefined;
    const legacy: ReleaseRecord = {
      id: state.release.id,
      organizationId: state.release.organizationId,
      projectId: state.release.projectId,
      analysisRunId: state.release.analysisRunId,
      capabilityStateDigest: state.release.capabilityStateDigest,
      contentHash: state.release.contentHash,
      sri: state.release.sri,
      code: state.release.code,
      allowedOrigin: state.release.allowedOrigin,
      manifest: state.release.manifest,
      status: state.release.status,
      createdAt: state.release.createdAt,
    };
    return { release: legacy, verification: state.verification };
  }
}

function request(projectId: string, runId: string, key: string, actor = owner, extra: Record<string, unknown> = {}): Request {
  return new Request(`https://control.example/api/projects/${projectId}/releases`, {
    method: "POST",
    headers: {
      ...authenticatedHeaders(actor),
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
      ...authenticatedHeaders(owner),
      "content-type": "application/json"
    },
    body: JSON.stringify({ projectId, analysisRunId: runId })
  });
}

function compatibilityRequest(projectId: string, runId: string, key: string): Request {
  return new Request("https://control.example/api/releases/publish", {
    method: "POST",
    headers: {
      ...authenticatedHeaders(owner),
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ projectId, analysisRunId: runId }),
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
  installTestRepository(repository);
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
  installTestRepository(repository);
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

test("verification persists the trusted target's typed failure instead of treating compiler replay as browser execution", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const { project, run, candidate } = await fixture(repository);
  await approveTicket(repository, project.id);
  let exactBytes = "";
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async (input) => {
      exactBytes = input.code;
      return {
        observedContentHash: input.contentHash,
        observedIntegrity: candidate.integrity,
        observedReleaseId: candidate.manifest.releaseId,
        observedTargetOrigin: input.targetOrigin,
        registeredTools: ["create_support_ticket", "find_order"],
        trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: input.contentHash },
        controlPlaneRequestsDuringExecution: 0,
        modelRequestsDuringExecution: 0,
        checks: REQUIRED_CANDIDATE_CHECKS.map((name) => name === "final_state"
          ? { name, status: "failed" as const, code: "WRONG_STATE" as const }
          : { name, status: "passed" as const }),
        csp: { hosted: "allowed" },
      };
    },
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  };
  setReleaseVerificationPortForTest(port);
  try {
    const response = await verify(verificationRequest(project.id, run.id));
    assert.equal(response.status, 200);
    const verification = (await response.json()).verification;
    assert.equal(exactBytes, candidate.code);
    assert.equal(verification.eligible, false);
    assert.deepEqual(verification.failures, ["WRONG_STATE"]);
    assert.deepEqual(verification.checks.find((check: { name: string }) => check.name === "final_state"), {
      name: "final_state", status: "failed", code: "WRONG_STATE",
    });
  } finally {
    setReleaseVerificationPortForTest(undefined);
  }
});

test("analysis ingestion rejects a worker artifact that downgrades vetted untrusted content", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
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
    diagnostics: [],
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
  installTestRepository(repository);
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
  assert.equal(body.release.url, `${HOSTED_ARTIFACT_PREFIX}/${body.release.contentHash}.js`);
  assert.match(body.release.sri, /^sha384-/);
  assert.deepEqual(body.release.installation, {
    artifactUrl: body.release.url,
    downloadUrl: `${body.release.url}?download=page2webmcp-${body.release.contentHash}.js`,
    moduleScriptTag: `<script type="module" src="${body.release.url}" integrity="${body.release.sri}" crossorigin="anonymous"></script>`,
    manifest: body.release.manifest,
    integrity: body.release.sri,
    contentHash: body.release.contentHash,
    targetOrigin: "https://acme.example",
    verificationPageUrl: "https://acme.example/",
    localOnly: false,
    compatibility: { moduleScripts: true, webMcp: "native-current-required" },
    csp: { hosted: "allowed" },
    selfHost: {
      required: false,
      guidance: "Host the downloaded bytes unchanged on the target origin, then verify that exact SHA-256 before installation.",
    },
    previousRelease: null,
    installed: false,
    productionVerified: false,
    attestation: null,
  });

  const duplicate = await publish(
    request(project.id, run.id, "publish-after-review"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal((await duplicate.json()).release.id, body.release.id);
});

test("publication persists verification before uploading the exact candidate and then records Storage identity", async () => {
  const repository = new OrderedPublicationRepository();
  installTestRepository(repository);
  const { project, run, candidate } = await fixture(repository);
  await approveTicket(repository, project.id);
  let uploaded: Parameters<ReleaseArtifactStore["publish"]>[0] | undefined;
  setReleaseArtifactStoreForTest({
    publish: async (input) => {
      repository.events.push("storage");
      uploaded = input;
      return artifactPublication(input);
    },
  });

  const response = await publish(
    request(project.id, run.id, "publish-storage-order"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const release = (await response.json()).release;
  assert.deepEqual(repository.events, ["verification", "storage", "database"]);
  assert.equal(uploaded?.code, candidate.code);
  assert.equal(uploaded?.contentHash, candidate.contentHash);
  assert.equal(uploaded?.targetOrigin, "https://acme.example");
  const expectedPublication = artifactPublication(candidate);
  assert.deepEqual({
    artifactUrl: release.artifactUrl,
    downloadUrl: release.downloadUrl,
    localOnly: release.localOnly,
  }, {
    artifactUrl: expectedPublication.artifactUrl,
    downloadUrl: expectedPublication.downloadUrl,
    localOnly: expectedPublication.localOnly,
  });
});

test("publication never uploads an ineligible candidate", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);
  let uploads = 0;
  setReleaseArtifactStoreForTest({
    publish: async () => {
      uploads += 1;
      throw new Error("INELIGIBLE_UPLOAD");
    },
  });
  setReleaseVerificationPortForTest({
    mode: "hermetic",
    verifyCandidate: async (input) => ({
      observedContentHash: input.contentHash,
      observedIntegrity: input.integrity,
      observedReleaseId: input.manifest.releaseId,
      observedTargetOrigin: input.targetOrigin,
      registeredTools: [...input.expectedTools],
      trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: input.contentHash },
      controlPlaneRequestsDuringExecution: 0,
      modelRequestsDuringExecution: 0,
      checks: REQUIRED_CANDIDATE_CHECKS.map((name) => name === "final_state"
        ? { name, status: "failed" as const, code: "WRONG_STATE" as const }
        : { name, status: "passed" as const }),
      csp: { hosted: "allowed" },
    }),
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  });

  const response = await publish(
    request(project.id, run.id, "publish-ineligible-storage"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(response.status, 409);
  assert.equal(uploads, 0);
});

test("Storage failure or returned identity mismatch creates no release", async (context) => {
  for (const [name, store] of [
    ["upload failure", {
      publish: async () => { throw new Error("RELEASE_ARTIFACT_UPLOAD_FAILED"); },
    }],
    ["identity mismatch", {
      publish: async (input: Parameters<ReleaseArtifactStore["publish"]>[0]) => ({
        ...artifactPublication(input),
        integrity: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    }],
  ] satisfies Array<[string, ReleaseArtifactStore]>) {
    await context.test(name, async () => {
      const repository = new InMemoryControlPlaneRepository();
      installTestRepository(repository);
      const { project, run, candidate } = await fixture(repository);
      await approveTicket(repository, project.id);
      setReleaseArtifactStoreForTest(store);
      const response = await publish(
        request(project.id, run.id, `publish-storage-${name.replace(" ", "-")}`),
        { params: Promise.resolve({ projectId: project.id }) },
      );
      assert.equal(response.status, 500);
      await assert.rejects(repository.getReleaseArtifact(candidate.contentHash), { code: "NOT_FOUND" });
    });
  }
});

test("an immutable Storage orphan is reconciled on DB retry and concurrent same-run publishes converge", async () => {
  const repository = new FailFirstPublicationRepository();
  installTestRepository(repository);
  const { project, run, candidate } = await fixture(repository);
  await approveTicket(repository, project.id);
  let uploads = 0;
  setReleaseArtifactStoreForTest({
    publish: async (input) => {
      uploads += 1;
      return artifactPublication(input);
    },
  });

  const failed = await publish(
    request(project.id, run.id, "publish-orphan-retry"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(failed.status, 500);
  await assert.rejects(repository.getReleaseArtifact(candidate.contentHash), { code: "NOT_FOUND" });
  const recovered = await publish(
    request(project.id, run.id, "publish-orphan-retry"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(recovered.status, 201, JSON.stringify(await recovered.clone().json()));
  assert.equal(uploads, 2);

  const [first, second] = await Promise.all([
    publish(request(project.id, run.id, "publish-concurrent-first"),
      { params: Promise.resolve({ projectId: project.id }) }),
    publish(request(project.id, run.id, "publish-concurrent-second"),
      { params: Promise.resolve({ projectId: project.id }) }),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await first.json()).release.id, (await second.json()).release.id);
});

test("publication rejects a repository return that diverges from the exact verified candidate", async () => {
  const repository = new CorruptPublicationReturnRepository();
  installTestRepository(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);
  const response = await publish(
    request(project.id, run.id, "publish-corrupt-repository-return"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "INVALID_STATE");
});

test("both publication routes use Storage and OpenAPI binds its immutable snapshot target", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const { project, run, targetOrigin } = await openApiFixture(repository);
  const observedTargets: string[] = [];
  setReleaseArtifactStoreForTest({
    publish: async (input) => {
      observedTargets.push(input.targetOrigin);
      return artifactPublication(input);
    },
  });
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async (input) => {
      observedTargets.push(input.targetOrigin);
      return {
        observedContentHash: input.contentHash,
        observedIntegrity: input.integrity,
        observedReleaseId: input.manifest.releaseId,
        observedTargetOrigin: input.targetOrigin,
        registeredTools: [...input.expectedTools],
        trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: input.contentHash },
        controlPlaneRequestsDuringExecution: 0,
        modelRequestsDuringExecution: 0,
        checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, status: "passed" as const })),
        csp: { hosted: "allowed" },
      };
    },
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  };
  setReleaseVerificationPortForTest(port);

  const response = await publishCompatibility(compatibilityRequest(
    project.id,
    run.id,
    "publish-openapi-compatibility",
  ));
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const release = (await response.clone().json()).release;
  assert.deepEqual(observedTargets, [targetOrigin, targetOrigin]);
  assert.equal(release.installation.verificationPageUrl, `${targetOrigin}/webmcp-test`);
  assert.notEqual(targetOrigin, new URL(project.url).origin);

  setReleaseArtifactStoreForTest({ publish: async () => { throw new Error("RECOVERY_MUST_NOT_UPLOAD"); } });
  setReleaseVerificationPortForTest({
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("RECOVERY_MUST_NOT_VERIFY"); },
    verifyInstalled: async () => { throw new Error("RECOVERY_MUST_NOT_VERIFY"); },
  });
  const detail = await projectDetail(
    new Request(`https://control.example/api/projects/${project.id}`, { headers: authenticatedHeaders(owner) }),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(detail.status, 200, JSON.stringify(await detail.clone().json()));
  const recovered = (await detail.json()).release;
  assert.deepEqual(Object.keys(recovered).sort(), ["id", "installation", "url"]);
  assert.equal(recovered.id, release.id);
  assert.equal(recovered.url, release.artifactUrl);
  assert.equal(recovered.installation.verificationPageUrl, `${targetOrigin}/webmcp-test`);
  assert.equal("code" in recovered, false);
});

test("project recovery omits an intentionally preserved legacy release identity instead of failing the project", async () => {
  const repository = new LegacyLatestReleaseRepository();
  installTestRepository(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);
  const response = await publish(
    request(project.id, run.id, "publish-before-legacy-recovery"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));

  const detail = await projectDetail(
    new Request(`https://control.example/api/projects/${project.id}`, { headers: authenticatedHeaders(owner) }),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(detail.status, 200, JSON.stringify(await detail.clone().json()));
  const body = await detail.json();
  assert.equal(body.project.id, project.id);
  assert.equal(body.release, undefined);
});

test("release guides preserve local-only and the previous persisted Storage URL", async () => {
  let instant = Date.now();
  const repository = new InMemoryControlPlaneRepository(() => new Date(instant++));
  installTestRepository(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);
  const firstResponse = await publish(
    request(project.id, run.id, "publish-guide-first"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(firstResponse.status, 201, JSON.stringify(await firstResponse.clone().json()));
  const first = (await firstResponse.json()).release;

  const secondAnalysis = await nextWebsiteAnalysis(repository, project.id, "second");
  const secondResponse = await publish(
    request(project.id, secondAnalysis.run.id, "publish-guide-second"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(secondResponse.status, 201, JSON.stringify(await secondResponse.clone().json()));
  const second = (await secondResponse.json()).release;
  assert.deepEqual(second.installation.previousRelease, {
    id: first.id,
    contentHash: first.contentHash,
    integrity: first.sri,
    artifactUrl: first.artifactUrl,
  });

  setReleaseArtifactStoreForTest({ publish: async () => { throw new Error("RECOVERY_MUST_NOT_UPLOAD"); } });
  setReleaseVerificationPortForTest({
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("RECOVERY_MUST_NOT_VERIFY"); },
    verifyInstalled: async () => { throw new Error("RECOVERY_MUST_NOT_VERIFY"); },
  });
  const resumed = await projectDetail(
    new Request(`https://control.example/api/projects/${project.id}`, { headers: authenticatedHeaders(owner) }),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(resumed.status, 200, JSON.stringify(await resumed.clone().json()));
  const resumedRelease = (await resumed.json()).release;
  assert.equal(resumedRelease.id, second.id);
  assert.equal(resumedRelease.url, second.artifactUrl);
  assert.deepEqual(resumedRelease.installation.previousRelease, {
    id: first.id,
    contentHash: first.contentHash,
    integrity: first.sri,
    artifactUrl: first.artifactUrl,
  });
  assert.equal(JSON.stringify(resumedRelease).includes(second.code), false);

  const localRepository = new InMemoryControlPlaneRepository();
  installTestRepository(localRepository);
  const localFixture = await fixture(localRepository);
  await approveTicket(localRepository, localFixture.project.id);
  setReleaseArtifactStoreForTest({
    publish: async (input) => artifactPublication(input, true),
  });
  const localResponse = await publish(
    request(localFixture.project.id, localFixture.run.id, "publish-local-guide"),
    { params: Promise.resolve({ projectId: localFixture.project.id }) },
  );
  assert.equal(localResponse.status, 201, JSON.stringify(await localResponse.clone().json()));
  const local = (await localResponse.json()).release;
  assert.equal(local.localOnly, true);
  assert.equal(local.url, `${LOCAL_ARTIFACT_PREFIX}/${local.contentHash}.js`);
  assert.equal(local.installation.localOnly, true);
  assert.equal(local.installation.selfHost.required, true);
  assert.match(local.installation.selfHost.guidance, /Loopback delivery validates bytes only/);
  assert.match(local.installation.moduleScriptTag, /^<script type="module" src="http:\/\/127\.0\.0\.1:58321\//);
});

test("publication rejects caller reports, non-owners, and serves immutable exact bytes", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
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
    new Request(`https://control.example/api/releases/${release.contentHash}.js`),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("etag"), `"${release.contentHash}"`);
  assert.match(artifact.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(artifact.headers.get("access-control-allow-origin"), "https://acme.example");
  assert.equal(artifact.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(artifact.headers.get("x-page2webmcp-integrity"), release.sri);
  assert.equal(artifact.headers.get("x-page2webmcp-content-hash"), release.contentHash);
  assert.equal(artifact.headers.get("set-cookie"), null);
  assert.equal(await artifact.text(), candidate.code);

  const download = await getArtifact(
    new Request(`https://control.example/api/releases/${release.contentHash}.js?download=1`),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  assert.equal(download.headers.get("content-disposition"), `attachment; filename="page2webmcp-${release.contentHash}.js"`);
  assert.equal(await download.text(), candidate.code);

  const notModified = await getArtifact(
    new Request(`https://control.example/api/releases/${release.contentHash}.js`, {
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
  installTestRepository(repository);
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
    new Request(`https://control.example/api/releases/${release.contentHash}.js`),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  const code = await artifact.text();
  assert.equal(code, expected.code);
  assert.match(code, /find_order/);
  assert.doesNotMatch(code, /create_support_ticket/);
});

test("installed-target route records only an exact normal native WebMCP observation and replays idempotently", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);
  const published = await publish(
    request(project.id, run.id, "publish-for-installation"),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  const release = (await published.json()).release;
  const installRequest = () => new Request(
    `https://control.example/api/projects/${project.id}/releases/${release.id}/installation`,
    {
      method: "POST",
      headers: {
        ...authenticatedHeaders(owner),
        "content-type": "application/json",
        "idempotency-key": "verify-installation-one",
      },
      body: JSON.stringify({ pageUrl: "https://acme.example/account" }),
    }
  );
  const first = await verifyInstallation(installRequest(), {
    params: Promise.resolve({ projectId: project.id, releaseId: release.id }),
  });
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  const installation = (await first.json()).installation;
  assert.equal(installation.status, "verified");
  assert.equal(installation.delivery, "hosted");
  assert.equal(installation.artifactContentHash, release.contentHash);
  assert.equal(installation.integrity, release.sri);
  assert.equal(installation.webMcpImplementation, "native");
  assert.equal(installation.artifactUrl, release.artifactUrl);
  assert.deepEqual(installation.attestation, {
    observedArtifactUrl: release.artifactUrl,
    observedDownloadUrl: release.downloadUrl,
    observedLocalOnly: false,
    observedIntegrity: release.sri,
    executedArtifactUrl: release.artifactUrl,
    servedContentHash: release.contentHash,
    executedContentHash: release.contentHash,
    observedTargetOrigin: "https://acme.example",
    registeredTools: ["create_support_ticket", "find_order"],
    webMcpImplementation: "native",
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    executionEvidence: {
      authenticatedRead: { toolName: "find_order", authenticated: true, succeeded: true },
      confirmedReversibleMutation: {
        toolName: "create_support_ticket", confirmation: "explicit", reversible: true, succeeded: true, effectCount: 1,
      },
      authoritativeFinalState: {
        mutationToolName: "create_support_ticket", source: "target", verified: true,
      },
    },
    csp: { hosted: "allowed" },
  });

  const duplicate = await verifyInstallation(installRequest(), {
    params: Promise.resolve({ projectId: project.id, releaseId: release.id }),
  });
  assert.equal((await duplicate.json()).installation.id, installation.id);

  const detail = await projectDetail(
    new Request(`https://control.example/api/projects/${project.id}`, {
      headers: authenticatedHeaders(owner),
    }),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(detail.status, 200, JSON.stringify(await detail.clone().json()));
  const recovered = (await detail.json()).release.installation;
  assert.equal(recovered.installed, true);
  assert.equal(recovered.productionVerified, false);
  assert.deepEqual(recovered.attestation, {
    id: installation.id,
    status: "verified",
    delivery: "hosted",
    pageUrl: "https://acme.example/account",
    selfHostedUrl: null,
    webMcpImplementation: "native",
    verifierMode: "hermetic",
    registeredTools: ["create_support_ticket", "find_order"],
    executedContentHash: release.contentHash,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    verifiedAt: installation.verifiedAt,
  });
});

test("production installation status requires the same live verifier for candidate and installed proof", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);
  const candidateVerifierDigest = "a".repeat(64);
  setReleaseVerificationPortForTest(liveVerificationPort(candidateVerifierDigest));
  const published = await publish(
    request(project.id, run.id, "publish-for-live-proof-chain"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  assert.equal(published.status, 201, JSON.stringify(await published.clone().json()));
  const release = (await published.json()).release;

  const install = async (idempotencyKey: string) => await verifyInstallation(new Request(
    `https://control.example/api/projects/${project.id}/releases/${release.id}/installation`,
    {
      method: "POST",
      headers: {
        ...authenticatedHeaders(owner),
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ pageUrl: "https://acme.example/account" }),
    },
  ), { params: Promise.resolve({ projectId: project.id, releaseId: release.id }) });
  const recover = async () => {
    const response = await projectDetail(new Request(
      `https://control.example/api/projects/${project.id}`,
      { headers: authenticatedHeaders(owner) },
    ), { params: Promise.resolve({ projectId: project.id }) });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    return (await response.json()).release.installation;
  };

  setReleaseVerificationPortForTest(liveVerificationPort("b".repeat(64)));
  assert.equal((await install("live-install-different-verifier")).status, 200);
  const mismatched = await recover();
  assert.equal(mismatched.installed, true);
  assert.equal(mismatched.productionVerified, false);

  setReleaseVerificationPortForTest(liveVerificationPort(candidateVerifierDigest));
  assert.equal((await install("live-install-same-verifier")).status, 200);
  const matched = await recover();
  assert.equal(matched.installed, true);
  assert.equal(matched.productionVerified, true);
});

test("an exact self-host verification can supersede pending hosted CSP evidence without overwriting unrelated evidence", async () => {
  const repository = new InMemoryControlPlaneRepository();
  installTestRepository(repository);
  const { project, run } = await fixture(repository);
  await approveTicket(repository, project.id);
  const published = await publish(
    request(project.id, run.id, "publish-for-self-host"),
    { params: Promise.resolve({ projectId: project.id }) },
  );
  const release = (await published.json()).release;
  setReleaseVerificationPortForTest({
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async (input) => exactInstalledReport(input, input.selfHostedUrl ? {
      csp: { hosted: "blocked", directive: "script-src 'self'" },
    } : {
      executedArtifactUrl: null,
      executedContentHash: null,
      registeredTools: [],
      duplicateLoadHarmless: null,
      executionEvidence: null,
      csp: { hosted: "blocked", directive: "script-src 'self'" },
    }),
  });
  const install = (key: string, selfHostedUrl?: string) => verifyInstallation(new Request(
    `https://control.example/api/projects/${project.id}/releases/${release.id}/installation`,
    {
      method: "POST",
      headers: {
        ...authenticatedHeaders(owner),
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({ pageUrl: "https://acme.example/account", ...(selfHostedUrl ? { selfHostedUrl } : {}) }),
    },
  ), { params: Promise.resolve({ projectId: project.id, releaseId: release.id }) });

  const pendingResponse = await install("verify-self-host-pending");
  assert.equal(pendingResponse.status, 200, JSON.stringify(await pendingResponse.clone().json()));
  const pending = (await pendingResponse.json()).installation;
  assert.equal(pending.status, "pending_self_host");

  const selfHostedUrl = `https://acme.example/assets/${release.contentHash}.js`;
  const verifiedResponse = await install("verify-self-host-complete", selfHostedUrl);
  assert.equal(verifiedResponse.status, 200, JSON.stringify(await verifiedResponse.clone().json()));
  const verified = (await verifiedResponse.json()).installation;
  assert.notEqual(verified.id, pending.id);
  assert.equal(verified.status, "verified");
  assert.equal(verified.delivery, "self_hosted");
  assert.equal(verified.selfHostedUrl, selfHostedUrl);
  assert.equal(verified.attestation.executedArtifactUrl, selfHostedUrl);

  setReleaseVerificationPortForTest({
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async (input) => exactInstalledReport(input, {
      executedArtifactUrl: null,
      executedContentHash: null,
      registeredTools: [],
      duplicateLoadHarmless: null,
      executionEvidence: null,
      csp: { hosted: "blocked", directive: "script-src 'none'" },
    }),
  });
  const pendingReplay = await install("verify-self-host-pending");
  assert.equal(pendingReplay.status, 200);
  const replayedPending = (await pendingReplay.json()).installation;
  assert.equal(replayedPending.id, pending.id);
  assert.equal(replayedPending.status, "pending_self_host");
  assert.deepEqual(replayedPending.attestation, pending.attestation);
});

test("a capability change after subset verification rejects stale publication and a retry restores the tool", async () => {
  const repository = new CapabilityChangeAfterVerificationRepository();
  installTestRepository(repository);
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
    new Request(`https://control.example/api/releases/${release.contentHash}.js`),
    { params: Promise.resolve({ artifact: `${release.contentHash}.js` }) }
  );
  const code = await artifact.text();
  assert.equal(code, candidate.code);
  assert.match(code, /find_order/);
  assert.match(code, /create_support_ticket/);
});

test("a publication failure reports its stable artifact code, not an unmapped internal error", async () => {
  const { publishPersistedRelease } = await import("../src/releases.ts");
  const { ReleaseArtifactError } = await import("../src/artifact-storage.ts");
  const failing = {
    publish: async () => { throw new ReleaseArtifactError("RELEASE_ARTIFACT_READ_FAILED"); },
  };
  const rejection = await publishPersistedRelease(
    {} as never, { role: "viewer" } as never, "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222", "publish-key-0001",
    new AbortController().signal, failing as never,
  ).catch((error: unknown) => error);
  // A viewer is refused first; the point is that the store's own error type is
  // recognised rather than escaping as an internal error.
  assert.ok(rejection instanceof Error);
  assert.ok(ReleaseArtifactError.prototype instanceof Error);
});
