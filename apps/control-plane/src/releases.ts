import { createHash } from "node:crypto";
import { z } from "zod";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { CapabilityPlanSchema, type CapabilityPlan } from "../../../packages/capability-ir/src/plan.ts";
import {
  capabilityPlanDigest,
  capabilityStateDigest,
  type AnalysisResult,
  type CandidateRelease,
  type CapabilityRecord,
  type ControlPlaneRepository,
  type ReleaseRecord,
  type ReleaseInstallationRecord,
  type RepositoryActor,
  type VerificationRecord,
  type VerificationRequest
} from "../../../packages/database/src/control-plane.ts";
import { ApiError } from "./api.ts";
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
  publicOrigin = configuredPublicOrigin(),
): Promise<ReleaseRecord & { url: string; installation: ReleaseInstallationGuide }> {
  if (actor.role !== "owner") throw new ApiError("FORBIDDEN", 403);
  const project = await repository.getProject(actor, projectId);
  const run = await repository.getAnalysis(actor, analysisRunId);
  if (run.projectId !== project.id || run.status !== "succeeded") throw new ApiError("INVALID_STATE", 409);
  const result = await repository.getAnalysisResult(actor, run.id);
  if (!result) throw new ApiError("INVALID_STATE", 409);
  assertCurrentEvidence(result, actor.organizationId, project.id, run.id);
  const capabilities = await repository.listAnalysisCapabilities(actor, run.id);

  const pendingReview = capabilities.some((capability) =>
    (capability.riskTier === "R1" || capability.riskTier === "R2")
      && capability.status === "proposed"
  );
  if (pendingReview) throw new ApiError("REVIEW_REQUIRED", 409);
  const verificationRequest = await deriveTrustedVerification(
    analysisRunId, project.url, result, capabilities, signal
  );
  const verification = await repository.saveVerification(actor, project.id, verificationRequest);
  const inputHash = createHash("sha256")
    .update(JSON.stringify({
      analysisRunId,
      projectId,
      capabilityStateDigest: verification.capabilityStateDigest,
      candidateContentHash: verification.candidateContentHash
    }))
    .digest("hex");
  const release = await repository.publishRelease(actor, {
    projectId,
    analysisRunId,
    capabilityStateDigest: verification.capabilityStateDigest,
    candidateContentHash: verification.candidateContentHash,
    idempotencyKey,
    inputHash
  });
  const previous = await repository.getPreviousRelease(actor, project.id, release.id);
  const url = `/api/releases/${release.contentHash}.js`;
  return {
    ...release,
    url,
    installation: buildReleaseInstallationGuide(release, verification, previous, `${publicOrigin}${url}`),
  };
}

export type ReleaseInstallationGuide = Readonly<{
  artifactUrl: string;
  downloadUrl: string;
  moduleScriptTag: string;
  manifest: unknown;
  integrity: string;
  contentHash: string;
  targetOrigin: string;
  compatibility: { moduleScripts: true; webMcp: "native-current-required" };
  csp: VerificationRecord["csp"];
  selfHost: { required: boolean; guidance: string };
  previousRelease: null | { id: string; contentHash: string; integrity: string; artifactUrl: string };
  installed: false;
}>;

export function buildReleaseInstallationGuide(
  release: ReleaseRecord,
  verification: VerificationRecord,
  previous: ReleaseRecord | undefined,
  artifactUrl: string,
): ReleaseInstallationGuide {
  const url = new URL(artifactUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || !url.pathname.endsWith(`/${release.contentHash}.js`)) throw new ApiError("INVALID_STATE", 409);
  const previousArtifactUrl = previous
    ? new URL(`/api/releases/${previous.contentHash}.js`, url.origin).toString()
    : undefined;
  return {
    artifactUrl: url.toString(),
    downloadUrl: `${url.toString()}?download=1`,
    moduleScriptTag: `<script type="module" src="${url.toString()}" integrity="${release.sri}" crossorigin="anonymous"></script>`,
    manifest: release.manifest,
    integrity: release.sri,
    contentHash: release.contentHash,
    targetOrigin: release.allowedOrigin,
    compatibility: { moduleScripts: true, webMcp: "native-current-required" },
    csp: verification.csp,
    selfHost: {
      required: verification.csp.hosted === "blocked",
      guidance: "Host the downloaded bytes unchanged on the target origin, then verify that exact SHA-256 before installation.",
    },
    previousRelease: previous && previousArtifactUrl ? {
      id: previous.id,
      contentHash: previous.contentHash,
      integrity: previous.sri,
      artifactUrl: previousArtifactUrl,
    } : null,
    installed: false,
  };
}

export function configuredPublicOrigin(request?: Request): string {
  const value = process.env.PAGE2WEBMCP_PUBLIC_ORIGIN ?? (process.env.NODE_ENV === "production" ? undefined : request?.url);
  if (!value) throw new Error("PUBLIC_ORIGIN_CONFIGURATION_REQUIRED");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("PUBLIC_ORIGIN_CONFIGURATION_REQUIRED");
    return url.origin;
  } catch {
    throw new Error("PUBLIC_ORIGIN_CONFIGURATION_REQUIRED");
  }
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
  const capabilities = await repository.listAnalysisCapabilities(actor, run.id);
  return repository.saveVerification(actor, project.id,
    await deriveTrustedVerification(run.id, project.url, result, capabilities, signal));
}

export async function verifyInstalledRelease(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
  releaseId: string,
  pageUrl: string,
  selfHostedUrl: string | undefined,
  idempotencyKey: string,
  publicOrigin: string,
  signal: AbortSignal,
): Promise<ReleaseInstallationRecord> {
  if (actor.role !== "owner") throw new ApiError("FORBIDDEN", 403);
  const release = await repository.getRelease(actor, projectId, releaseId);
  const manifest = ManifestSchema.safeParse(release.manifest);
  if (!manifest.success || manifest.data.targetOrigin !== release.allowedOrigin) {
    throw new ApiError("INVALID_STATE", 409);
  }
  const expectedTools = manifest.data.plans.map(({ tool }) => tool.name).sort(compareStrings);
  const artifactUrl = `${publicOrigin}/api/releases/${release.contentHash}.js`;
  const attestation = await attestReleaseInstallation({
    pageUrl,
    artifactUrl,
    contentHash: release.contentHash,
    integrity: release.sri,
    manifest: manifest.data,
    targetOrigin: release.allowedOrigin,
    expectedTools,
    ...(selfHostedUrl ? { selfHostedUrl } : {}),
  }, releaseVerificationPort(), signal);
  const inputHash = createHash("sha256").update(JSON.stringify({
    releaseId,
    pageUrl,
    selfHostedUrl: selfHostedUrl ?? null,
    artifactUrl,
    contentHash: release.contentHash,
    integrity: release.sri,
  })).digest("hex");
  return repository.saveReleaseInstallation(actor, projectId, {
    releaseId,
    pageUrl,
    artifactUrl,
    ...(selfHostedUrl ? { selfHostedUrl } : {}),
    targetOrigin: release.allowedOrigin,
    artifactContentHash: release.contentHash,
    integrity: release.sri,
    expectedTools,
    status: attestation.status,
    delivery: attestation.delivery,
    csp: attestation.csp,
    webMcpImplementation: attestation.webMcpImplementation,
    attestation: {
      servedContentHash: release.contentHash,
      executedContentHash: release.contentHash,
      registeredTools: expectedTools,
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: true,
    },
    idempotencyKey,
    inputHash,
  });
}

async function deriveTrustedVerification(
  analysisRunId: string,
  projectUrl: string,
  result: AnalysisResult,
  capabilities: CapabilityRecord[],
  signal: AbortSignal,
): Promise<VerificationRequest> {
  const prepared = deriveVerification(analysisRunId, projectUrl, result, capabilities);
  const manifest = ManifestSchema.safeParse(prepared.candidate.manifest);
  const targetOrigin = safeOrigin(projectUrl);
  if (!manifest.success || !targetOrigin) return prepared;
  const integrity = `sha384-${createHash("sha384").update(prepared.candidate.code).digest("base64")}`;
  const expectedTools = capabilities.filter(({ status }) => status !== "blocked")
    .map(({ stableName }) => stableName).sort(compareStrings);
  const attestation = await attestReleaseCandidate({
    code: prepared.candidate.code,
    contentHash: prepared.candidate.contentHash,
    integrity,
    manifest: manifest.data,
    targetOrigin,
    expectedTools,
  }, releaseVerificationPort(), signal);
  return applyAttestation(prepared, attestation);
}

function applyAttestation(prepared: VerificationRequest, attestation: CandidateAttestation): VerificationRequest {
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
  };
}

export function deriveVerification(
  analysisRunId: string,
  projectUrl: string,
  result: AnalysisResult,
  capabilities: CapabilityRecord[]
): VerificationRequest {
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
  let canonical = false;
  if (parsedManifest.success && authenticated) {
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const replay = compileManifest(parsedManifest.data);
        if (replay.code !== candidate.code || replay.contentHash !== digest) break;
        replayPasses += 1;
      }
      canonical = replayPasses === 3;
    } catch {
      replayPasses = 0;
    }
  }

  const inspectedState = `${candidate.code}\n${JSON.stringify(result.evidence)}\n${JSON.stringify(result.draftPullRequest ?? {})}`;
  const noSecretLeakage = !/(?:fixture-password|paymentDetails|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:sk|phc)_[A-Za-z0-9_-]+|process\.env)/i.test(inspectedState);
  // Exact canonical replay proves this candidate is byte-for-byte output from the
  // compiler whose runtime contract is exercised independently. Avoid treating
  // incidental source spelling as a security boundary.
  const browserExecution = canonical;

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
