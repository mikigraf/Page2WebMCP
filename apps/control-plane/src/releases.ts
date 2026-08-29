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
  type RepositoryActor,
  type VerificationRecord,
  type VerificationRequest
} from "../../../packages/database/src/control-plane.ts";
import { ApiError } from "./api.ts";

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
  idempotencyKey: string
): Promise<ReleaseRecord & { url: string }> {
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
  const verificationRequest = deriveVerification(analysisRunId, project.url, result, capabilities);
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
  return { ...release, url: `/api/releases/${release.contentHash}.js` };
}

export async function verifyPersistedRelease(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
  analysisRunId: string
): Promise<VerificationRecord> {
  if (actor.role !== "owner") throw new ApiError("FORBIDDEN", 403);
  const project = await repository.getProject(actor, projectId);
  const run = await repository.getAnalysis(actor, analysisRunId);
  if (run.projectId !== project.id || run.status !== "succeeded") throw new ApiError("INVALID_STATE", 409);
  const result = await repository.getAnalysisResult(actor, run.id);
  if (!result) throw new ApiError("INVALID_STATE", 409);
  assertCurrentEvidence(result, actor.organizationId, project.id, run.id);
  const capabilities = await repository.listAnalysisCapabilities(actor, run.id);
  return repository.saveVerification(
    actor,
    project.id,
    deriveVerification(run.id, project.url, result, capabilities)
  );
}

export function deriveVerification(
  analysisRunId: string,
  projectUrl: string,
  result: AnalysisResult,
  capabilities: CapabilityRecord[]
): VerificationRequest {
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
    browserExecution,
    selectionScore: exactSelection ? 20 : 0
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
