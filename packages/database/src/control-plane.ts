import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../capability-ir/src/plan.ts";

export type RepositoryRole = "owner" | "editor" | "viewer";
export type RepositoryActor = { id: string; organizationId: string; role: RepositoryRole };
export type SourceType = "website" | "openapi" | "github";

export type ProjectRecord = {
  id: string;
  organizationId: string;
  createdBy: string;
  name: string;
  sourceType: SourceType;
  url: string;
  status: "created" | "analyzing" | "analyzed" | "failed";
  createdAt: string;
};

export type AnalysisRunRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  requestedBy: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedAnalysisRunRecord = Readonly<AnalysisRunRecord & {
  sourceType: SourceType;
  sourceUrl: string;
}>;

export type CapabilityRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  analysisRunId: string;
  stableName: string;
  riskTier: "R0" | "R1" | "R2";
  status: "proposed" | "reviewed" | "verified" | "blocked";
  plan: CapabilityPlan;
  planDigest: string;
  reviewedPlanDigest?: string;
  version: number;
};

export type AnalysisEvidence = {
  id?: string;
  organizationId?: string;
  projectId?: string;
  analysisRunId?: string;
  source: "openapi" | "github" | "runtime" | "owner_review" | "source";
  content: string;
  reference: string;
  expiresAt?: string;
};

export type CandidateRelease = {
  code: string;
  contentHash: string;
  allowedOrigin: string;
  manifest?: unknown;
};

export type AnalysisDiagnostic = Readonly<{
  code: string;
  operationKey: string;
  reason?: string;
}>;

export type AnalysisResult = {
  capabilities: Array<{ plan: CapabilityPlan; status: Pick<CapabilityRecord, "status">["status"] }>;
  diagnostics: AnalysisDiagnostic[];
  evidence: AnalysisEvidence[];
  release: CandidateRelease;
  draftPullRequest?: { draft: boolean; url?: string; files?: string[] };
};

export type VerificationRecord = {
  id: string;
  projectId: string;
  analysisRunId: string;
  capabilityStateDigest: string;
  candidateContentHash: string;
  schema: boolean;
  authenticated: boolean;
  replayPasses: number;
  noSecretLeakage: boolean;
  browserExecution: boolean;
  selectionScore: number;
  eligible: boolean;
  failures: string[];
  createdAt: string;
};

export type ReleaseRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  analysisRunId: string;
  capabilityStateDigest: string;
  contentHash: string;
  sri: string;
  code: string;
  allowedOrigin: string;
  manifest?: unknown;
  status: "published";
  createdAt: string;
};

export type AuditEventRecord = {
  id: string;
  organizationId: string;
  actorId: string;
  action: string;
  targetId: string;
  createdAt: string;
};

export type ReviewInput = { action: "approve" | "block" | "reject"; expectedVersion: number };
export type IdempotencyInput = { idempotencyKey: string; inputHash: string };
export type CreateProjectRequest = {
  name: string;
  sourceType: SourceType;
  url: string;
} & IdempotencyInput;
export type IdempotentRequest = { projectId: string } & IdempotencyInput;
export type VerificationRequest = Omit<
  VerificationRecord,
  "id" | "projectId" | "candidateContentHash" | "eligible" | "failures" | "createdAt"
> & { candidate: CandidateRelease };
export type PublishRequest = IdempotentRequest & {
  analysisRunId: string;
  capabilityStateDigest: string;
  candidateContentHash: string;
};

export type RepositoryErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "OWNER_APPROVAL_REQUIRED"
  | "HIGH_RISK_ACTION"
  | "RELEASE_GATE_FAILED"
  | "INVALID_STATE"
  | "LEASE_LOST";

export class RepositoryError extends Error {
  constructor(readonly code: RepositoryErrorCode, readonly details?: string[]) {
    super(code);
    this.name = "RepositoryError";
  }
}

export interface ControlPlaneRepository {
  createProject(actor: RepositoryActor, input: CreateProjectRequest): Promise<ProjectRecord>;
  listProjects(actor: RepositoryActor): Promise<ProjectRecord[]>;
  getProject(actor: RepositoryActor, id: string): Promise<ProjectRecord>;
  enqueueAnalysis(actor: RepositoryActor, input: IdempotentRequest): Promise<AnalysisRunRecord>;
  getAnalysis(actor: RepositoryActor, id: string): Promise<AnalysisRunRecord>;
  claimAnalysis(workerId: string, leaseMs: number): Promise<ClaimedAnalysisRunRecord | undefined>;
  heartbeatAnalysis(workerId: string, runId: string, leaseMs: number): Promise<void>;
  completeAnalysis(workerId: string, runId: string, result: AnalysisResult): Promise<AnalysisRunRecord>;
  failAnalysis(workerId: string, runId: string, code: string, retryable: boolean): Promise<AnalysisRunRecord>;
  getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined>;
  listCapabilities(actor: RepositoryActor, projectId: string): Promise<CapabilityRecord[]>;
  listAnalysisCapabilities(actor: RepositoryActor, runId: string): Promise<CapabilityRecord[]>;
  reviewCapability(actor: RepositoryActor, capabilityId: string, input: ReviewInput): Promise<CapabilityRecord>;
  saveVerification(actor: RepositoryActor, projectId: string, input: VerificationRequest): Promise<VerificationRecord>;
  publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord>;
  getReleaseArtifact(contentHash: string): Promise<ReleaseRecord>;
  listAuditEvents(actor: RepositoryActor): Promise<AuditEventRecord[]>;
  reset(): Promise<void>;
}

type IdempotencyRecord = { inputHash: string; resultId: string; expiresAt: string };

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PROJECTS = 500;
const MAX_CAPABILITIES = 1_000;
const MAX_AUDIT_EVENTS = 1_000;
const MAX_RELEASE_BYTES = 64 * 1_024;
const MAX_ANALYSIS_DIAGNOSTICS = 1_000;
const MAX_ANALYSIS_DIAGNOSTIC_BYTES = 64 * 1_024;

export function normalizeAnalysisDiagnostics(diagnostics: readonly AnalysisDiagnostic[]): AnalysisDiagnostic[] {
  if (!Array.isArray(diagnostics) || diagnostics.length > MAX_ANALYSIS_DIAGNOSTICS) {
    throw new RepositoryError("INVALID_STATE");
  }
  const allowedKeys = new Set(["code", "operationKey", "reason"]);
  const normalized = diagnostics.map((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object"
      || Object.keys(diagnostic).some((key) => !allowedKeys.has(key))
      || typeof diagnostic.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(diagnostic.code)
      || typeof diagnostic.operationKey !== "string" || diagnostic.operationKey.length === 0
      || diagnostic.operationKey.length > 2_048 || /[\u0000-\u001f\u007f]/.test(diagnostic.operationKey)
      || diagnostic.reason !== undefined && (typeof diagnostic.reason !== "string"
        || !/^[a-z][a-z0-9_]{0,63}$/.test(diagnostic.reason))) {
      throw new RepositoryError("INVALID_STATE");
    }
    return diagnostic.reason === undefined
      ? { code: diagnostic.code, operationKey: diagnostic.operationKey }
      : { code: diagnostic.code, operationKey: diagnostic.operationKey, reason: diagnostic.reason };
  }).sort((left, right) => compareCodePoints(left.operationKey, right.operationKey)
    || compareCodePoints(left.code, right.code)
    || compareCodePoints(left.reason ?? "", right.reason ?? ""));
  if (new Set(normalized.map((diagnostic) => JSON.stringify(diagnostic))).size !== normalized.length
    || Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_ANALYSIS_DIAGNOSTIC_BYTES) {
    throw new RepositoryError("INVALID_STATE");
  }
  return normalized;
}

export function capabilityStateDigest(
  capabilities: ReadonlyArray<Pick<CapabilityRecord,
    "id" | "analysisRunId" | "stableName" | "riskTier" | "status" | "planDigest" | "reviewedPlanDigest" | "version">>
): string {
  const canonical = capabilities
    .map((capability) => ({
      id: capability.id,
      analysisRunId: capability.analysisRunId,
      stableName: capability.stableName,
      riskTier: capability.riskTier,
      status: capability.status,
      planDigest: capability.planDigest,
      reviewedPlanDigest: capability.reviewedPlanDigest,
      version: capability.version
    }))
    .sort((left, right) => compareCodePoints(left.stableName, right.stableName) || compareCodePoints(left.id, right.id));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function capabilityPlanDigest(plan: CapabilityPlan): string {
  const canonical = canonicalizeCapabilityPlans([plan])[0]!;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function releaseFailures(input: VerificationRequest): string[] {
  return [
    !input.schema && "SCHEMA",
    !input.authenticated && "AUTH",
    input.replayPasses < 3 && "REPLAY",
    !input.noSecretLeakage && "SECRET_LEAKAGE",
    !input.browserExecution && "BROWSER",
    input.selectionScore < 18 && "TOOL_SELECTION"
  ].filter(Boolean) as string[];
}

export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  readonly #projects = new Map<string, ProjectRecord>();
  readonly #runs = new Map<string, AnalysisRunRecord>();
  readonly #results = new Map<string, AnalysisResult>();
  readonly #capabilities = new Map<string, CapabilityRecord>();
  readonly #verifications = new Map<string, VerificationRecord>();
  readonly #verificationCandidates = new Map<string, CandidateRelease>();
  readonly #releases = new Map<string, ReleaseRecord>();
  readonly #releaseByHash = new Map<string, string[]>();
  readonly #releaseByRun = new Map<string, string>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #analysisAvailableAt = new Map<string, string>();
  readonly #analysisSources = new Map<string, Readonly<{ sourceType: SourceType; sourceUrl: string }>>();
  readonly #audit: AuditEventRecord[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  #now(): string {
    return this.clock().toISOString();
  }

  #assertProject(actor: RepositoryActor, id: string): ProjectRecord {
    const project = this.#projects.get(id);
    if (!project || project.organizationId !== actor.organizationId) throw new RepositoryError("NOT_FOUND");
    return project;
  }

  #auditEvent(actor: RepositoryActor, action: string, targetId: string): void {
    this.#audit.push({
      id: randomUUID(),
      organizationId: actor.organizationId,
      actorId: actor.id,
      action,
      targetId,
      createdAt: this.#now()
    });
  }

  #idempotencyId(operation: "project" | "analysis" | "release", actor: RepositoryActor, key: string): string {
    return `${operation}:${actor.organizationId}:${actor.id}:${key}`;
  }

  #idempotentReplay(id: string, inputHash: string): IdempotencyRecord | undefined {
    const previous = this.#idempotency.get(id);
    if (!previous) return undefined;
    if (new Date(previous.expiresAt) <= this.clock()) {
      this.#idempotency.delete(id);
      return undefined;
    }
    if (previous.inputHash !== inputHash) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
    return previous;
  }

  #reserveIdempotency(id: string, inputHash: string, resultId: string): void {
    this.#idempotency.set(id, {
      inputHash,
      resultId,
      expiresAt: new Date(this.clock().getTime() + IDEMPOTENCY_TTL_MS).toISOString()
    });
  }

  async createProject(actor: RepositoryActor, input: CreateProjectRequest): Promise<ProjectRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const idempotencyId = this.#idempotencyId("project", actor, input.idempotencyKey);
    const previous = this.#idempotentReplay(idempotencyId, input.inputHash);
    if (previous) {
      const project = this.#projects.get(previous.resultId);
      if (!project || project.organizationId !== actor.organizationId) throw new RepositoryError("INVALID_STATE");
      return copy(project);
    }
    const project: ProjectRecord = {
      id: randomUUID(),
      organizationId: actor.organizationId,
      createdBy: actor.id,
      name: input.name,
      sourceType: input.sourceType,
      url: input.url,
      status: "created",
      createdAt: this.#now()
    };
    this.#projects.set(project.id, project);
    this.#reserveIdempotency(idempotencyId, input.inputHash, project.id);
    this.#auditEvent(actor, "project.created", project.id);
    return copy(project);
  }

  async listProjects(actor: RepositoryActor): Promise<ProjectRecord[]> {
    return [...this.#projects.values()]
      .filter((project) => project.organizationId === actor.organizationId)
      .sort((left, right) => compareCodePoints(left.createdAt, right.createdAt) || compareCodePoints(left.id, right.id))
      .slice(0, MAX_PROJECTS)
      .map(copy);
  }

  async getProject(actor: RepositoryActor, id: string): Promise<ProjectRecord> {
    return copy(this.#assertProject(actor, id));
  }

  async enqueueAnalysis(actor: RepositoryActor, input: IdempotentRequest): Promise<AnalysisRunRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const project = this.#assertProject(actor, input.projectId);
    const idempotencyId = this.#idempotencyId("analysis", actor, input.idempotencyKey);
    const previous = this.#idempotentReplay(idempotencyId, input.inputHash);
    if (previous) {
      const run = this.#runs.get(previous.resultId);
      if (!run || run.organizationId !== actor.organizationId || run.projectId !== project.id) {
        throw new RepositoryError("INVALID_STATE");
      }
      return copy(run);
    }
    if ([...this.#runs.values()].some((run) => run.projectId === project.id && (run.status === "queued" || run.status === "running"))) {
      throw new RepositoryError("INVALID_STATE");
    }
    const now = this.#now();
    const run: AnalysisRunRecord = {
      id: randomUUID(),
      organizationId: actor.organizationId,
      projectId: project.id,
      requestedBy: actor.id,
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    this.#runs.set(run.id, run);
    this.#analysisAvailableAt.set(run.id, now);
    this.#analysisSources.set(run.id, { sourceType: project.sourceType, sourceUrl: project.url });
    this.#projects.set(project.id, { ...project, status: "analyzing" });
    this.#reserveIdempotency(idempotencyId, input.inputHash, run.id);
    this.#auditEvent(actor, "analysis.queued", run.id);
    return copy(run);
  }

  async getAnalysis(actor: RepositoryActor, id: string): Promise<AnalysisRunRecord> {
    const run = this.#runs.get(id);
    if (!run || run.organizationId !== actor.organizationId) throw new RepositoryError("NOT_FOUND");
    return copy(run);
  }

  async claimAnalysis(workerId: string, leaseMs: number): Promise<ClaimedAnalysisRunRecord | undefined> {
    const now = this.clock();
    const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
    const candidates = [...this.#runs.values()].sort((left, right) => compareCodePoints(left.createdAt, right.createdAt));
    for (const run of candidates) {
      const expired = run.status === "running" && run.leaseExpiresAt !== undefined && new Date(run.leaseExpiresAt) <= now;
      if (run.status !== "queued" && !expired) continue;
      if (run.status === "queued" && new Date(this.#analysisAvailableAt.get(run.id) ?? run.createdAt) > now) continue;
      if (run.attempts >= 3) {
        this.#runs.set(run.id, { ...run, status: "failed", errorCode: "ATTEMPTS_EXHAUSTED", updatedAt: now.toISOString() });
        const project = this.#projects.get(run.projectId);
        if (project) this.#projects.set(project.id, { ...project, status: "failed" });
        this.#analysisAvailableAt.delete(run.id);
        continue;
      }
      const claimed: AnalysisRunRecord = {
        ...run,
        status: "running",
        attempts: run.attempts + 1,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + boundedLease).toISOString(),
        updatedAt: now.toISOString()
      };
      this.#runs.set(run.id, claimed);
      const source = this.#analysisSources.get(run.id);
      if (!source) throw new RepositoryError("INVALID_STATE");
      return copy({ ...claimed, ...source });
    }
    return undefined;
  }

  async heartbeatAnalysis(workerId: string, runId: string, leaseMs: number): Promise<void> {
    const run = this.#runs.get(runId);
    const now = this.clock();
    if (!run || run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= now) throw new RepositoryError("LEASE_LOST");
    const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
    this.#runs.set(run.id, {
      ...run,
      leaseExpiresAt: new Date(now.getTime() + boundedLease).toISOString(),
      updatedAt: now.toISOString()
    });
  }

  async completeAnalysis(workerId: string, runId: string, result: AnalysisResult): Promise<AnalysisRunRecord> {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= this.clock()) throw new RepositoryError("LEASE_LOST");
    if (result.capabilities.length > MAX_CAPABILITIES || result.evidence.length > MAX_CAPABILITIES
      || Buffer.byteLength(result.release.code) > MAX_RELEASE_BYTES) {
      throw new RepositoryError("INVALID_STATE");
    }
    let canonicalPlans: readonly CapabilityPlan[];
    try {
      canonicalPlans = canonicalizeCapabilityPlans(result.capabilities.map(({ plan }) => plan));
    } catch {
      throw new RepositoryError("INVALID_STATE");
    }
    const sourcePlans = plansFromManifest(result.release.manifest);
    if (!sourcePlans || !equalPlanSets(sourcePlans, canonicalPlans)) throw new RepositoryError("INVALID_STATE");
    const normalizedDiagnostics = normalizeAnalysisDiagnostics(result.diagnostics);
    const statuses = new Map(result.capabilities.map(({ plan, status }) => [plan.tool.name, status]));
    const expiresAt = new Date(this.clock().getTime() + IDEMPOTENCY_TTL_MS).toISOString();
    const normalizedEvidence = result.evidence.map((item) => normalizeEvidence(
      item,
      run,
      expiresAt,
      this.clock(),
    ));
    if (new Set(normalizedEvidence.map(({ reference }) => reference)).size !== normalizedEvidence.length
      || normalizedEvidence.reduce((total, item) => total + Buffer.byteLength(item.content), 0) > MAX_RELEASE_BYTES) {
      throw new RepositoryError("INVALID_STATE");
    }
    if (!evidenceResolves(normalizedEvidence, canonicalPlans, run, this.clock())) {
      throw new RepositoryError("INVALID_STATE");
    }
    const releaseCode = Buffer.from(result.release.code);
    const normalizedResult: AnalysisResult = {
      ...structuredClone(result),
      capabilities: canonicalPlans.map((plan) => ({ plan, status: statuses.get(plan.tool.name) ?? "proposed" })),
      diagnostics: normalizedDiagnostics,
      evidence: normalizedEvidence,
      release: {
        ...structuredClone(result.release),
        contentHash: createHash("sha256").update(releaseCode).digest("hex"),
        manifest: structuredClone(result.release.manifest ?? {})
      }
    };
    this.#results.set(run.id, normalizedResult);
    for (const plan of canonicalPlans) {
      const planDigest = capabilityPlanDigest(plan);
      const status = statuses.get(plan.tool.name) ?? "proposed";
      const capability: CapabilityRecord = {
        id: randomUUID(),
        organizationId: run.organizationId,
        projectId: run.projectId,
        analysisRunId: run.id,
        stableName: plan.tool.name,
        riskTier: plan.effects.riskTier as CapabilityRecord["riskTier"],
        status,
        plan,
        planDigest,
        reviewedPlanDigest: plan.effects.riskTier === "R0" || status === "blocked" ? planDigest : undefined,
        version: 1
      };
      this.#capabilities.set(capability.id, capability);
    }
    const now = this.#now();
    const completed: AnalysisRunRecord = {
      ...run,
      status: "succeeded",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      updatedAt: now
    };
    this.#runs.set(run.id, completed);
    this.#analysisAvailableAt.delete(run.id);
    const project = this.#projects.get(run.projectId);
    if (project) this.#projects.set(project.id, { ...project, status: "analyzed" });
    return copy(completed);
  }

  async failAnalysis(workerId: string, runId: string, code: string, retryable: boolean): Promise<AnalysisRunRecord> {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= this.clock()) throw new RepositoryError("LEASE_LOST");
    const terminal = !retryable || run.attempts >= 3;
    const failed: AnalysisRunRecord = {
      ...run,
      status: terminal ? "failed" : "queued",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: code.slice(0, 128),
      updatedAt: this.#now()
    };
    this.#runs.set(run.id, failed);
    if (terminal) this.#analysisAvailableAt.delete(run.id);
    else this.#analysisAvailableAt.set(run.id, new Date(this.clock().getTime() + 1_000).toISOString());
    if (terminal) {
      const project = this.#projects.get(run.projectId);
      if (project) this.#projects.set(project.id, { ...project, status: "failed" });
    }
    return copy(failed);
  }

  async getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined> {
    await this.getAnalysis(actor, runId);
    const result = this.#results.get(runId);
    if (!result) return undefined;
    return {
      ...structuredClone(result),
      capabilities: this.#analysisCapabilities(runId).map(({ plan, status }) => ({ plan, status })),
      evidence: result.evidence.filter(({ expiresAt }) => expiresAt !== undefined && new Date(expiresAt) > this.clock())
    };
  }

  async listCapabilities(actor: RepositoryActor, projectId: string): Promise<CapabilityRecord[]> {
    this.#assertProject(actor, projectId);
    return [...this.#capabilities.values()]
      .filter((item) => item.projectId === projectId)
      .sort((left, right) => compareCodePoints(left.stableName, right.stableName) || compareCodePoints(left.id, right.id))
      .slice(0, MAX_CAPABILITIES)
      .map(copy);
  }

  async listAnalysisCapabilities(actor: RepositoryActor, runId: string): Promise<CapabilityRecord[]> {
    const run = await this.getAnalysis(actor, runId);
    return this.#analysisCapabilities(run.id);
  }

  #analysisCapabilities(runId: string): CapabilityRecord[] {
    return [...this.#capabilities.values()]
      .filter((item) => item.analysisRunId === runId)
      .sort((left, right) => compareCodePoints(left.stableName, right.stableName) || compareCodePoints(left.id, right.id))
      .slice(0, MAX_CAPABILITIES)
      .map(copy);
  }

  async reviewCapability(actor: RepositoryActor, capabilityId: string, input: ReviewInput): Promise<CapabilityRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const capability = this.#capabilities.get(capabilityId);
    if (!capability || capability.organizationId !== actor.organizationId) throw new RepositoryError("NOT_FOUND");
    if (capability.version !== input.expectedVersion) throw new RepositoryError("VERSION_CONFLICT");
    if (input.action === "approve" && capability.riskTier !== "R0" && actor.role !== "owner") {
      throw new RepositoryError("OWNER_APPROVAL_REQUIRED");
    }
    if (input.action === "approve") {
      const run = this.#runs.get(capability.analysisRunId);
      const result = this.#results.get(capability.analysisRunId);
      if (!run || !result || !capabilityPlanBindingValid(capability)) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
      }
      if (!evidenceResolves(result.evidence, [capability.plan], run, this.clock())) {
        throw new RepositoryError("RELEASE_GATE_FAILED", ["EVIDENCE_MISSING_OR_EXPIRED"]);
      }
    }
    const updated: CapabilityRecord = {
      ...capability,
      status: input.action === "approve" ? "reviewed" : "blocked",
      reviewedPlanDigest: capability.planDigest,
      version: capability.version + 1
    };
    this.#capabilities.set(updated.id, updated);
    this.#auditEvent(actor, `capability.${input.action}`, updated.id);
    return copy(updated);
  }

  async saveVerification(
    actor: RepositoryActor,
    projectId: string,
    input: VerificationRequest
  ): Promise<VerificationRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    this.#assertProject(actor, projectId);
    const run = this.#runs.get(input.analysisRunId);
    if (!run || run.organizationId !== actor.organizationId) throw new RepositoryError("NOT_FOUND");
    if (run.projectId !== projectId || run.status !== "succeeded") throw new RepositoryError("INVALID_STATE");
    const currentCapabilities = this.#analysisCapabilities(run.id);
    if (currentCapabilities.some((capability) => !capabilityPlanBindingValid(capability))) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
    }
    const currentDigest = capabilityStateDigest(currentCapabilities);
    if (currentDigest !== input.capabilityStateDigest) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITIES_CHANGED"]);
    }
    const candidateBytes = Buffer.from(input.candidate.code);
    const candidateContentHash = createHash("sha256").update(candidateBytes).digest("hex");
    const candidateManifest = canonicalJson(input.candidate.manifest ?? {});
    if (candidateBytes.byteLength > MAX_RELEASE_BYTES || candidateContentHash !== input.candidate.contentHash
      || candidateManifest === "__INVALID_JSON__" || Buffer.byteLength(candidateManifest) > MAX_RELEASE_BYTES) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_HASH_MISMATCH"]);
    }
    const existingResult = this.#results.get(run.id);
    if (!existingResult) throw new RepositoryError("INVALID_STATE");
    const candidatePlans = plansFromManifest(input.candidate.manifest);
    const selectedPlans = currentCapabilities
      .filter(({ status }) => status !== "blocked")
      .map(({ plan }) => plan);
    if (!candidatePlans || !equalPlanSets(candidatePlans, selectedPlans)) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
    }
    if (!evidenceResolves(existingResult.evidence, candidatePlans, run, this.clock())) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["EVIDENCE_MISSING_OR_EXPIRED"]);
    }
    const publishedReleaseId = this.#releaseByRun.get(run.id);
    if (publishedReleaseId) {
      const publishedRelease = this.#releases.get(publishedReleaseId);
      const verification = this.#verifications.get(run.id);
      const verifiedCandidate = this.#verificationCandidates.get(run.id);
      if (publishedRelease
        && verification?.eligible
        && verifiedCandidate
        && verification.projectId === projectId
        && verification.capabilityStateDigest === input.capabilityStateDigest
        && verification.candidateContentHash === candidateContentHash
        && candidateMatches(input.candidate, publishedRelease)
        && candidateMatches(input.candidate, verifiedCandidate)) {
        return copy(verification);
      }
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
    }
    const failures = releaseFailures(input);
    const { candidate, ...checks } = input;
    const record: VerificationRecord = {
      id: randomUUID(),
      projectId,
      ...checks,
      candidateContentHash,
      failures,
      eligible: failures.length === 0,
      createdAt: this.#now()
    };
    this.#verificationCandidates.set(run.id, {
      ...structuredClone(candidate),
      contentHash: candidateContentHash,
      manifest: structuredClone(candidate.manifest ?? {})
    });
    this.#verifications.set(input.analysisRunId, record);
    return copy(record);
  }

  async publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    this.#assertProject(actor, input.projectId);
    const idempotencyId = this.#idempotencyId("release", actor, input.idempotencyKey);
    const previous = this.#idempotentReplay(idempotencyId, input.inputHash);
    if (previous) {
      const release = this.#releases.get(previous.resultId);
      if (!release || release.organizationId !== actor.organizationId || release.projectId !== input.projectId
        || release.analysisRunId !== input.analysisRunId
        || release.contentHash !== input.candidateContentHash) throw new RepositoryError("INVALID_STATE");
      return copy(release);
    }
    const run = this.#runs.get(input.analysisRunId);
    if (!run || run.organizationId !== actor.organizationId || run.projectId !== input.projectId || run.status !== "succeeded") {
      throw new RepositoryError("INVALID_STATE");
    }
    const verification = this.#verifications.get(input.analysisRunId);
    if (verification?.projectId !== input.projectId || !verification.eligible
      || verification.capabilityStateDigest !== input.capabilityStateDigest) {
      throw new RepositoryError("RELEASE_GATE_FAILED", verification?.failures ?? ["VERIFICATION_MISSING"]);
    }
    if (verification.candidateContentHash !== input.candidateContentHash) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
    }
    const currentCapabilities = this.#analysisCapabilities(run.id);
    if (currentCapabilities.some((capability) => !capabilityPlanBindingValid(capability))) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
    }
    const currentDigest = capabilityStateDigest(currentCapabilities);
    if (currentDigest !== input.capabilityStateDigest) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITIES_CHANGED"]);
    }
    const reviewFailures = currentCapabilities.flatMap((capability) => {
      if ((capability.riskTier === "R1" || capability.riskTier === "R2")
        && capability.status !== "blocked"
        && (capability.status !== "reviewed" || capability.reviewedPlanDigest !== capability.planDigest)) {
        return ["REVIEW_REQUIRED"];
      }
      if (capability.status !== "blocked" && capability.reviewedPlanDigest !== capability.planDigest) {
        return ["CAPABILITY_PLAN_MISMATCH"];
      }
      return [];
    });
    if (reviewFailures.length > 0) throw new RepositoryError("RELEASE_GATE_FAILED", [...new Set(reviewFailures)]);
    const result = this.#results.get(verification.analysisRunId);
    const candidate = this.#verificationCandidates.get(verification.analysisRunId);
    if (!result || !candidate) throw new RepositoryError("INVALID_STATE");
    const candidatePlans = plansFromManifest(candidate.manifest);
    if (!candidatePlans
      || !equalPlanSets(candidatePlans, currentCapabilities.filter(({ status }) => status !== "blocked").map(({ plan }) => plan))) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CAPABILITY_PLAN_MISMATCH"]);
    }
    if (!evidenceResolves(result.evidence, candidatePlans, run, this.clock())) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["EVIDENCE_MISSING_OR_EXPIRED"]);
    }
    const codeBytes = Buffer.from(candidate.code);
    const contentHash = createHash("sha256").update(codeBytes).digest("hex");
    if (contentHash !== input.candidateContentHash || candidate.contentHash !== input.candidateContentHash) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
    }
    const existingRunReleaseId = this.#releaseByRun.get(input.analysisRunId);
    if (existingRunReleaseId) {
      const existing = this.#releases.get(existingRunReleaseId);
      if (!existing) throw new RepositoryError("INVALID_STATE");
      this.#reserveIdempotency(idempotencyId, input.inputHash, existing.id);
      return copy(existing);
    }
    const release: ReleaseRecord = {
      id: randomUUID(),
      organizationId: actor.organizationId,
      projectId: input.projectId,
      analysisRunId: verification.analysisRunId,
      capabilityStateDigest: input.capabilityStateDigest,
      contentHash,
      sri: `sha384-${createHash("sha384").update(codeBytes).digest("base64")}`,
      code: candidate.code,
      allowedOrigin: candidate.allowedOrigin,
      manifest: candidate.manifest,
      status: "published",
      createdAt: this.#now()
    };
    this.#releases.set(release.id, release);
    this.#releaseByRun.set(input.analysisRunId, release.id);
    this.#releaseByHash.set(contentHash, [...(this.#releaseByHash.get(contentHash) ?? []), release.id]);
    this.#reserveIdempotency(idempotencyId, input.inputHash, release.id);
    this.#auditEvent(actor, "release.published", release.id);
    return copy(release);
  }

  async getReleaseArtifact(contentHash: string): Promise<ReleaseRecord> {
    const id = this.#releaseByHash.get(contentHash)?.[0];
    const release = id ? this.#releases.get(id) : undefined;
    if (!release) throw new RepositoryError("NOT_FOUND");
    return copy(release);
  }

  async listAuditEvents(actor: RepositoryActor): Promise<AuditEventRecord[]> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    return this.#audit.filter((event) => event.organizationId === actor.organizationId)
      .slice(0, MAX_AUDIT_EVENTS)
      .map(copy);
  }

  async reset(): Promise<void> {
    this.#projects.clear();
    this.#runs.clear();
    this.#results.clear();
    this.#capabilities.clear();
    this.#verifications.clear();
    this.#verificationCandidates.clear();
    this.#releases.clear();
    this.#releaseByHash.clear();
    this.#releaseByRun.clear();
    this.#idempotency.clear();
    this.#analysisAvailableAt.clear();
    this.#analysisSources.clear();
    this.#audit.splice(0);
  }
}

function candidateMatches(candidate: CandidateRelease, stored: CandidateRelease): boolean {
  return candidate.code === stored.code
    && candidate.contentHash === stored.contentHash
    && candidate.allowedOrigin === stored.allowedOrigin
    && canonicalJson(candidate.manifest ?? {}) === canonicalJson(stored.manifest ?? {});
}

function plansFromManifest(manifest: unknown): readonly CapabilityPlan[] | undefined {
  if (!manifest || typeof manifest !== "object" || !("plans" in manifest)
    || !Array.isArray((manifest as { plans?: unknown }).plans)) return undefined;
  try {
    return canonicalizeCapabilityPlans((manifest as { plans: CapabilityPlan[] }).plans);
  } catch {
    return undefined;
  }
}

function equalPlanSets(left: readonly CapabilityPlan[], right: readonly CapabilityPlan[]): boolean {
  if (left.length !== right.length) return false;
  const leftDigests = left.map((plan) => `${plan.tool.name}:${capabilityPlanDigest(plan)}`).sort(compareCodePoints);
  const rightDigests = right.map((plan) => `${plan.tool.name}:${capabilityPlanDigest(plan)}`).sort(compareCodePoints);
  return leftDigests.every((value, index) => value === rightDigests[index]);
}

function capabilityPlanBindingValid(capability: CapabilityRecord): boolean {
  try {
    return capability.stableName === capability.plan.tool.name
      && capability.riskTier === capability.plan.effects.riskTier
      && capability.planDigest === capabilityPlanDigest(capability.plan);
  } catch {
    return false;
  }
}

function normalizeEvidence(
  evidence: AnalysisEvidence,
  run: AnalysisRunRecord,
  defaultExpiresAt: string,
  now: Date,
): AnalysisEvidence {
  if (!evidence || typeof evidence !== "object"
    || !["openapi", "github", "runtime", "owner_review", "source"].includes(evidence.source)
    || typeof evidence.content !== "string"
    || evidence.content.length === 0
    || Buffer.byteLength(evidence.content) > MAX_RELEASE_BYTES
    || typeof evidence.reference !== "string"
    || evidence.organizationId !== undefined && evidence.organizationId !== run.organizationId
    || evidence.projectId !== undefined && evidence.projectId !== run.projectId
    || evidence.analysisRunId !== undefined && evidence.analysisRunId !== run.id) {
    throw new RepositoryError("INVALID_STATE");
  }
  const reference = `urn:sha256:${createHash("sha256").update(evidence.content).digest("hex")}`;
  const expiry = evidence.expiresAt ?? defaultExpiresAt;
  if (evidence.reference !== reference || !Number.isFinite(Date.parse(expiry)) || new Date(expiry) <= now) {
    throw new RepositoryError("INVALID_STATE");
  }
  return {
    id: randomUUID(),
    organizationId: run.organizationId,
    projectId: run.projectId,
    analysisRunId: run.id,
    source: evidence.source,
    content: evidence.content,
    reference,
    expiresAt: new Date(expiry).toISOString(),
  };
}

function evidenceResolves(
  evidence: readonly AnalysisEvidence[],
  plans: readonly CapabilityPlan[],
  run: AnalysisRunRecord,
  now: Date,
): boolean {
  const byReference = new Map<string, AnalysisEvidence>();
  for (const item of evidence) {
    if (item.organizationId !== run.organizationId || item.projectId !== run.projectId
      || item.analysisRunId !== run.id || item.expiresAt === undefined || new Date(item.expiresAt) <= now
      || `urn:sha256:${createHash("sha256").update(item.content).digest("hex")}` !== item.reference
      || byReference.has(item.reference)) return false;
    byReference.set(item.reference, item);
  }
  return plans.every((plan) => plan.evidence.every(({ source, reference }) => {
    const resolved = byReference.get(reference);
    return resolved?.source === source;
  }));
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort(compareCodePoints).map((key) => [key, normalize(record[key])]));
    }
    return item;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return "__INVALID_JSON__";
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
