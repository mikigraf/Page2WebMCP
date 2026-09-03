import { createHash } from "node:crypto";
import { z } from "zod";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { CapabilityPlanSchema, type CapabilityPlan } from "../../../packages/capability-ir/src/plan.ts";
import {
  capabilityPlanDigest,
  capabilityStateDigest,
  deriveInstallationOperationId,
  normalizeReleaseArtifactIdentity,
  persistedReleaseArtifactIdentity,
  verifierEnvironmentForSource,
  type AnalysisResult,
  type CandidateRelease,
  type CapabilityRecord,
  type ControlPlaneRepository,
  type PublishedReleaseState,
  type ReleaseRecord,
  type ReleaseInstallationRecord,
  type RepositoryActor,
  type VerificationRecord,
  type VerificationRequest
} from "../../../packages/database/src/control-plane.ts";
import { ApiError } from "./api.ts";
import {
  ReleaseArtifactError,
  releaseArtifactStore,
  type ReleaseArtifactStore,
} from "./artifact-storage.ts";
import {
  attestReleaseCandidate,
  attestReleaseInstallation,
  releaseVerificationPort,
  REQUIRED_CANDIDATE_CHECKS,
  type CandidateAttestation,
} from "./release-verification.ts";

const ManifestSchema = z.object({
  version: z.literal(3),
  rendererId: z.string().regex(/^[a-f0-9]{64}$/),
  releaseId: z.string().regex(/^[a-f0-9]{64}$/),
  integrityPolicy: z.object({
    enforcement: z.literal("trusted-loader-required"),
    algorithms: z.tuple([z.literal("sha256"), z.literal("sha384")])
  }).strict(),
  targetOrigin: z.string().url(),
  plans: z.array(CapabilityPlanSchema).min(1).max(100)
}).strict();

export async function publishPersistedRelease(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
  analysisRunId: string,
  idempotencyKey: string,
  signal: AbortSignal = new AbortController().signal,
  artifactStore: ReleaseArtifactStore = releaseArtifactStore(),
): Promise<ReleaseRecord & { url: string; installation: ReleaseInstallationGuide }> {
  if (actor.role !== "owner") throw new ApiError("FORBIDDEN", 403);
  const project = await repository.getProject(actor, projectId);
  const run = await repository.getAnalysis(actor, analysisRunId);
  if (run.projectId !== project.id || run.status !== "succeeded") throw new ApiError("INVALID_STATE", 409);
  const result = await repository.getAnalysisResult(actor, run.id);
  if (!result) throw new ApiError("INVALID_STATE", 409);
  assertCurrentEvidence(result, actor.organizationId, project.id, run.id);
  const sourceCandidate = result.release;
  if (!sourceCandidate) throw new ApiError("INVALID_STATE", 409);
  const capabilities = await repository.listAnalysisCapabilities(actor, run.id);

  const pendingReview = capabilities.some((capability) =>
    (capability.riskTier === "R1" || capability.riskTier === "R2")
      && capability.status === "proposed"
  );
  if (pendingReview) throw new ApiError("REVIEW_REQUIRED", 409);
  const target = await resolveReleaseTarget(
    repository,
    actor,
    project.id,
    run.id,
    sourceCandidate,
  );
  // Publishing an already published candidate must not re-execute it: the
  // target page now serves that release, so the candidate registers no tools
  // and is refused. The candidate is content-addressed, so an unchanged hash
  // means the stored attestation describes exactly these bytes.
  const prepared = deriveVerification(analysisRunId, target.targetOrigin, result, capabilities);
  const published = await repository.getLatestPublishedRelease(actor, project.id);
  const reusable = published?.verification.analysisRunId === run.id
    && published.verification.candidateContentHash === prepared.candidate.contentHash
    ? published.verification
    : undefined;
  const verification = reusable ?? await repository.saveVerification(actor, project.id,
    await deriveTrustedVerification(project.id, analysisRunId, target, result, capabilities, signal));
  if (!verification.eligible) {
    throw new ApiError("RELEASE_GATE_FAILED", 409, false,
      verification.failures.length > 0 ? verification.failures : ["VERIFICATION_INELIGIBLE"]);
  }
  const candidate = prepared.candidate;
  const integrity = `sha384-${createHash("sha384").update(candidate.code).digest("base64")}`;
  // Publication failures are stable, actionable codes; reporting them as an
  // unmapped 500 leaves an operator with nothing to act on.
  let publication;
  try {
    publication = await artifactStore.publish({
      code: candidate.code,
      contentHash: candidate.contentHash,
      integrity,
      targetOrigin: target.targetOrigin,
    }, signal);
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw new ApiError(error.message, 502, true);
    throw error;
  }
  if (publication.contentHash !== candidate.contentHash || publication.integrity !== integrity) {
    throw new Error("RELEASE_ARTIFACT_IDENTITY_MISMATCH");
  }
  let artifactIdentity: ReturnType<typeof normalizeReleaseArtifactIdentity>;
  try {
    artifactIdentity = normalizeReleaseArtifactIdentity(publication, candidate.contentHash);
  } catch {
    throw new Error("RELEASE_ARTIFACT_IDENTITY_MISMATCH");
  }
  const inputHash = createHash("sha256")
    .update(JSON.stringify({
      analysisRunId,
      projectId,
      capabilityStateDigest: verification.capabilityStateDigest,
      candidateContentHash: verification.candidateContentHash,
      verificationRunId: verification.id,
      artifactUrl: artifactIdentity.artifactUrl,
      downloadUrl: artifactIdentity.downloadUrl,
      localOnly: artifactIdentity.localOnly,
    }))
    .digest("hex");
  const release = await repository.publishRelease(actor, {
    projectId,
    analysisRunId,
    capabilityStateDigest: verification.capabilityStateDigest,
    candidateContentHash: verification.candidateContentHash,
    verificationRunId: verification.id,
    ...artifactIdentity,
    idempotencyKey,
    inputHash
  });
  const persistedIdentity = assertPublishedReleaseConvergence({
    release,
    candidate,
    artifactIdentity,
    integrity,
    targetOrigin: target.targetOrigin,
    organizationId: actor.organizationId,
    projectId,
    analysisRunId,
    capabilityStateDigest: verification.capabilityStateDigest,
    verificationRunId: verification.id,
  });
  const previous = await repository.getPreviousRelease(actor, project.id, release.id);
  return {
    ...release,
    url: persistedIdentity.artifactUrl,
    installation: buildReleaseInstallationGuide(release, verification, previous, target.verificationPageUrl),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Key-order-independent comparison. A stored manifest round-trips through JSONB,
 * which does not preserve object key order, so comparing raw serialisations
 * reports a difference where the documents are identical.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPublishedReleaseConvergence(input: Readonly<{
  release: ReleaseRecord;
  candidate: CandidateRelease;
  artifactIdentity: ReturnType<typeof normalizeReleaseArtifactIdentity>;
  integrity: string;
  targetOrigin: string;
  organizationId: string;
  projectId: string;
  analysisRunId: string;
  capabilityStateDigest: string;
  verificationRunId: string;
}>): ReturnType<typeof normalizeReleaseArtifactIdentity> {
  const { release, candidate } = input;
  const persistedIdentity = persistedReleaseArtifactIdentity(release);
  const candidateManifest = ManifestSchema.safeParse(candidate.manifest);
  const releaseManifest = ManifestSchema.safeParse(release.manifest);
  const codeHash = createHash("sha256").update(release.code).digest("hex");
  const codeIntegrity = `sha384-${createHash("sha384").update(release.code).digest("base64")}`;
  // Naming the divergent fields turns an opaque 409 into something an operator
  // can act on; none of them carries a value, only the field name.
  const divergent = [
    !persistedIdentity && "artifact_identity",
    !candidateManifest.success && "candidate_manifest",
    !releaseManifest.success && "release_manifest",
    release.organizationId !== input.organizationId && "organization",
    release.projectId !== input.projectId && "project",
    release.analysisRunId !== input.analysisRunId && "analysis_run",
    release.capabilityStateDigest !== input.capabilityStateDigest && "capability_state_digest",
    !UUID.test(release.verificationRunId ?? "") && "verification_run",
    release.code !== candidate.code && "code",
    release.contentHash !== candidate.contentHash && "content_hash",
    codeHash !== candidate.contentHash && "code_hash",
    release.sri !== input.integrity && "sri",
    codeIntegrity !== input.integrity && "code_integrity",
    release.allowedOrigin !== input.targetOrigin && "release_allowed_origin",
    candidate.allowedOrigin !== input.targetOrigin && "candidate_allowed_origin",
    candidateManifest.success && releaseManifest.success
      && releaseManifest.data.releaseId !== candidateManifest.data.releaseId && "manifest_release_id",
    candidateManifest.success && releaseManifest.success
      && canonicalJson(releaseManifest.data) !== canonicalJson(candidateManifest.data) && "manifest",
    persistedIdentity && persistedIdentity.artifactUrl !== input.artifactIdentity.artifactUrl && "artifact_url",
    persistedIdentity && persistedIdentity.downloadUrl !== input.artifactIdentity.downloadUrl && "download_url",
    persistedIdentity && persistedIdentity.localOnly !== input.artifactIdentity.localOnly && "local_only",
  ].filter((value): value is string => typeof value === "string");
  if (divergent.length > 0 || !persistedIdentity) {
    throw new ApiError("INVALID_STATE", 409, false, divergent);
  }
  return persistedIdentity;
}

export type ReleaseInstallationGuide = Readonly<{
  artifactUrl: string;
  downloadUrl: string;
  moduleScriptTag: string;
  manifest: unknown;
  integrity: string;
  contentHash: string;
  targetOrigin: string;
  verificationPageUrl: string;
  localOnly: boolean;
  compatibility: { moduleScripts: true; webMcp: "native-current-required" };
  csp: VerificationRecord["csp"];
  selfHost: { required: boolean; guidance: string };
  previousRelease: null | { id: string; contentHash: string; integrity: string; artifactUrl: string };
  installed: boolean;
  productionVerified: boolean;
  attestation: null | Readonly<{
    id: string;
    status: ReleaseInstallationRecord["status"];
    delivery: ReleaseInstallationRecord["delivery"];
    pageUrl: string;
    selfHostedUrl: string | null;
    webMcpImplementation: ReleaseInstallationRecord["webMcpImplementation"];
    verifierMode: NonNullable<ReleaseInstallationRecord["verifierIdentity"]>["mode"];
    registeredTools: readonly string[];
    executedContentHash: string | null;
    normalPageLoad: boolean;
    routeInterception: boolean;
    injectedRegistration: boolean;
    syntheticHarness: boolean;
    verifiedAt: string | null;
  }>;
}>;

export type ResumableReleaseResult = Readonly<{
  id: string;
  url: string;
  installation: ReleaseInstallationGuide;
}>;

export async function recoverLatestPublishedRelease(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
): Promise<ResumableReleaseResult | undefined> {
  const state: PublishedReleaseState | undefined = await repository.getLatestPublishedRelease(actor, projectId);
  if (!state) return undefined;
  const { release, verification } = state;
  const identity = persistedReleaseArtifactIdentity(release);
  // Releases created before immutable Storage identity was introduced remain
  // readable for audit purposes, but they cannot produce an installation guide.
  // Omit that optional projection instead of making the whole project
  // impossible to resume.
  if (!identity) return undefined;
  if (!verification.eligible || release.organizationId !== actor.organizationId || release.projectId !== projectId
    || verification.projectId !== projectId || verification.analysisRunId !== release.analysisRunId
    || verification.capabilityStateDigest !== release.capabilityStateDigest
    || verification.candidateContentHash !== release.contentHash) {
    throw new ApiError("INVALID_STATE", 409);
  }
  const target = await resolveReleaseTarget(repository, actor, projectId, release.analysisRunId, release);
  if (target.targetOrigin !== release.allowedOrigin) throw new ApiError("INVALID_STATE", 409);
  const previous = await repository.getPreviousRelease(actor, projectId, release.id);
  const installation = await repository.getLatestReleaseInstallation(actor, projectId, release.id);
  return {
    id: release.id,
    url: identity.artifactUrl,
    installation: buildReleaseInstallationGuide(
      release, verification, previous, target.verificationPageUrl, installation,
    ),
  };
}

export function buildReleaseInstallationGuide(
  release: ReleaseRecord,
  verification: VerificationRecord,
  previous: ReleaseRecord | undefined,
  verificationPageUrl: string,
  installation?: ReleaseInstallationRecord,
): ReleaseInstallationGuide {
  const identity = persistedReleaseArtifactIdentity(release);
  if (!identity) throw new ApiError("INVALID_STATE", 409);
  let verifiedPage: URL;
  try {
    verifiedPage = new URL(verificationPageUrl);
  } catch {
    throw new ApiError("INVALID_STATE", 409);
  }
  if (verifiedPage.protocol !== "https:" || verifiedPage.origin !== release.allowedOrigin
    || verifiedPage.username || verifiedPage.password || verifiedPage.search || verifiedPage.hash) {
    throw new ApiError("INVALID_STATE", 409);
  }
  const previousIdentity = previous ? persistedReleaseArtifactIdentity(previous) : undefined;
  const persistedAttestation = installation
    ? releaseInstallationProjection(release, installation)
    : null;
  const productionVerified = identity.localOnly === false
    && persistedAttestation?.status === "verified"
    && persistedAttestation.webMcpImplementation === "native"
    && verifierChainMatches(verification, installation);
  return {
    artifactUrl: identity.artifactUrl,
    downloadUrl: identity.downloadUrl,
    moduleScriptTag: `<script type="module" src="${identity.artifactUrl}" integrity="${release.sri}" crossorigin="anonymous"></script>`,
    manifest: release.manifest,
    integrity: release.sri,
    contentHash: release.contentHash,
    targetOrigin: release.allowedOrigin,
    verificationPageUrl: verifiedPage.toString(),
    localOnly: identity.localOnly,
    compatibility: { moduleScripts: true, webMcp: "native-current-required" },
    csp: verification.csp,
    selfHost: {
      required: identity.localOnly || verification.csp.hosted === "blocked",
      guidance: identity.localOnly
        ? "Loopback delivery validates bytes only. Host the downloaded bytes unchanged on the target HTTPS origin, or publish from hosted Storage, then verify that exact SHA-256."
        : "Host the downloaded bytes unchanged on the target origin, then verify that exact SHA-256 before installation.",
    },
    previousRelease: previous && previousIdentity ? {
      id: previous.id,
      contentHash: previous.contentHash,
      integrity: previous.sri,
      artifactUrl: previousIdentity.artifactUrl,
    } : null,
    installed: persistedAttestation?.status === "verified"
      && persistedAttestation.webMcpImplementation === "native",
    productionVerified,
    attestation: persistedAttestation,
  };
}

function verifierChainMatches(
  candidate: VerificationRecord,
  installation: ReleaseInstallationRecord | undefined,
): boolean {
  const candidateIdentity = candidate.verifierIdentity;
  const installationIdentity = installation?.verifierIdentity;
  const candidateAttestation = candidate.observation?.verifierAttestation;
  const installationAttestation = installation?.attestation.verifierAttestation;
  return candidate.verificationMode === "live"
    && candidateIdentity?.mode === "live"
    && installationIdentity?.mode === "live"
    && candidateIdentity.protocolVersion === 2
    && installationIdentity.protocolVersion === 2
    && candidateIdentity.protocolVersion === installationIdentity.protocolVersion
    && candidateIdentity.webMcpImplementation === installationIdentity.webMcpImplementation
    && candidateIdentity.verifierOriginDigest === installationIdentity.verifierOriginDigest
    && candidateAttestation?.operation === "candidate"
    && installationAttestation?.operation === "installation"
    && candidateAttestation.attestationId !== installationAttestation.attestationId
    && candidateAttestation.requestId !== installationAttestation.requestId;
}

function releaseInstallationProjection(
  release: ReleaseRecord,
  installation: ReleaseInstallationRecord,
): NonNullable<ReleaseInstallationGuide["attestation"]> {
  const identity = persistedReleaseArtifactIdentity(release);
  const report = installation.attestation;
  if (!identity || !installation.verifierIdentity
    || installation.releaseId !== release.id || installation.projectId !== release.projectId
    || installation.organizationId !== release.organizationId
    || installation.artifactUrl !== identity.artifactUrl || installation.downloadUrl !== identity.downloadUrl
    || installation.localOnly !== identity.localOnly || installation.targetOrigin !== release.allowedOrigin
    || installation.artifactContentHash !== release.contentHash || installation.integrity !== release.sri
    || report.observedArtifactUrl !== identity.artifactUrl || report.observedDownloadUrl !== identity.downloadUrl
    || report.observedLocalOnly !== identity.localOnly || report.observedIntegrity !== release.sri
    || report.observedTargetOrigin !== release.allowedOrigin || report.servedContentHash !== release.contentHash
    || installation.status === "verified" && (
      installation.webMcpImplementation !== "native" || report.executedContentHash !== release.contentHash
      || report.normalPageLoad !== true || report.routeInterception !== false
      || report.injectedRegistration !== false || report.syntheticHarness !== false
      || report.executionEvidence === null || !installation.verifiedAt
    )) throw new ApiError("INVALID_STATE", 409);
  return {
    id: installation.id,
    status: installation.status,
    delivery: installation.delivery,
    pageUrl: installation.pageUrl,
    selfHostedUrl: installation.selfHostedUrl ?? null,
    webMcpImplementation: installation.webMcpImplementation,
    verifierMode: installation.verifierIdentity.mode,
    registeredTools: [...report.registeredTools],
    executedContentHash: report.executedContentHash,
    normalPageLoad: report.normalPageLoad,
    routeInterception: report.routeInterception,
    injectedRegistration: report.injectedRegistration,
    syntheticHarness: report.syntheticHarness,
    verifiedAt: installation.verifiedAt ?? null,
  };
}

export async function verifyPersistedRelease(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
  analysisRunId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<VerificationRecord> {
  if (actor.role !== "owner") throw new ApiError("FORBIDDEN", 403);
  const project = await repository.getProject(actor, projectId);
  const run = await repository.getAnalysis(actor, analysisRunId);
  if (run.projectId !== project.id || run.status !== "succeeded") throw new ApiError("INVALID_STATE", 409);
  const result = await repository.getAnalysisResult(actor, run.id);
  if (!result) throw new ApiError("INVALID_STATE", 409);
  assertCurrentEvidence(result, actor.organizationId, project.id, run.id);
  const sourceCandidate = result.release;
  if (!sourceCandidate) throw new ApiError("INVALID_STATE", 409);
  const capabilities = await repository.listAnalysisCapabilities(actor, run.id);
  // Re-executing an already published candidate is not only redundant but
  // impossible: the target page now serves that very release, so the candidate
  // registers no tools and the report is refused. The candidate is
  // content-addressed, so an unchanged hash means the stored attestation
  // describes exactly these bytes.
  const published = await repository.getLatestPublishedRelease(actor, project.id);
  if (published?.verification.analysisRunId === run.id
    && published.verification.candidateContentHash === sourceCandidate.contentHash) {
    return published.verification;
  }
  const target = await resolveReleaseTarget(
    repository,
    actor,
    project.id,
    run.id,
    sourceCandidate,
  );
  return repository.saveVerification(actor, project.id,
    await deriveTrustedVerification(project.id, run.id, target, result, capabilities, signal));
}

export async function verifyInstalledRelease(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
  releaseId: string,
  pageUrl: string,
  selfHostedUrl: string | undefined,
  idempotencyKey: string,
  signal: AbortSignal,
): Promise<ReleaseInstallationRecord> {
  if (actor.role !== "owner") throw new ApiError("FORBIDDEN", 403);
  const release = await repository.getRelease(actor, projectId, releaseId);
  const manifest = ManifestSchema.safeParse(release.manifest);
  if (!manifest.success || manifest.data.targetOrigin !== release.allowedOrigin) {
    throw new ApiError("INVALID_STATE", 409);
  }
  const artifactIdentity = persistedReleaseArtifactIdentity(release);
  if (!artifactIdentity) throw new ApiError("INVALID_STATE", 409);
  const expectedTools = manifest.data.plans.map(({ tool }) => tool.name).sort(compareStrings);
  const target = await resolveReleaseTarget(repository, actor, projectId, release.analysisRunId, release);
  if (target.targetOrigin !== release.allowedOrigin) throw new ApiError("INVALID_STATE", 409);
  const inputHash = createHash("sha256").update(JSON.stringify({
    releaseId,
    pageUrl,
    selfHostedUrl: selfHostedUrl ?? null,
    artifactUrl: artifactIdentity.artifactUrl,
    downloadUrl: artifactIdentity.downloadUrl,
    localOnly: artifactIdentity.localOnly,
    contentHash: release.contentHash,
    integrity: release.sri,
  })).digest("hex");
  const port = releaseVerificationPort();
  const attestation = await attestReleaseInstallation({
    pageUrl,
    ...artifactIdentity,
    contentHash: release.contentHash,
    integrity: release.sri,
    manifest: manifest.data,
    targetOrigin: release.allowedOrigin,
    expectedTools,
    ...(selfHostedUrl ? { selfHostedUrl } : {}),
    ...(port.mode === "live" ? {
      liveContext: {
        projectId,
        releaseId,
        installationOperationId: deriveInstallationOperationId({ projectId, releaseId, idempotencyKey, inputHash }),
        sourceIdentityHash: target.sourceIdentityHash,
        environment: target.environment,
      },
    } : {}),
  }, port, signal);
  return repository.saveReleaseInstallation(actor, projectId, {
    releaseId,
    pageUrl,
    artifactUrl: artifactIdentity.artifactUrl,
    downloadUrl: artifactIdentity.downloadUrl,
    localOnly: artifactIdentity.localOnly,
    ...(selfHostedUrl ? { selfHostedUrl } : {}),
    targetOrigin: release.allowedOrigin,
    artifactContentHash: release.contentHash,
    integrity: release.sri,
    expectedTools,
    status: attestation.status,
    delivery: attestation.delivery,
    csp: attestation.csp,
    webMcpImplementation: attestation.webMcpImplementation,
    verifierIdentity: attestation.verifierIdentity,
    attestation: {
      ...attestation.report,
      ...(attestation.verifierAttestation ? { verifierAttestation: attestation.verifierAttestation } : {}),
    },
    idempotencyKey,
    inputHash,
  });
}

async function resolveReleaseTarget(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
  analysisRunId: string,
  candidate: CandidateRelease,
): Promise<Readonly<{
  targetOrigin: string;
  verificationPageUrl: string;
  sourceIdentityHash: string;
  environment: "test" | "staging" | "production";
}>> {
  const workflow = await repository.getWorkflowRun(actor, analysisRunId);
  const snapshots = await repository.listSourceSnapshots(actor, projectId);
  const snapshot = snapshots.find(({ id }) => id === workflow.sourceSnapshotId);
  const sources = await repository.listProjectSources(actor, projectId);
  const source = snapshot
    ? sources.find(({ id }) => id === snapshot.projectSourceId)
    : undefined;
  if (!snapshot || !source || workflow.projectId !== projectId
    || workflow.analysisRunId !== analysisRunId
    || snapshot.projectId !== projectId || source.projectId !== projectId
    || snapshot.organizationId !== actor.organizationId || source.organizationId !== actor.organizationId
    || source.sourceType !== source.sourceConfiguration.kind) {
    throw new ApiError("INVALID_STATE", 409);
  }
  if (source.sourceType === "openapi") {
    if (source.sourceConfiguration.kind !== "openapi") throw new ApiError("INVALID_STATE", 409);
    return {
      targetOrigin: source.sourceConfiguration.targetOrigin,
      verificationPageUrl: source.sourceConfiguration.testPageUrl,
      sourceIdentityHash: snapshot.sourceIdentityHash,
      environment: verifierEnvironmentForSource(source.sourceConfiguration),
    };
  }
  if (source.sourceType === "website") {
    try {
      const url = new URL(source.sourceUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        throw new Error("INVALID_SOURCE_URL");
      }
      return {
        targetOrigin: url.origin,
        verificationPageUrl: url.toString(),
        sourceIdentityHash: snapshot.sourceIdentityHash,
        environment: verifierEnvironmentForSource(source.sourceConfiguration),
      };
    } catch {
      throw new ApiError("INVALID_STATE", 409);
    }
  }
  const manifest = ManifestSchema.safeParse(candidate.manifest);
  const origin = safeOrigin(candidate.allowedOrigin);
  if (!manifest.success || !origin || origin !== candidate.allowedOrigin
    || manifest.data.targetOrigin !== origin) throw new ApiError("INVALID_STATE", 409);
  return {
    targetOrigin: origin,
    verificationPageUrl: `${origin}/`,
    sourceIdentityHash: snapshot.sourceIdentityHash,
    environment: verifierEnvironmentForSource(source.sourceConfiguration),
  };
}

async function deriveTrustedVerification(
  projectId: string,
  analysisRunId: string,
  target: Readonly<{
    targetOrigin: string;
    verificationPageUrl: string;
    sourceIdentityHash: string;
    environment: "test" | "staging" | "production";
  }>,
  result: AnalysisResult,
  capabilities: CapabilityRecord[],
  signal: AbortSignal,
): Promise<VerificationRequest> {
  const { targetOrigin } = target;
  const prepared = deriveVerification(analysisRunId, targetOrigin, result, capabilities);
  const manifest = ManifestSchema.safeParse(prepared.candidate.manifest);
  if (!manifest.success || safeOrigin(targetOrigin) !== targetOrigin) {
    throw new ApiError("RELEASE_GATE_FAILED", 409, false, ["CANDIDATE_INVALID"]);
  }
  const integrity = `sha384-${createHash("sha384").update(prepared.candidate.code).digest("base64")}`;
  const expectedTools = capabilities.filter(({ status }) => status !== "blocked")
    .map(({ stableName }) => stableName).sort(compareStrings);
  const port = releaseVerificationPort();
  const attestation = await attestReleaseCandidate({
    code: prepared.candidate.code,
    contentHash: prepared.candidate.contentHash,
    integrity,
    manifest: manifest.data,
    targetOrigin,
    expectedTools,
    ...(port.mode === "live" ? {
      liveContext: {
        projectId,
        analysisRunId,
        sourceIdentityHash: target.sourceIdentityHash,
        environment: target.environment,
      },
    } : {}),
  }, port, signal);
  return applyAttestation(prepared, attestation);
}

type PreparedVerification = Omit<VerificationRequest, "verifierIdentity" | "observation">;

function applyAttestation(prepared: PreparedVerification, attestation: CandidateAttestation): VerificationRequest {
  return {
    ...prepared,
    schema: prepared.schema && attestation.schema,
    authenticated: prepared.authenticated && attestation.authenticated,
    replayPasses: Math.min(prepared.replayPasses, attestation.replayPasses),
    noSecretLeakage: prepared.noSecretLeakage && attestation.noSecretLeakage,
    browserExecution: attestation.browserExecution,
    selectionScore: Math.min(prepared.selectionScore, attestation.selectionScore),
    checks: [...attestation.checks],
    csp: attestation.csp,
    verificationMode: attestation.verificationMode,
    verifierIdentity: attestation.verifierIdentity,
    observation: {
      observedContentHash: attestation.report.observedContentHash,
      observedIntegrity: attestation.report.observedIntegrity,
      observedReleaseId: attestation.report.observedReleaseId,
      observedTargetOrigin: attestation.report.observedTargetOrigin,
      registeredTools: [...attestation.report.registeredTools],
      trustedLoader: { ...attestation.report.trustedLoader },
      controlPlaneRequestsDuringExecution: attestation.report.controlPlaneRequestsDuringExecution,
      modelRequestsDuringExecution: attestation.report.modelRequestsDuringExecution,
      ...(attestation.verifierAttestation ? { verifierAttestation: attestation.verifierAttestation } : {}),
    },
  };
}

export function deriveVerification(
  analysisRunId: string,
  projectUrl: string,
  result: AnalysisResult,
  capabilities: CapabilityRecord[]
): PreparedVerification {
  if (result.release === undefined) throw new ApiError("INVALID_STATE", 409);
  const parsedSourceManifest = ManifestSchema.safeParse(result.release.manifest);
  const targetOrigin = safeOrigin(projectUrl);
  const selectedCapabilities = capabilities.filter((capability) => capability.status !== "blocked");
  const expectedNames = selectedCapabilities.map((capability) => capability.stableName).sort(compareStrings);
  const sourceExpectedNames = capabilities.map((capability) => capability.stableName).sort(compareStrings);
  const sourceManifestNames = parsedSourceManifest.success
    ? parsedSourceManifest.data.plans.map((plan) => plan.tool.name).sort(compareStrings)
    : [];
  const uniqueSourceNames = new Set(sourceManifestNames);
  let candidate: CandidateRelease = result.release;
  if (parsedSourceManifest.success
    && targetOrigin !== undefined
    && result.release.allowedOrigin === targetOrigin
    && parsedSourceManifest.data.targetOrigin === targetOrigin
    && uniqueSourceNames.size === sourceManifestNames.length
    && equalStrings(sourceExpectedNames, sourceManifestNames)
    && plansMatchCapabilities(parsedSourceManifest.data.plans, capabilities)) {
    try {
      const canonicalSource = compileManifest(parsedSourceManifest.data);
      if (canonicalSource.code === result.release.code
        && canonicalSource.contentHash === result.release.contentHash) {
        const selected = new Set(expectedNames);
        const plans = parsedSourceManifest.data.plans.filter((plan) => selected.has(plan.tool.name));
        const compiled = compileWebMcpRelease(plans);
        candidate = {
          code: compiled.code,
          contentHash: compiled.contentHash,
          allowedOrigin: compiled.allowedOrigin,
          manifest: compiled.manifest
        };
      }
    } catch {
      // Verification below fails closed against the original, non-canonical candidate.
    }
  }

  const parsedManifest = ManifestSchema.safeParse(candidate.manifest);
  const digest = createHash("sha256").update(candidate.code).digest("hex");
  const manifestNames = parsedManifest.success ? parsedManifest.data.plans.map((plan) => plan.tool.name).sort(compareStrings) : [];
  const uniqueManifestNames = new Set(manifestNames);
  const exactSelection = expectedNames.length > 0
    && uniqueManifestNames.size === manifestNames.length
    && equalStrings(expectedNames, manifestNames)
    && parsedManifest.success
    && plansMatchCapabilities(parsedManifest.data.plans, selectedCapabilities);
  const schema = parsedManifest.success
    && digest === candidate.contentHash
    && exactSelection;
  const authenticated = parsedManifest.success
    && targetOrigin !== undefined
    && candidate.allowedOrigin === targetOrigin
    && parsedManifest.data.targetOrigin === targetOrigin;

  let replayPasses = 0;
  if (parsedManifest.success && authenticated) {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const replay = compileManifest(parsedManifest.data);
        if (replay.code !== candidate.code || replay.contentHash !== digest) break;
        replayPasses += 1;
      }
    } catch {
      replayPasses = 0;
    }
  }

  const inspectedState = `${candidate.code}\n${JSON.stringify(result.evidence)}\n${JSON.stringify(result.draftPullRequest ?? {})}`;
  const noSecretLeakage = !/(?:fixture-password|paymentDetails|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:sk|phc)_[A-Za-z0-9_-]+|process\.env)/i.test(inspectedState);
  return {
    analysisRunId,
    capabilityStateDigest: capabilityStateDigest(capabilities),
    candidate,
    schema,
    authenticated,
    replayPasses,
    noSecretLeakage,
    browserExecution: false,
    selectionScore: exactSelection ? 20 : 0,
    checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({
      name,
      status: "failed" as const,
      code: name === "trusted_loader" ? "TRUSTED_LOADER_REQUIRED" as const : "INVALID_OUTPUT" as const,
    })),
    csp: { hosted: "blocked", directive: "trusted verification required" },
    verificationMode: "live",
  };
}

type ParsedManifest = z.infer<typeof ManifestSchema>;

function compileManifest(manifest: ParsedManifest) {
  return compileWebMcpRelease(manifest.plans);
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function plansMatchCapabilities(plans: CapabilityPlan[], capabilities: CapabilityRecord[]): boolean {
  if (plans.length !== capabilities.length) return false;
  const expected = capabilities.map((capability) => {
    if (capability.stableName !== capability.plan.tool.name
      || capability.riskTier !== capability.plan.effects.riskTier
      || capability.planDigest !== capabilityPlanDigest(capability.plan)) return undefined;
    return `${capability.stableName}:${capability.planDigest}`;
  }).sort(compareOptionalStrings);
  const actual = plans.map((plan) => `${plan.tool.name}:${capabilityPlanDigest(plan)}`).sort(compareStrings);
  return expected.every((value, index) => value !== undefined && value === actual[index]);
}

function assertCurrentEvidence(
  result: AnalysisResult,
  organizationId: string,
  projectId: string,
  analysisRunId: string,
): void {
  if (result.release === undefined) throw new ApiError("INVALID_STATE", 409);
  const manifest = ManifestSchema.safeParse(result.release.manifest);
  const referenced = manifest.success
    ? manifest.data.plans.flatMap((plan) => plan.evidence.map(({ source, reference }) => ({ source, reference })))
    : [];
  const current = new Map(result.evidence.map((item) => [item.reference, item]));
  const resolved = manifest.success && referenced.length > 0 && referenced.every(({ source, reference }) => {
    const evidence = current.get(reference);
    if (!evidence || evidence.source !== source || evidence.organizationId !== organizationId
      || evidence.projectId !== projectId || evidence.analysisRunId !== analysisRunId
      || evidence.expiresAt === undefined || new Date(evidence.expiresAt) <= new Date()) return false;
    const digest = createHash("sha256").update(evidence.content).digest("hex");
    return reference === `urn:sha256:${digest}`;
  });
  if (!resolved) {
    throw new ApiError("RELEASE_GATE_FAILED", 409, false, ["EVIDENCE_MISSING_OR_EXPIRED"]);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareStrings(left, right);
}
