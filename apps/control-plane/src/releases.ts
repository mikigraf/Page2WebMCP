import { createHash } from "node:crypto";
import { z } from "zod";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import {
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
  version: z.literal(2),
  allowedOrigin: z.string().url(),
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    readOnly: z.boolean(),
    untrustedContent: z.boolean().default(false),
    requiresConfirmation: z.boolean()
  }).strict()).max(100)
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
  assertCurrentEvidence(result);
  const capabilities = await repository.listAnalysisCapabilities(actor, run.id);

  const pendingReview = capabilities.some((capability) =>
    (capability.riskTier === "R1" || capability.riskTier === "R2")
      && capability.status === "proposed"
  );
  if (pendingReview) throw new ApiError("REVIEW_REQUIRED", 409);
  if (capabilities.some((capability) => capability.riskTier === "R3" && capability.status !== "blocked")) {
    throw new ApiError("HIGH_RISK_ACTION", 409);
  }

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
  assertCurrentEvidence(result);
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
  const expectedNames = capabilities
    .filter((capability) => capability.status !== "blocked")
    .map((capability) => capability.stableName)
    .sort();
  const sourceExpectedNames = capabilities
    .filter((capability) => capability.riskTier !== "R3")
    .map((capability) => capability.stableName)
    .sort();
  const sourceManifestNames = parsedSourceManifest.success
    ? parsedSourceManifest.data.tools.map((tool) => tool.name).sort()
    : [];
  const uniqueSourceNames = new Set(sourceManifestNames);
  let candidate: CandidateRelease = result.release;
  if (parsedSourceManifest.success
    && targetOrigin !== undefined
    && result.release.allowedOrigin === targetOrigin
    && parsedSourceManifest.data.allowedOrigin === targetOrigin
    && uniqueSourceNames.size === sourceManifestNames.length
    && equalStrings(sourceExpectedNames, sourceManifestNames)) {
    try {
      const canonicalSource = compileManifest(parsedSourceManifest.data);
      if (canonicalSource.code === result.release.code
        && canonicalSource.contentHash === result.release.contentHash) {
        const selected = new Set(expectedNames);
        const tools = parsedSourceManifest.data.tools.filter((tool) => selected.has(tool.name));
        const compiled = compileWebMcpRelease(tools.map(compilableTool), targetOrigin);
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
  const manifestNames = parsedManifest.success ? parsedManifest.data.tools.map((tool) => tool.name).sort() : [];
  const uniqueManifestNames = new Set(manifestNames);
  const exactSelection = expectedNames.length > 0
    && uniqueManifestNames.size === manifestNames.length
    && equalStrings(expectedNames, manifestNames);
  const schema = parsedManifest.success
    && digest === candidate.contentHash
    && exactSelection;
  const authenticated = parsedManifest.success
    && targetOrigin !== undefined
    && candidate.allowedOrigin === targetOrigin
    && parsedManifest.data.allowedOrigin === targetOrigin;

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
  const browserExecution = canonical
    && candidate.code.includes("document.modelContext.registerTool")
    && candidate.code.includes("registerPage2WebMCPTools")
    && candidate.code.includes("credentials: \"same-origin\"");

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

function compilableTool(tool: ParsedManifest["tools"][number]) {
  return {
    name: tool.name,
    description: tool.name.replaceAll("_", " "),
    readOnly: tool.readOnly,
    untrustedContent: tool.untrustedContent,
    requiresConfirmation: tool.requiresConfirmation
  };
}

function compileManifest(manifest: ParsedManifest) {
  return compileWebMcpRelease(manifest.tools.map(compilableTool), manifest.allowedOrigin);
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

function assertCurrentEvidence(result: AnalysisResult): void {
  // Persistence omits expired evidence, so an empty exact-run set is never
  // sufficient to create or reuse a release verification.
  if (result.evidence.length === 0) {
    throw new ApiError("RELEASE_GATE_FAILED", 409, false, ["EVIDENCE_MISSING_OR_EXPIRED"]);
  }
}
