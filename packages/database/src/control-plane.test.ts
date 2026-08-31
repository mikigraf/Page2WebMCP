import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { acmeCapabilityEvidence, acmeCapabilityPlans } from "../../../apps/acme-support/src/capability-plans.ts";
import type { CapabilityPlan } from "../../capability-ir/src/plan.ts";
import { compileWebMcpRelease } from "../../compiler/src/compiler.ts";
import {
  capabilityStateDigest,
  InMemoryControlPlaneRepository,
  parsePersistedSourceConfiguration,
  RELEASE_VERIFICATION_CHECK_NAMES,
  RepositoryError,
  type CandidateRelease,
  type ControlPlaneRepository,
  type RepositoryActor,
  type VerificationRequest,
} from "./control-plane.ts";

function passedVerificationChecks() {
  return RELEASE_VERIFICATION_CHECK_NAMES.map((name) => ({ name, status: "passed" as const }));
}

const owner: RepositoryActor = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  role: "owner"
};
const editor: RepositoryActor = {
  id: "33333333-3333-3333-3333-333333333333",
  organizationId: owner.organizationId,
  role: "editor"
};
const outsider: RepositoryActor = {
  id: "22222222-2222-2222-2222-222222222222",
  organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  role: "owner"
};

const fixturePlans = acmeCapabilityPlans("https://acme.example");

function plans(...names: string[]): CapabilityPlan[] {
  return names.map((name) => fixturePlans.find((plan) => plan.tool.name === name)!);
}

function capabilities(...names: string[]) {
  return plans(...names).map((plan) => ({ plan, status: "proposed" as const }));
}

function evidenceFor(selectedPlans: CapabilityPlan[]) {
  const references = new Set(selectedPlans.flatMap((plan) => plan.evidence.map(({ reference }) => reference)));
  return acmeCapabilityEvidence().filter(({ reference }) => references.has(reference));
}

function releaseCandidate(code: string, selectedPlans = plans("find_order"), allowedOrigin = "https://acme.example") {
  const compiled = compileWebMcpRelease(selectedPlans);
  return {
    code,
    contentHash: createHash("sha256").update(Buffer.from(code)).digest("hex"),
    allowedOrigin,
    manifest: compiled.manifest
  };
}

function hostedArtifactIdentity(contentHash: string) {
  const artifactUrl = `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${contentHash}.js`;
  return {
    artifactUrl,
    downloadUrl: `${artifactUrl}?download=page2webmcp-${contentHash}.js`,
    localOnly: false,
  } as const;
}

function verificationEvidence(candidate: CandidateRelease, mode: VerificationRequest["verificationMode"]) {
  const manifest = candidate.manifest as {
    releaseId: string;
    plans: ReadonlyArray<{ tool: { name: string } }>;
  };
  return {
    verifierIdentity: {
      protocolVersion: 1 as const,
      mode,
      webMcpImplementation: "native" as const,
      verifierOriginDigest: "b".repeat(64),
    },
    observation: {
      observedContentHash: candidate.contentHash,
      observedIntegrity: `sha384-${createHash("sha384").update(candidate.code).digest("base64")}`,
      observedReleaseId: manifest.releaseId,
      observedTargetOrigin: candidate.allowedOrigin,
      registeredTools: manifest.plans.map(({ tool }) => tool.name).sort(),
      trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: candidate.contentHash },
      controlPlaneRequestsDuringExecution: 0,
      modelRequestsDuringExecution: 0,
    },
  } as const;
}

function saveVerification(
  repository: Pick<ControlPlaneRepository, "saveVerification">,
  actor: RepositoryActor,
  projectId: string,
  input: Omit<VerificationRequest, "verifierIdentity" | "observation">,
) {
  return repository.saveVerification(actor, projectId, {
    ...input,
    ...verificationEvidence(input.candidate, input.verificationMode),
  });
}

test("capability-state digests use locale-independent canonical ordering", () => {
  const capabilities = [
    {
      id: "a",
      analysisRunId: "run",
      stableName: "ä_tool",
      riskTier: "R1",
      status: "blocked",
      planDigest: "a".repeat(64),
      reviewedPlanDigest: "a".repeat(64),
      version: 2
    },
    {
      id: "b",
      analysisRunId: "run",
      stableName: "z_tool",
      riskTier: "R0",
      status: "proposed",
      planDigest: "b".repeat(64),
      reviewedPlanDigest: "b".repeat(64),
      version: 1
    }
  ] as const;

  assert.equal(
    capabilityStateDigest(capabilities),
    "b0bc597d219d762df7aa9900a075dc42fba1af6eaefb49d92b285a84ab159261"
  );
});

test("projects are tenant scoped and use opaque identifiers", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const request = {
    name: "Acme Support",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-opaque",
    inputHash: "project-opaque"
  } as const;
  const project = await repository.createProject(owner, request);

  assert.match(project.id, /^[0-9a-f-]{36}$/);
  assert.equal((await repository.createProject(owner, request)).id, project.id);
  await assert.rejects(
    repository.createProject(owner, { ...request, inputHash: "project-changed" }),
    (error: unknown) => error instanceof RepositoryError && error.code === "IDEMPOTENCY_CONFLICT"
  );
  assert.deepEqual(await repository.listProjects(editor), [project]);
  await assert.rejects(repository.getProject(outsider, project.id), (error: unknown) =>
    error instanceof RepositoryError && error.code === "NOT_FOUND");
});

test("in-memory records cannot mutate persisted repository state", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Immutable boundary",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-immutable-boundary",
    inputHash: "project-immutable-boundary"
  });

  project.name = "caller mutation";
  const listed = await repository.listProjects(owner);
  listed[0].status = "failed";

  const persisted = await repository.getProject(owner, project.id);
  assert.equal(persisted.name, "Immutable boundary");
  assert.equal(persisted.status, "created");
});

test("analysis enqueue is idempotent and leased jobs recover after expiry", async () => {
  let now = new Date("2026-08-29T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType: "openapi",
    url: "https://acme.example/openapi.json",
    sourceConfiguration: { kind: "openapi", targetOrigin: "https://acme.example", testPageUrl: "https://acme.example/", environment: "test" },
    idempotencyKey: "project-analysis-one",
    inputHash: "project-analysis-one"
  });
  const input = {
    projectId: project.id,
    idempotencyKey: "analysis-one",
    inputHash: "same-input"
  };

  const first = await repository.enqueueAnalysis(owner, input);
  const duplicate = await repository.enqueueAnalysis(owner, input);
  assert.equal(duplicate.id, first.id);
  await assert.rejects(
    repository.enqueueAnalysis(owner, { ...input, inputHash: "changed-input" }),
    (error: unknown) => error instanceof RepositoryError && error.code === "IDEMPOTENCY_CONFLICT"
  );

  const claimed = await repository.claimAnalysis("worker-a", 60_000);
  assert.equal(claimed?.id, first.id);
  assert.equal(claimed?.attempts, 1);
  assert.equal(claimed?.sourceType, "openapi");
  assert.equal(claimed?.sourceUrl, "https://acme.example/openapi.json");
  assert.equal(await repository.claimAnalysis("worker-b", 60_000), undefined);

  now = new Date(now.getTime() + 61_000);
  const recovered = await repository.claimAnalysis("worker-b", 60_000);
  assert.equal(recovered?.id, first.id);
  assert.equal(recovered?.attempts, 2);
});

test("analysis completion persists only the exact source-compatible provider provenance tuple", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Provider provenance",
    sourceType: "openapi",
    url: "https://widgets.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi", targetOrigin: "https://widgets.example",
      testPageUrl: "https://widgets.example/", environment: "test",
    },
    idempotencyKey: "provider-provenance-project",
    inputHash: "provider-provenance-project",
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "provider-provenance-analysis",
    inputHash: "provider-provenance-analysis",
  });
  const claim = await repository.claimAnalysis("provider-provenance-worker", 60_000);
  assert.equal(claim?.id, run.id);
  const providerProvenance = {
    mode: "openapi" as const,
    adapter: "bounded-openapi" as const,
    adapterVersion: 1 as const,
    fixture: false as const,
  };
  const completed = await repository.completeAnalysis("provider-provenance-worker", run.id, {
    capabilities: [],
    diagnostics: [{ code: "NO_SUPPORTED_OPERATIONS", operationKey: "document" }],
    evidence: [{
      source: "openapi",
      content: "{}",
      reference: `urn:sha256:${createHash("sha256").update("{}").digest("hex")}`,
    }],
    providerProvenance,
  }, claim!.leaseGeneration);
  assert.deepEqual(completed.providerProvenance, providerProvenance);

  const invalidProject = await repository.createProject(owner, {
    name: "Invalid provider provenance",
    sourceType: "website",
    url: "https://widgets.example",
    idempotencyKey: "invalid-provider-provenance-project",
    inputHash: "invalid-provider-provenance-project",
  });
  const invalidRun = await repository.enqueueAnalysis(owner, {
    projectId: invalidProject.id,
    idempotencyKey: "invalid-provider-provenance-analysis",
    inputHash: "invalid-provider-provenance-analysis",
  });
  const invalidClaim = await repository.claimAnalysis("invalid-provider-provenance-worker", 60_000);
  assert.equal(invalidClaim?.id, invalidRun.id);
  await assert.rejects(repository.completeAnalysis("invalid-provider-provenance-worker", invalidRun.id, {
    capabilities: [], diagnostics: [], evidence: [],
    providerProvenance: providerProvenance as never,
  }, invalidClaim!.leaseGeneration), (error: unknown) => error instanceof RepositoryError
    && error.code === "INVALID_STATE");
});

test("OpenAPI verification context is canonical, changes source identity, and is copied immutably to claimed jobs", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const configuration: {
    kind: "openapi";
    targetOrigin: string;
    testPageUrl: string;
    environment: "test" | "staging" | "production";
  } = {
    kind: "openapi" as const,
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/checkout",
    environment: "staging" as const,
  };
  const project = await repository.createProject(owner, {
    name: "OpenAPI verification context",
    sourceType: "openapi",
    url: "https://api.widgets.example/openapi.json",
    sourceConfiguration: configuration,
    idempotencyKey: "project-openapi-verification-context",
    inputHash: "project-openapi-verification-context",
  });
  const [source] = await repository.listProjectSources(owner, project.id);
  const [snapshot] = await repository.listSourceSnapshots(owner, project.id);
  assert.deepEqual(source?.sourceConfiguration, configuration);
  assert.ok(snapshot);

  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-openapi-verification-context",
    inputHash: "analysis-openapi-verification-context",
  });
  configuration.environment = "production";
  const claimed = await repository.claimAnalysis("openapi-verification-worker", 60_000);
  assert.equal(claimed?.id, run.id);
  assert.deepEqual(claimed?.sourceConfiguration, {
    kind: "openapi",
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/checkout",
    environment: "staging",
  });

  const changedConfigurationProject = await repository.createProject(owner, {
    name: "Changed OpenAPI verification context",
    sourceType: "openapi",
    url: "https://api.widgets.example/openapi.json",
    sourceConfiguration: { ...claimed!.sourceConfiguration, environment: "production" },
    idempotencyKey: "project-changed-openapi-verification-context",
    inputHash: "project-changed-openapi-verification-context",
  });
  const [changedSnapshot] = await repository.listSourceSnapshots(owner, changedConfigurationProject.id);
  assert.notEqual(changedSnapshot?.sourceIdentityHash, snapshot.sourceIdentityHash);
});

test("OpenAPI verification page queries are rejected before source persistence", async () => {
  assert.throws(() => parsePersistedSourceConfiguration("openapi", {
    kind: "openapi",
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/webmcp-test?tenant=secret",
    environment: "test",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "OPENAPI_VERIFICATION_CONTEXT_REQUIRED");

  const repository = new InMemoryControlPlaneRepository();
  await assert.rejects(repository.createProject(owner, {
    name: "Invalid OpenAPI page",
    sourceType: "openapi",
    url: "https://api.widgets.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: "https://widgets.example",
      testPageUrl: "https://widgets.example/webmcp-test?tenant=secret",
      environment: "test",
    },
    idempotencyKey: "openapi-query-page",
    inputHash: "openapi-query-page",
  }), (error: unknown) => error instanceof RepositoryError
    && error.code === "OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
  assert.deepEqual(await repository.listProjects(owner), []);
});

test("OpenAPI analysis rejects legacy-unconfigured sources while preserving tenant isolation", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const otherOwner = { ...owner, id: "99999999-9999-4999-8999-999999999999", organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  repository.seedMembershipForTest(otherOwner);
  await assert.rejects(
    repository.createProject(owner, {
      name: "Legacy OpenAPI source",
      sourceType: "openapi",
      url: "https://api.widgets.example/openapi.json",
      idempotencyKey: "project-legacy-openapi-source",
      inputHash: "project-legacy-openapi-source",
    }),
    (error: unknown) => error instanceof RepositoryError && error.code === "OPENAPI_VERIFICATION_CONTEXT_REQUIRED",
  );
  await assert.rejects(
    repository.createProject(owner, {
      name: "Free-form website configuration",
      sourceType: "website",
      url: "https://widgets.example/",
      sourceConfiguration: { kind: "website", unexpected: true } as unknown as { kind: "website" },
      idempotencyKey: "project-free-form-website-configuration",
      inputHash: "project-free-form-website-configuration",
    }),
    (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE",
  );
  const project = await repository.createProject(owner, {
    name: "Tenant scoped website",
    sourceType: "website",
    url: "https://widgets.example/",
    sourceConfiguration: { kind: "website" },
    idempotencyKey: "project-tenant-scoped-website",
    inputHash: "project-tenant-scoped-website",
  });
  await assert.rejects(repository.getProject(otherOwner, project.id), (error: unknown) =>
    error instanceof RepositoryError && error.code === "NOT_FOUND");
});

test("persisted source configuration rejects missing and unknown JSON fields at the repository boundary", () => {
  assert.throws(
    () => parsePersistedSourceConfiguration("website", undefined),
    (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE",
  );
  assert.throws(
    () => parsePersistedSourceConfiguration("website", { kind: "website", unexpected: true }),
    (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE",
  );
});

test("legacy persisted website and GitHub sources remain runnable while legacy OpenAPI is rejected", async () => {
  assert.deepEqual(parsePersistedSourceConfiguration("website", { kind: "legacy_unconfigured" }), { kind: "website" });
  assert.deepEqual(parsePersistedSourceConfiguration("github", { kind: "legacy_unconfigured" }), { kind: "github" });
  assert.throws(
    () => parsePersistedSourceConfiguration("openapi", { kind: "legacy_unconfigured" }),
    (error: unknown) => error instanceof RepositoryError && error.code === "OPENAPI_VERIFICATION_CONTEXT_REQUIRED",
  );

  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Active source lookup",
    sourceType: "website",
    url: "https://widgets.example/",
    sourceConfiguration: { kind: "website" },
    idempotencyKey: "project-active-source-lookup",
    inputHash: "project-active-source-lookup",
  });
  const source = await repository.getActiveProjectSource(owner, project.id);
  assert.equal(source.active, true);
  assert.equal(source.projectId, project.id);
});

test("analysis completion persists capability ownership and optimistic reviews", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-capabilities",
    inputHash: "project-capabilities"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-two",
    inputHash: "input"
  });
  await repository.claimAnalysis("worker-a", 60_000);
  const completed = await repository.completeAnalysis("worker-a", run.id, {
    capabilities: capabilities("find_order", "create_support_ticket"),
    diagnostics: [],
    evidence: evidenceFor(plans("find_order", "create_support_ticket")),
    release: releaseCandidate("export const fixture = true;", plans("find_order", "create_support_ticket"))
  });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.leaseOwner, undefined);
  assert.equal(completed.leaseExpiresAt, undefined);

  const listedCapabilities = await repository.listCapabilities(owner, project.id);
  const ticket = listedCapabilities.find((item) => item.stableName === "create_support_ticket");
  assert.ok(ticket);

  const reviewed = await repository.reviewCapability(editor, ticket.id, { action: "approve", expectedVersion: 1 });
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.version, 2);
  assert.equal(
    (await repository.getAnalysisResult(owner, run.id))?.capabilities
      .find((item) => item.plan.tool.name === ticket.stableName)?.status,
    "reviewed"
  );
  await assert.rejects(
    repository.reviewCapability(owner, ticket.id, { action: "approve", expectedVersion: 1 }),
    (error: unknown) => error instanceof RepositoryError && error.code === "VERSION_CONFLICT"
  );
});

test("eligible publication is content addressed and idempotent", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-publish",
    inputHash: "project-publish"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-three",
    inputHash: "input"
  });
  await repository.claimAnalysis("worker", 60_000);
  await repository.completeAnalysis("worker", run.id, {
    capabilities: capabilities("find_order"),
    diagnostics: [],
    evidence: evidenceFor(plans("find_order")),
    release: releaseCandidate("export const fixture = true;")
  });
  const capabilityState = capabilityStateDigest(await repository.listAnalysisCapabilities(owner, run.id));
  const verificationInput = {
    analysisRunId: run.id,
    capabilityStateDigest: capabilityState,
    candidate: releaseCandidate("export const fixture = true;"),
    schema: true,
    authenticated: true,
    replayPasses: 3,
    noSecretLeakage: true,
    browserExecution: true,
    selectionScore: 20,
    checks: passedVerificationChecks(),
    csp: { hosted: "allowed" as const },
    verificationMode: "hermetic" as const
  };
  const verification = await saveVerification(repository, owner, project.id, verificationInput);

  const request = {
    projectId: project.id,
    analysisRunId: run.id,
    capabilityStateDigest: capabilityState,
    candidateContentHash: verification.candidateContentHash,
    verificationRunId: verification.id,
    ...hostedArtifactIdentity(verification.candidateContentHash),
    idempotencyKey: "publish-one",
    inputHash: "publish-input"
  };
  await assert.rejects(repository.publishRelease(owner, {
    ...request,
    verificationRunId: "22222222-2222-4222-8222-222222222222",
    idempotencyKey: "publish-wrong-verification",
  }), (error: unknown) => error instanceof RepositoryError
    && error.code === "RELEASE_GATE_FAILED"
    && error.details?.includes("CANDIDATE_CHANGED"));
  const release = await repository.publishRelease(owner, request);
  const retriedVerification = await saveVerification(repository, owner, project.id, verificationInput);
  assert.equal(retriedVerification.id, verification.id);
  const duplicate = await repository.publishRelease(owner, request);
  assert.equal(duplicate.id, release.id);
  assert.equal(release.capabilityStateDigest, capabilityState);
  assert.equal(release.verificationRunId, verification.id);
  assert.match(release.contentHash, /^[0-9a-f]{64}$/);
  assert.match(release.sri, /^sha384-/);
  assert.deepEqual({
    artifactUrl: release.artifactUrl,
    downloadUrl: release.downloadUrl,
    localOnly: release.localOnly,
  }, hostedArtifactIdentity(release.contentHash));
  assert.ok(release.artifactUrl);
  assert.equal((await repository.getReleaseArtifact(release.contentHash)).code, "export const fixture = true;");
  const installationInput = {
    releaseId: release.id,
    pageUrl: "https://acme.example/account",
    artifactUrl: release.artifactUrl,
    downloadUrl: release.downloadUrl!,
    localOnly: false,
    targetOrigin: release.allowedOrigin,
    artifactContentHash: release.contentHash,
    integrity: release.sri,
    expectedTools: ["find_order"],
    status: "verified" as const,
    delivery: "hosted" as const,
    csp: { hosted: "allowed" as const },
    webMcpImplementation: "native" as const,
    verifierIdentity: {
      protocolVersion: 1 as const,
      mode: "hermetic" as const,
      webMcpImplementation: "native" as const,
      verifierOriginDigest: "b".repeat(64),
    },
    attestation: {
      observedArtifactUrl: release.artifactUrl,
      observedDownloadUrl: release.downloadUrl!,
      observedLocalOnly: false,
      observedIntegrity: release.sri,
      executedArtifactUrl: release.artifactUrl,
      servedContentHash: release.contentHash,
      executedContentHash: release.contentHash,
      observedTargetOrigin: release.allowedOrigin,
      registeredTools: ["find_order"],
      webMcpImplementation: "native" as const,
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: true,
      csp: { hosted: "allowed" as const },
    },
    idempotencyKey: "install-one",
    inputHash: "a".repeat(64),
  };
  const pendingInstallationInput = {
    ...installationInput,
    status: "pending_self_host" as const,
    csp: { hosted: "blocked" as const },
    attestation: {
      ...installationInput.attestation,
      executedArtifactUrl: null,
      executedContentHash: null,
      registeredTools: [],
      duplicateLoadHarmless: null,
      csp: { hosted: "blocked" as const },
    },
    idempotencyKey: "install-pending",
    inputHash: "f".repeat(64),
  };
  const pendingInstallation = await repository.saveReleaseInstallation(
    owner, project.id, pendingInstallationInput,
  );
  assert.equal(pendingInstallation.status, "pending_self_host");
  assert.equal((await repository.saveReleaseInstallation(
    owner, project.id, pendingInstallationInput,
  )).id, pendingInstallation.id);
  const installation = await repository.saveReleaseInstallation(owner, project.id, installationInput);
  assert.equal(installation.status, "verified");
  assert.notEqual(installation.id, pendingInstallation.id);
  assert.equal((await repository.saveReleaseInstallation(owner, project.id, installationInput)).id, installation.id);
  await assert.rejects(repository.saveReleaseInstallation(editor, project.id, {
    ...installationInput,
    idempotencyKey: "install-editor",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "FORBIDDEN");
  await assert.rejects(repository.saveReleaseInstallation(owner, project.id, {
    ...installationInput,
    artifactUrl: `https://unrelated.example/${release.contentHash}.js`,
    idempotencyKey: "install-unrelated-artifact",
    inputHash: "b".repeat(64),
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  await assert.rejects(repository.saveReleaseInstallation(owner, project.id, {
    ...installationInput,
    csp: { hosted: "blocked" },
    idempotencyKey: "install-contradictory-csp",
    inputHash: "e".repeat(64),
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  await assert.rejects(repository.publishRelease(owner, {
    ...request,
    artifactUrl: `https://unrelated.example/${release.contentHash}.js`,
    downloadUrl: `https://unrelated.example/${release.contentHash}.js?download=page2webmcp-${release.contentHash}.js`,
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  await assert.rejects(repository.publishRelease(owner, {
    ...request,
    capabilityStateDigest: "0".repeat(64),
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  await assert.rejects(repository.publishRelease(owner, {
    ...request,
    ...hostedArtifactIdentity(release.contentHash),
    artifactUrl: `https://unrelated.example/${release.contentHash}.js`,
    downloadUrl: `https://unrelated.example/${release.contentHash}.js?download=page2webmcp-${release.contentHash}.js`,
    idempotencyKey: "publish-other-artifact",
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
  await assert.rejects(saveVerification(repository, owner, project.id, {
    ...verificationInput,
    candidate: releaseCandidate("export const changedAfterPublish = true;")
  }), (error: unknown) => error instanceof RepositoryError
    && error.code === "RELEASE_GATE_FAILED"
    && error.details?.includes("CANDIDATE_CHANGED"));
  await assert.rejects(
    repository.publishRelease(editor, { ...request, idempotencyKey: "publish-editor" }),
    (error: unknown) => error instanceof RepositoryError && error.code === "FORBIDDEN"
  );
});

test("analysis ingestion rejects an exact plan without its immutable evidence", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Evidence gate",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-evidence-gate",
    inputHash: "project-evidence-gate"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-evidence-gate",
    inputHash: "analysis-evidence-gate"
  });
  await repository.claimAnalysis("evidence-worker", 60_000);
  await assert.rejects(repository.completeAnalysis("evidence-worker", run.id, {
    capabilities: capabilities("find_order"),
    diagnostics: [],
    evidence: [],
    release: releaseCandidate("export const evidenceGate = true;")
  }), (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE");
});

test("capability approval rejects evidence that expired after analysis", async () => {
  let now = new Date("2026-08-29T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await repository.createProject(owner, {
    name: "Review evidence gate",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-review-evidence",
    inputHash: "project-review-evidence"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-review-evidence",
    inputHash: "analysis-review-evidence"
  });
  await repository.claimAnalysis("review-evidence-worker", 60_000);
  await repository.completeAnalysis("review-evidence-worker", run.id, {
    capabilities: capabilities("create_support_ticket"),
    diagnostics: [],
    evidence: evidenceFor(plans("create_support_ticket")).map((item) => ({
      ...item,
      expiresAt: new Date(now.getTime() + 1_000).toISOString(),
    })),
    release: releaseCandidate("export const reviewEvidence = true;", plans("create_support_ticket"))
  });
  const [capability] = await repository.listAnalysisCapabilities(owner, run.id);
  assert.ok(capability);
  now = new Date(now.getTime() + 1_001);

  await assert.rejects(
    repository.reviewCapability(owner, capability.id, { action: "approve", expectedVersion: 1 }),
    (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("EVIDENCE_MISSING_OR_EXPIRED")
  );
});

test("only one analysis can be active for a project and expired idempotency keys can be reused", async () => {
  let now = new Date("2026-08-29T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-active",
    inputHash: "project-active"
  });
  const request = { projectId: project.id, idempotencyKey: "bounded-key", inputHash: "first" };
  const first = await repository.enqueueAnalysis(owner, request);

  await assert.rejects(
    repository.enqueueAnalysis(owner, { ...request, idempotencyKey: "another-key" }),
    (error: unknown) => error instanceof RepositoryError && error.code === "INVALID_STATE"
  );

  await repository.claimAnalysis("worker", 60_000);
  await repository.failAnalysis("worker", first.id, "TERMINAL", false);
  now = new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 1);

  const replacement = await repository.enqueueAnalysis(owner, request);
  assert.notEqual(replacement.id, first.id);
});

test("idempotency is organization scoped even when an actor identifier is reused", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const projectA = await repository.createProject(owner, {
    name: "A",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-org-a",
    inputHash: "project-org-a"
  });
  const sameActorOtherOrganization: RepositoryActor = {
    ...owner,
    organizationId: outsider.organizationId
  };
  const projectB = await repository.createProject(sameActorOtherOrganization, {
    name: "B",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-org-b",
    inputHash: "project-org-b"
  });
  const first = await repository.enqueueAnalysis(owner, {
    projectId: projectA.id,
    idempotencyKey: "same-key",
    inputHash: "same-input"
  });
  const second = await repository.enqueueAnalysis(sameActorOtherOrganization, {
    projectId: projectB.id,
    idempotencyKey: "same-key",
    inputHash: "same-input"
  });
  assert.notEqual(first.id, second.id);
});

test("expired leases cannot be heartbeated or completed and exhausted jobs fail the project", async () => {
  let now = new Date("2026-08-29T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-lease",
    inputHash: "project-lease"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "lease",
    inputHash: "lease"
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal((await repository.claimAnalysis(`worker-${attempt}`, 1_000))?.attempts, attempt);
    now = new Date(now.getTime() + 1_001);
    await assert.rejects(
      repository.heartbeatAnalysis(`worker-${attempt}`, run.id, 60_000),
      (error: unknown) => error instanceof RepositoryError && error.code === "LEASE_LOST"
    );
  }

  assert.equal(await repository.claimAnalysis("worker-4", 1_000), undefined);
  assert.equal((await repository.getAnalysis(owner, run.id)).status, "failed");
  assert.equal((await repository.getProject(owner, project.id)).status, "failed");
});

test("retryable failures use the same bounded queue backoff as Postgres", async () => {
  let now = new Date("2026-08-29T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => now);
  const project = await repository.createProject(owner, {
    name: "Backoff",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-backoff",
    inputHash: "project-backoff"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-backoff",
    inputHash: "analysis-backoff"
  });
  await repository.claimAnalysis("worker", 60_000);
  const failedAttempt = await repository.failAnalysis("worker", run.id, "RETRYABLE", true);
  assert.equal(failedAttempt.status, "queued");
  assert.equal(failedAttempt.errorCode, "RETRYABLE");
  assert.equal(failedAttempt.leaseOwner, undefined);
  assert.equal(await repository.claimAnalysis("worker", 60_000), undefined);
  now = new Date(now.getTime() + 1_001);
  assert.equal((await repository.claimAnalysis("worker", 60_000))?.attempts, 2);
});

test("publication atomically rejects a stale capability-state verification", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-stale",
    inputHash: "project-stale"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-state",
    inputHash: "analysis-state"
  });
  await repository.claimAnalysis("worker", 60_000);
  await repository.completeAnalysis("worker", run.id, {
    capabilities: capabilities("create_support_ticket"),
    diagnostics: [],
    evidence: evidenceFor(plans("create_support_ticket")),
    release: releaseCandidate("export const state = true;", plans("create_support_ticket"))
  });
  const [capability] = await repository.listAnalysisCapabilities(owner, run.id);
  const staleDigest = capabilityStateDigest([capability]);
  const verification = await saveVerification(repository, owner, project.id, {
    analysisRunId: run.id,
    capabilityStateDigest: staleDigest,
    candidate: releaseCandidate("export const state = true;", plans("create_support_ticket")),
    schema: true,
    authenticated: true,
    replayPasses: 3,
    noSecretLeakage: true,
    browserExecution: true,
    selectionScore: 20,
    checks: passedVerificationChecks(),
    csp: { hosted: "allowed" as const },
    verificationMode: "hermetic" as const
  });
  await repository.reviewCapability(owner, capability.id, { action: "approve", expectedVersion: 1 });

  await assert.rejects(
    repository.publishRelease(owner, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: staleDigest,
      candidateContentHash: verification.candidateContentHash,
      verificationRunId: verification.id,
      ...hostedArtifactIdentity(verification.candidateContentHash),
      idempotencyKey: "stale-release",
      inputHash: "stale-release"
    }),
    (error: unknown) => error instanceof RepositoryError
      && error.code === "RELEASE_GATE_FAILED"
      && error.details?.includes("CAPABILITIES_CHANGED")
  );
});

test("a blocked capability publishes reviewed bytes without mutating the worker candidate", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Reviewed subset",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-reviewed-subset",
    inputHash: "project-reviewed-subset"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-reviewed-subset",
    inputHash: "analysis-reviewed-subset"
  });
  await repository.claimAnalysis("subset-worker", 60_000);
  const sourceCandidate = releaseCandidate("export const includesAll = true;", plans("find_order", "create_support_ticket"));
  await repository.completeAnalysis("subset-worker", run.id, {
    capabilities: capabilities("find_order", "create_support_ticket"),
    diagnostics: [],
    evidence: evidenceFor(plans("find_order", "create_support_ticket")),
    release: sourceCandidate
  });
  const listedCapabilities = await repository.listAnalysisCapabilities(owner, run.id);
  const read = listedCapabilities.find((capability) => capability.stableName === "find_order");
  const mutation = listedCapabilities.find((capability) => capability.stableName === "create_support_ticket");
  assert.ok(read);
  assert.ok(mutation);
  await repository.reviewCapability(owner, mutation.id, { action: "block", expectedVersion: 1 });

  const reviewed = await repository.listAnalysisCapabilities(owner, run.id);
  const digest = capabilityStateDigest(reviewed);
  const candidate = releaseCandidate("export const reviewedSubset = ['find_order'];", plans("find_order"));
  const verification = await saveVerification(repository, owner, project.id, {
    analysisRunId: run.id,
    capabilityStateDigest: digest,
    candidate,
    schema: true,
    authenticated: true,
    replayPasses: 3,
    noSecretLeakage: true,
    browserExecution: true,
    selectionScore: 20,
    checks: passedVerificationChecks(),
    csp: { hosted: "allowed" as const },
    verificationMode: "hermetic" as const
  });
  const release = await repository.publishRelease(owner, {
    projectId: project.id,
    analysisRunId: run.id,
    capabilityStateDigest: digest,
    candidateContentHash: verification.candidateContentHash,
    verificationRunId: verification.id,
    ...hostedArtifactIdentity(verification.candidateContentHash),
    idempotencyKey: "publish-reviewed-subset",
    inputHash: "publish-reviewed-subset"
  });

  assert.equal(release.code, candidate.code);
  assert.equal(release.contentHash, candidate.contentHash);
  assert.equal((await repository.getAnalysisResult(owner, run.id))?.release?.code, sourceCandidate.code);
});

test("candidate hashes are validated and a later verification cannot be overwritten by an older publish", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Candidate race",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-candidate-race",
    inputHash: "project-candidate-race"
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-candidate-race",
    inputHash: "analysis-candidate-race"
  });
  await repository.claimAnalysis("candidate-worker", 60_000);
  await repository.completeAnalysis("candidate-worker", run.id, {
    capabilities: capabilities("find_order"),
    diagnostics: [],
    evidence: evidenceFor(plans("find_order")),
    release: releaseCandidate("export const initial = true;")
  });
  const digest = capabilityStateDigest(await repository.listAnalysisCapabilities(owner, run.id));
  await assert.rejects(saveVerification(repository, owner, project.id, {
    analysisRunId: run.id,
    capabilityStateDigest: digest,
    candidate: { ...releaseCandidate("export const bad = true;"), contentHash: "0".repeat(64) },
    schema: true,
    authenticated: true,
    replayPasses: 3,
    noSecretLeakage: true,
    browserExecution: true,
    selectionScore: 20,
    checks: passedVerificationChecks(),
    csp: { hosted: "allowed" as const },
    verificationMode: "hermetic" as const
  }), (error: unknown) => error instanceof RepositoryError
    && error.code === "RELEASE_GATE_FAILED"
    && error.details?.includes("CANDIDATE_HASH_MISMATCH"));

  const first = await saveVerification(repository, owner, project.id, {
    analysisRunId: run.id,
    capabilityStateDigest: digest,
    candidate: releaseCandidate("export const candidate = 'first';"),
    schema: true,
    authenticated: true,
    replayPasses: 3,
    noSecretLeakage: true,
    browserExecution: true,
    selectionScore: 20,
    checks: passedVerificationChecks(),
    csp: { hosted: "allowed" as const },
    verificationMode: "hermetic" as const
  });
  const second = await saveVerification(repository, owner, project.id, {
    analysisRunId: run.id,
    capabilityStateDigest: digest,
    candidate: releaseCandidate("export const candidate = 'second';"),
    schema: true,
    authenticated: true,
    replayPasses: 3,
    noSecretLeakage: true,
    browserExecution: true,
    selectionScore: 20,
    checks: passedVerificationChecks(),
    csp: { hosted: "allowed" as const },
    verificationMode: "hermetic" as const
  });
  await assert.rejects(repository.publishRelease(owner, {
    projectId: project.id,
    analysisRunId: run.id,
    capabilityStateDigest: digest,
    candidateContentHash: first.candidateContentHash,
    verificationRunId: first.id,
    ...hostedArtifactIdentity(first.candidateContentHash),
    idempotencyKey: "publish-old-candidate",
    inputHash: "publish-old-candidate"
  }), (error: unknown) => error instanceof RepositoryError
    && error.code === "RELEASE_GATE_FAILED"
    && error.details?.includes("CANDIDATE_CHANGED"));

  const release = await repository.publishRelease(owner, {
    projectId: project.id,
    analysisRunId: run.id,
    capabilityStateDigest: digest,
    candidateContentHash: second.candidateContentHash,
    verificationRunId: second.id,
    ...hostedArtifactIdentity(second.candidateContentHash),
    idempotencyKey: "publish-new-candidate",
    inputHash: "publish-new-candidate"
  });
  assert.equal(release.code, "export const candidate = 'second';");
});

test("latest published release recovery is tenant scoped and carries its exact verification", async () => {
  let instant = Date.parse("2026-08-31T12:00:00.000Z");
  const repository = new InMemoryControlPlaneRepository(() => new Date(instant++));
  const project = await repository.createProject(owner, {
    name: "Acme Support",
    sourceType: "website",
    url: "https://acme.example",
    idempotencyKey: "project-attribution",
    inputHash: "project-attribution"
  });
  const releases = [];
  for (let index = 0; index < 2; index += 1) {
    const run = await repository.enqueueAnalysis(owner, {
      projectId: project.id,
      idempotencyKey: `analysis-${index}`,
      inputHash: `analysis-${index}`
    });
    await repository.claimAnalysis(`worker-${index}`, 60_000);
    await repository.completeAnalysis(`worker-${index}`, run.id, {
      capabilities: capabilities("find_order"),
      diagnostics: [],
      evidence: evidenceFor(plans("find_order")),
      release: releaseCandidate("export const same = true;")
    });
    const digest = capabilityStateDigest(await repository.listAnalysisCapabilities(owner, run.id));
    const verification = await saveVerification(repository, owner, project.id, {
      analysisRunId: run.id,
      capabilityStateDigest: digest,
      candidate: releaseCandidate("export const same = true;"),
      schema: true,
      authenticated: true,
      replayPasses: 3,
      noSecretLeakage: true,
      browserExecution: true,
      selectionScore: 20,
    checks: passedVerificationChecks(),
    csp: { hosted: "allowed" as const },
    verificationMode: "hermetic" as const
    });
    releases.push(await repository.publishRelease(owner, {
      projectId: project.id,
      analysisRunId: run.id,
      capabilityStateDigest: digest,
      candidateContentHash: verification.candidateContentHash,
      verificationRunId: verification.id,
      ...hostedArtifactIdentity(verification.candidateContentHash),
      idempotencyKey: `release-${index}`,
      inputHash: `release-${index}`
    }));
  }

  assert.notEqual(releases[0].id, releases[1].id);
  assert.notEqual(releases[0].analysisRunId, releases[1].analysisRunId);
  assert.equal(releases[0].contentHash, releases[1].contentHash);
  assert.equal((await repository.getReleaseArtifact(releases[0].contentHash)).code, "export const same = true;");
  const latest = await repository.getLatestPublishedRelease(owner, project.id);
  assert.equal(latest?.release.id, releases[1].id);
  assert.equal(latest?.verification.analysisRunId, releases[1].analysisRunId);
  assert.equal(latest?.verification.capabilityStateDigest, releases[1].capabilityStateDigest);
  assert.equal(latest?.verification.candidateContentHash, releases[1].contentHash);
  assert.deepEqual(latest?.verification.csp, { hosted: "allowed" });
  await assert.rejects(repository.getLatestPublishedRelease(outsider, project.id), (error: unknown) =>
    error instanceof RepositoryError && error.code === "NOT_FOUND");
});
