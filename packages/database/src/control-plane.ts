import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../capability-ir/src/plan.ts";
import {
  WORKFLOW_DEFAULT_ACTIVE_TASK_QUOTA,
  WORKFLOW_LEASE_MS,
  WORKFLOW_MAX_ATTEMPTS,
  workflowPhase,
  workflowRetryDelayMs,
  type CancelWorkflowInput,
  type ClaimedWorkflowTaskRecord,
  type CompleteWorkflowTaskInput,
  type FailWorkflowTaskInput,
  type ProjectSourceRecord,
  type ResumeWorkflowTaskInput,
  type SourceSnapshotRecord,
  type StartWorkflowInput,
  type WaitWorkflowTaskInput,
  type WorkflowCapabilityPlanLink,
  type WorkflowEventRecord,
  type WorkflowEventType,
  type WorkflowEvidenceLink,
  type WorkflowRepository,
  type WorkflowRunRecord,
  type WorkflowTaskCompletion,
  type WorkflowTaskRecord,
} from "./workflow.ts";

export type RepositoryRole = "owner" | "editor" | "viewer";
export type RepositoryActor = { id: string; organizationId: string; role: RepositoryRole };
export type AuthenticatedIdentity = { id: string; email?: string };
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
  workflowTaskId: string;
  leaseGeneration: number;
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
  release?: CandidateRelease;
  draftPullRequest?: { draft: boolean; url?: string; files?: string[] };
};

export type WorkflowExecutionMaterial = Readonly<{
  workflowRunId: string;
  projectId: string;
  sourceSnapshotId: string;
  sourceType: SourceType;
  sourceUrl: string;
  analysisRunId: string;
  analysis: AnalysisResult;
  capabilities: CapabilityRecord[];
}>;

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
export type ProjectPageRequest = Readonly<{ limit?: number; cursor?: string }>;
export type ProjectPage = Readonly<{ projects: ProjectRecord[]; nextCursor?: string }>;
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
  | "LEASE_LOST"
  | "CANCELLED"
  | "WAIT_EXPIRED"
  | "MEMBERSHIP_REQUIRED"
  | "INVALID_CURSOR"
  | "SESSION_REVOKED";

export class RepositoryError extends Error {
  constructor(readonly code: RepositoryErrorCode, readonly details?: string[]) {
    super(code);
    this.name = "RepositoryError";
  }
}

export interface ControlPlaneRepository extends WorkflowRepository {
  provisionPersonalOrganization(identity: AuthenticatedIdentity): Promise<RepositoryActor>;
  resolveActor(identityId: string, organizationId?: string, sessionId?: string): Promise<RepositoryActor>;
  createProject(actor: RepositoryActor, input: CreateProjectRequest): Promise<ProjectRecord>;
  listProjects(actor: RepositoryActor): Promise<ProjectRecord[]>;
  listProjectsPage(actor: RepositoryActor, input?: ProjectPageRequest): Promise<ProjectPage>;
  getProject(actor: RepositoryActor, id: string): Promise<ProjectRecord>;
  getLatestAnalysis(actor: RepositoryActor, projectId: string): Promise<AnalysisRunRecord | undefined>;
  enqueueAnalysis(actor: RepositoryActor, input: IdempotentRequest): Promise<AnalysisRunRecord>;
  getAnalysis(actor: RepositoryActor, id: string): Promise<AnalysisRunRecord>;
  claimAnalysis(
    workerId: string,
    leaseMs: number,
    sourceTypes?: readonly SourceType[],
  ): Promise<ClaimedAnalysisRunRecord | undefined>;
  heartbeatAnalysis(workerId: string, runId: string, leaseMs: number, leaseGeneration?: number): Promise<void>;
  completeAnalysis(workerId: string, runId: string, result: AnalysisResult, leaseGeneration?: number): Promise<AnalysisRunRecord>;
  failAnalysis(workerId: string, runId: string, code: string, retryable: boolean, leaseGeneration?: number): Promise<AnalysisRunRecord>;
  getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined>;
  getWorkflowExecutionMaterial(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<WorkflowExecutionMaterial>;
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
type WorkflowCommandRecord = Readonly<{ inputHash: string; result: unknown }>;
type WaitTokenRecord = Readonly<{
  workflowRunId: string;
  taskId: string;
  expiresAt: string;
  consumedAt?: string;
  resumeIdempotencyKey?: string;
  resumeInputHash?: string;
}>;

type InMemoryRepositoryOptions = Readonly<{
  random?: () => number;
  activeTaskQuota?: number;
}>;

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PROJECT_PAGE_SIZE = 100;
const MAX_CAPABILITIES = 1_000;
const MAX_AUDIT_EVENTS = 1_000;
const MAX_RELEASE_BYTES = 64 * 1_024;
const MAX_ANALYSIS_DIAGNOSTICS = 1_000;
const MAX_ANALYSIS_DIAGNOSTIC_BYTES = 64 * 1_024;
const ANALYSIS_SOURCE_TYPES: readonly SourceType[] = ["github", "openapi", "website"];

export function normalizeAnalysisSourceTypes(
  sourceTypes: readonly SourceType[] | undefined,
): ReadonlySet<SourceType> | undefined {
  if (sourceTypes === undefined) return undefined;
  const allowed = new Set(ANALYSIS_SOURCE_TYPES);
  if (!Array.isArray(sourceTypes) || sourceTypes.length === 0 || sourceTypes.length > allowed.size
    || sourceTypes.some((sourceType) => !allowed.has(sourceType))
    || new Set(sourceTypes).size !== sourceTypes.length) {
    throw new RepositoryError("INVALID_STATE");
  }
  return new Set(sourceTypes);
}

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
  readonly #personalOrganizations = new Map<string, { id: string; name: string }>();
  readonly #memberships = new Map<string, RepositoryActor>();
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
  readonly #projectSources = new Map<string, ProjectSourceRecord>();
  readonly #sourceSnapshots = new Map<string, SourceSnapshotRecord>();
  readonly #workflowRuns = new Map<string, WorkflowRunRecord>();
  readonly #workflowTasks = new Map<string, WorkflowTaskRecord>();
  readonly #workflowEvents = new Map<string, WorkflowEventRecord[]>();
  readonly #workflowEvidence = new Map<string, WorkflowEvidenceLink[]>();
  readonly #workflowCapabilityPlans = new Map<string, WorkflowCapabilityPlanLink[]>();
  readonly #workflowCommands = new Map<string, WorkflowCommandRecord>();
  readonly #waitTokens = new Map<string, WaitTokenRecord>();
  readonly #organizationClaimOrder = new Map<string, number>();
  readonly #audit: AuditEventRecord[] = [];
  #claimSequence = 0;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly workflowOptions: InMemoryRepositoryOptions = {},
  ) {}

  #now(): string {
    return this.clock().toISOString();
  }

  async provisionPersonalOrganization(identity: AuthenticatedIdentity): Promise<RepositoryActor> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.id)) {
      throw new RepositoryError("MEMBERSHIP_REQUIRED");
    }
    let organization = this.#personalOrganizations.get(identity.id);
    if (!organization) {
      const localPart = identity.email?.split("@", 1)[0]?.trim().slice(0, 80);
      organization = { id: randomUUID(), name: localPart ? `${localPart}'s workspace` : "Personal workspace" };
      this.#personalOrganizations.set(identity.id, organization);
    }
    const key = `${organization.id}:${identity.id}`;
    const actor = this.#memberships.get(key) ?? {
      id: identity.id,
      organizationId: organization.id,
      role: "owner" as const
    };
    this.#memberships.set(key, actor);
    return copy(actor);
  }

  async resolveActor(identityId: string, organizationId?: string, sessionId?: string): Promise<RepositoryActor> {
    void sessionId; // The in-memory repository has no Supabase session table; production Postgres validates it.
    const personal = this.#personalOrganizations.get(identityId);
    const selectedOrganization = organizationId ?? personal?.id;
    const matches = [...this.#memberships.values()]
      .filter((membership) => membership.id === identityId
        && (!selectedOrganization || membership.organizationId === selectedOrganization))
      .sort((left, right) => compareCodePoints(left.organizationId, right.organizationId));
    if (matches.length === 0) throw new RepositoryError("MEMBERSHIP_REQUIRED");
    return copy(matches[0]!);
  }

  /** Explicit hermetic-test setup hook; production identity still uses resolveActor. */
  seedMembershipForTest(actor: RepositoryActor): void {
    if (process.env.NODE_ENV === "production") throw new Error("TEST_MEMBERSHIP_OVERRIDE_FORBIDDEN");
    this.#personalOrganizations.set(actor.id, { id: actor.organizationId, name: "Hermetic test workspace" });
    this.#memberships.set(`${actor.organizationId}:${actor.id}`, copy(actor));
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

  #idempotencyId(operation: "project" | "analysis" | "release" | "workflow", actor: RepositoryActor, key: string): string {
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

  #workflowRunForActor(actor: RepositoryActor, runId: string): WorkflowRunRecord {
    const run = this.#workflowRuns.get(runId);
    if (!run || run.organizationId !== actor.organizationId) throw new RepositoryError("NOT_FOUND");
    return run;
  }

  #workflowTask(taskId: string): WorkflowTaskRecord {
    const task = this.#workflowTasks.get(taskId);
    if (!task) throw new RepositoryError("INVALID_STATE");
    return task;
  }

  #appendWorkflowEvent(
    runId: string,
    type: WorkflowEventType,
    taskId?: string,
    code?: string,
  ): WorkflowRunRecord {
    const existing = this.#workflowRuns.get(runId);
    if (!existing) throw new RepositoryError("INVALID_STATE");
    const version = existing.version + 1;
    const events = this.#workflowEvents.get(runId) ?? [];
    const updated: WorkflowRunRecord = { ...existing, version, updatedAt: this.#now() };
    this.#workflowRuns.set(runId, updated);
    events.push({
      id: randomUUID(),
      organizationId: existing.organizationId,
      projectId: existing.projectId,
      workflowRunId: runId,
      ...(taskId ? { taskId } : {}),
      sequence: events.length + 1,
      version,
      type,
      ...(code ? { code } : {}),
      createdAt: this.#now(),
    });
    this.#workflowEvents.set(runId, events);
    return updated;
  }

  #createWorkflowTask(run: WorkflowRunRecord, phase: WorkflowTaskRecord["phase"], inputHash: string): WorkflowTaskRecord {
    const normalizedInputHash = stableHash(inputHash);
    const existing = [...this.#workflowTasks.values()].find((task) => task.workflowRunId === run.id && task.phase === phase);
    if (existing) return existing;
    const now = this.#now();
    const task: WorkflowTaskRecord = {
      id: randomUUID(),
      organizationId: run.organizationId,
      projectId: run.projectId,
      workflowRunId: run.id,
      phase,
      status: "queued",
      idempotencyKey: workflowTaskIdempotencyKey(run.id, phase, normalizedInputHash),
      inputHash: normalizedInputHash,
      leaseGeneration: 0,
      attempts: 0,
      maxAttempts: WORKFLOW_MAX_ATTEMPTS,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.#workflowTasks.set(task.id, task);
    this.#appendWorkflowEvent(run.id, "task.created", task.id);
    return task;
  }

  #createWorkflowRun(input: Readonly<{
    id: string;
    project: ProjectRecord;
    sourceSnapshotId: string;
    inputHash: string;
    phase: WorkflowTaskRecord["phase"];
    analysisRunId?: string;
    reviewedAnalysisRunId?: string;
  }>): WorkflowRunRecord {
    const now = this.#now();
    const run: WorkflowRunRecord = {
      id: input.id,
      organizationId: input.project.organizationId,
      projectId: input.project.id,
      sourceSnapshotId: input.sourceSnapshotId,
      ...(input.analysisRunId ? { analysisRunId: input.analysisRunId } : {}),
      ...(input.reviewedAnalysisRunId ? { reviewedAnalysisRunId: input.reviewedAnalysisRunId } : {}),
      status: "queued",
      currentPhase: input.phase,
      inputHash: stableHash(input.inputHash),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#workflowRuns.set(run.id, run);
    this.#workflowEvents.set(run.id, []);
    this.#workflowEvidence.set(run.id, []);
    this.#workflowCapabilityPlans.set(run.id, []);
    this.#appendWorkflowEvent(run.id, "workflow.created");
    this.#createWorkflowTask(this.#workflowRuns.get(run.id)!, input.phase, run.inputHash);
    return this.#workflowRuns.get(run.id)!;
  }

  #activeSourceSnapshot(projectId: string): SourceSnapshotRecord {
    const source = [...this.#projectSources.values()].find((candidate) => candidate.projectId === projectId && candidate.active);
    const snapshot = source
      ? [...this.#sourceSnapshots.values()].find((candidate) => candidate.projectSourceId === source.id)
      : undefined;
    if (!source || !snapshot) throw new RepositoryError("INVALID_STATE");
    return snapshot;
  }

  #commandReplay<T>(scope: string, idempotencyKey: string, inputHash: string): T | undefined {
    assertIdempotencyKey(idempotencyKey);
    const normalizedHash = stableHash(inputHash);
    const previous = this.#workflowCommands.get(`${scope}:${idempotencyKey}`);
    if (!previous) return undefined;
    if (previous.inputHash !== normalizedHash) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
    return copy(previous.result) as T;
  }

  #recordCommand(scope: string, idempotencyKey: string, inputHash: string, result: unknown): void {
    this.#workflowCommands.set(`${scope}:${idempotencyKey}`, { inputHash: stableHash(inputHash), result: copy(result) });
  }

  #assertWorkflowLease(workerId: string, task: WorkflowTaskRecord, leaseGeneration: number): void {
    const run = this.#workflowRuns.get(task.workflowRunId);
    if (!run || run.cancelRequestedAt || run.status === "cancelled") throw new RepositoryError("CANCELLED");
    if (task.status !== "running" || task.leaseOwner !== workerId || task.leaseGeneration !== leaseGeneration
      || !task.leaseExpiresAt || new Date(task.leaseExpiresAt) <= this.clock()) throw new RepositoryError("LEASE_LOST");
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
    const projectSource: ProjectSourceRecord = {
      id: randomUUID(),
      organizationId: project.organizationId,
      projectId: project.id,
      sourceType: project.sourceType,
      sourceUrl: project.url,
      version: 1,
      active: true,
      createdAt: project.createdAt,
    };
    this.#projectSources.set(projectSource.id, projectSource);
    const snapshot: SourceSnapshotRecord = {
      id: randomUUID(),
      organizationId: project.organizationId,
      projectId: project.id,
      projectSourceId: projectSource.id,
      sourceIdentityHash: stableHash(sourceIdentityMaterial(project.sourceType, project.url)),
      createdAt: project.createdAt,
    };
    this.#sourceSnapshots.set(snapshot.id, snapshot);
    this.#reserveIdempotency(idempotencyId, input.inputHash, project.id);
    this.#auditEvent(actor, "project.created", project.id);
    return copy(project);
  }

  async listProjects(actor: RepositoryActor): Promise<ProjectRecord[]> {
    return [...this.#projects.values()]
      .filter((project) => project.organizationId === actor.organizationId)
      .sort((left, right) => compareCodePoints(left.createdAt, right.createdAt) || compareCodePoints(left.id, right.id))
      .map(copy);
  }

  async listProjectsPage(actor: RepositoryActor, input: ProjectPageRequest = {}): Promise<ProjectPage> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROJECT_PAGE_SIZE) {
      throw new RepositoryError("INVALID_CURSOR");
    }
    const cursor = input.cursor ? decodeProjectCursor(input.cursor) : undefined;
    const candidates = [...this.#projects.values()]
      .filter((project) => project.organizationId === actor.organizationId)
      .sort((left, right) => compareCodePoints(left.createdAt, right.createdAt) || compareCodePoints(left.id, right.id))
      .filter((project) => !cursor || compareProjectPosition(project, cursor) > 0);
    const page = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    return {
      projects: page.map(copy),
      ...(hasMore && page.length > 0 ? { nextCursor: encodeProjectCursor(page[page.length - 1]!) } : {})
    };
  }

  async getProject(actor: RepositoryActor, id: string): Promise<ProjectRecord> {
    return copy(this.#assertProject(actor, id));
  }

  async getLatestAnalysis(actor: RepositoryActor, projectId: string): Promise<AnalysisRunRecord | undefined> {
    this.#assertProject(actor, projectId);
    const run = [...this.#runs.values()]
      .filter((candidate) => candidate.projectId === projectId && candidate.organizationId === actor.organizationId)
      .sort((left, right) => compareCodePoints(right.createdAt, left.createdAt) || compareCodePoints(right.id, left.id))[0];
    return run ? copy(run) : undefined;
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
    this.#createWorkflowRun({
      id: run.id,
      project,
      sourceSnapshotId: this.#activeSourceSnapshot(project.id).id,
      inputHash: input.inputHash,
      phase: "analysis",
      analysisRunId: run.id,
    });
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

  async listProjectSources(actor: RepositoryActor, projectId: string): Promise<ProjectSourceRecord[]> {
    this.#assertProject(actor, projectId);
    return [...this.#projectSources.values()]
      .filter((source) => source.projectId === projectId)
      .sort((left, right) => left.version - right.version || compareCodePoints(left.id, right.id))
      .map(copy);
  }

  async listSourceSnapshots(actor: RepositoryActor, projectId: string): Promise<SourceSnapshotRecord[]> {
    this.#assertProject(actor, projectId);
    return [...this.#sourceSnapshots.values()]
      .filter((snapshot) => snapshot.projectId === projectId)
      .sort((left, right) => compareCodePoints(left.createdAt, right.createdAt) || compareCodePoints(left.id, right.id))
      .map(copy);
  }

  async startWorkflow(actor: RepositoryActor, input: StartWorkflowInput): Promise<WorkflowRunRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const project = this.#assertProject(actor, input.projectId);
    const idempotencyId = this.#idempotencyId("workflow", actor, input.idempotencyKey);
    const previous = this.#idempotentReplay(idempotencyId, input.inputHash);
    if (previous) return copy(this.#workflowRunForActor(actor, previous.resultId));
    if ([...this.#workflowRuns.values()].some((run) => run.projectId === project.id
      && ["queued", "running", "waiting"].includes(run.status))) throw new RepositoryError("INVALID_STATE");
    let reviewedAnalysisRunId: string | undefined;
    if (input.analysisRunId !== undefined) {
      const analysis = this.#runs.get(input.analysisRunId);
      const analysisWorkflow = this.#workflowRuns.get(input.analysisRunId);
      const result = this.#results.get(input.analysisRunId);
      const capabilities = this.#analysisCapabilities(input.analysisRunId);
      if (project.sourceType !== "github" || !analysis || analysis.projectId !== project.id
        || analysis.organizationId !== actor.organizationId || analysis.status !== "succeeded"
        || !analysisWorkflow || analysisWorkflow.sourceSnapshotId !== this.#activeSourceSnapshot(project.id).id
        || !result?.release || capabilities.length === 0
        || capabilities.some((capability) => capability.status === "blocked"
          || capability.reviewedPlanDigest !== capability.planDigest)) {
        throw new RepositoryError("INVALID_STATE");
      }
      reviewedAnalysisRunId = analysis.id;
    }
    const id = randomUUID();
    const run = this.#createWorkflowRun({
      id,
      project,
      sourceSnapshotId: this.#activeSourceSnapshot(project.id).id,
      inputHash: input.inputHash,
      phase: "preflight",
      ...(reviewedAnalysisRunId ? { reviewedAnalysisRunId } : {}),
    });
    this.#projects.set(project.id, { ...project, status: "analyzing" });
    this.#reserveIdempotency(idempotencyId, input.inputHash, id);
    this.#auditEvent(actor, "workflow.queued", id);
    return copy(run);
  }

  async getWorkflowRun(actor: RepositoryActor, runId: string): Promise<WorkflowRunRecord> {
    return copy(this.#workflowRunForActor(actor, runId));
  }

  async listWorkflowTasks(actor: RepositoryActor, runId: string): Promise<WorkflowTaskRecord[]> {
    this.#workflowRunForActor(actor, runId);
    return [...this.#workflowTasks.values()].filter((task) => task.workflowRunId === runId)
      .sort((left, right) => compareCodePoints(left.createdAt, right.createdAt) || compareCodePoints(left.id, right.id))
      .map(copy);
  }

  async listWorkflowEvents(actor: RepositoryActor, runId: string): Promise<WorkflowEventRecord[]> {
    this.#workflowRunForActor(actor, runId);
    return (this.#workflowEvents.get(runId) ?? []).map(copy);
  }

  async listWorkflowEvidence(actor: RepositoryActor, runId: string): Promise<WorkflowEvidenceLink[]> {
    this.#workflowRunForActor(actor, runId);
    return (this.#workflowEvidence.get(runId) ?? []).map(copy);
  }

  async listWorkflowCapabilityPlans(actor: RepositoryActor, runId: string): Promise<WorkflowCapabilityPlanLink[]> {
    this.#workflowRunForActor(actor, runId);
    return (this.#workflowCapabilityPlans.get(runId) ?? []).map(copy);
  }

  async claimWorkflowTask(workerId: string): Promise<ClaimedWorkflowTaskRecord | undefined> {
    assertWorkerId(workerId);
    const now = this.clock();
    const activeByOrganization = new Map<string, number>();
    for (const task of this.#workflowTasks.values()) {
      if (task.status === "running" && task.leaseExpiresAt
        && new Date(task.leaseExpiresAt) > now) {
        activeByOrganization.set(task.organizationId, (activeByOrganization.get(task.organizationId) ?? 0) + 1);
      }
    }
    const quota = Math.max(1, Math.min(this.workflowOptions.activeTaskQuota
      ?? WORKFLOW_DEFAULT_ACTIVE_TASK_QUOTA, 100));
    const candidates = [...this.#workflowTasks.values()].filter((task) => {
      if (task.phase === "analysis" || task.attempts >= task.maxAttempts) return false;
      const run = this.#workflowRuns.get(task.workflowRunId);
      if (!run || run.cancelRequestedAt || ["succeeded", "failed", "cancelled"].includes(run.status)) return false;
      const available = task.status === "queued" && new Date(task.availableAt) <= now;
      const expired = task.status === "running" && task.leaseExpiresAt !== undefined && new Date(task.leaseExpiresAt) <= now;
      return (available || expired) && (activeByOrganization.get(task.organizationId) ?? 0) < quota;
    }).sort((left, right) => {
      const leftOrder = this.#organizationClaimOrder.get(left.organizationId) ?? 0;
      const rightOrder = this.#organizationClaimOrder.get(right.organizationId) ?? 0;
      return leftOrder - rightOrder
        || compareCodePoints(left.availableAt, right.availableAt)
        || compareCodePoints(left.createdAt, right.createdAt)
        || compareCodePoints(left.id, right.id);
    });
    const candidate = candidates[0];
    if (!candidate) return undefined;
    const claimed: ClaimedWorkflowTaskRecord = {
      ...candidate,
      status: "running",
      attempts: candidate.attempts + 1,
      leaseGeneration: candidate.leaseGeneration + 1,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(now.getTime() + WORKFLOW_LEASE_MS).toISOString(),
      errorCode: undefined,
      updatedAt: now.toISOString(),
    };
    this.#workflowTasks.set(claimed.id, claimed);
    this.#organizationClaimOrder.set(claimed.organizationId, ++this.#claimSequence);
    const run = this.#workflowRuns.get(claimed.workflowRunId);
    if (!run) throw new RepositoryError("INVALID_STATE");
    this.#workflowRuns.set(run.id, { ...run, status: "running", currentPhase: claimed.phase, updatedAt: now.toISOString() });
    this.#appendWorkflowEvent(run.id, "task.claimed", claimed.id);
    return copy(claimed);
  }

  async assertWorkflowTaskLease(workerId: string, taskId: string, leaseGeneration: number): Promise<void> {
    this.#assertWorkflowLease(workerId, this.#workflowTask(taskId), leaseGeneration);
  }

  async getWorkflowExecutionMaterial(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<WorkflowExecutionMaterial> {
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const run = this.#workflowRuns.get(task.workflowRunId);
    const sourceSnapshot = run ? this.#sourceSnapshots.get(run.sourceSnapshotId) : undefined;
    const source = sourceSnapshot ? this.#projectSources.get(sourceSnapshot.projectSourceId) : undefined;
    const analysisRunId = run?.reviewedAnalysisRunId;
    const analysis = analysisRunId ? this.#results.get(analysisRunId) : undefined;
    const capabilities = analysisRunId ? this.#analysisCapabilities(analysisRunId) : [];
    if (!run || !sourceSnapshot || !source || !analysisRunId || !analysis?.release
      || source.projectId !== run.projectId || source.sourceType !== "github"
      || capabilities.length === 0 || capabilities.some((capability) => capability.status === "blocked"
        || capability.reviewedPlanDigest !== capability.planDigest)) {
      throw new RepositoryError("INVALID_STATE");
    }
    return copy({
      workflowRunId: run.id,
      projectId: run.projectId,
      sourceSnapshotId: run.sourceSnapshotId,
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      analysisRunId,
      analysis,
      capabilities,
    });
  }

  async heartbeatWorkflowTask(workerId: string, taskId: string, leaseGeneration: number): Promise<WorkflowTaskRecord> {
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const updated: WorkflowTaskRecord = {
      ...task,
      leaseExpiresAt: new Date(this.clock().getTime() + WORKFLOW_LEASE_MS).toISOString(),
      updatedAt: this.#now(),
    };
    this.#workflowTasks.set(task.id, updated);
    this.#appendWorkflowEvent(task.workflowRunId, "task.heartbeat", task.id);
    return copy(updated);
  }

  async completeWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: CompleteWorkflowTaskInput,
  ): Promise<WorkflowTaskCompletion> {
    const replay = this.#commandReplay<WorkflowTaskCompletion>(`complete:${taskId}`, input.idempotencyKey, input.inputHash);
    if (replay) return replay;
    validateWorkflowReference(input.checkpointReference);
    validateWorkflowReference(input.outputReference);
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const run = this.#workflowRuns.get(task.workflowRunId);
    if (!run) throw new RepositoryError("INVALID_STATE");
    const outputHash = stableHash(canonicalJson({
      checkpointReference: input.checkpointReference,
      commandInputHash: stableHash(input.inputHash),
      outputReference: input.outputReference,
    }));
    const now = this.#now();
    const completedTask: WorkflowTaskRecord = {
      ...task,
      status: "succeeded",
      outputHash,
      ...(input.checkpointReference ? { checkpointReference: input.checkpointReference } : {}),
      ...(input.outputReference ? { outputReference: input.outputReference } : {}),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryClassification: undefined,
      errorCode: undefined,
      updatedAt: now,
    };
    this.#workflowTasks.set(task.id, completedTask);
    this.#appendWorkflowEvent(run.id, "task.completed", task.id);
    const nextPhase = task.phase === "analysis" ? undefined : workflowPhase(task.phase).next;
    let nextTask: WorkflowTaskRecord | undefined;
    if (nextPhase) {
      const current = this.#workflowRuns.get(run.id)!;
      this.#workflowRuns.set(run.id, { ...current, status: "queued", currentPhase: nextPhase, errorCode: undefined, updatedAt: now });
      nextTask = this.#createWorkflowTask(this.#workflowRuns.get(run.id)!, nextPhase, outputHash);
    } else {
      const current = this.#workflowRuns.get(run.id)!;
      this.#workflowRuns.set(run.id, { ...current, status: "succeeded", currentPhase: task.phase, errorCode: undefined, updatedAt: now });
      this.#appendWorkflowEvent(run.id, "workflow.completed");
      const project = this.#projects.get(run.projectId);
      if (project) this.#projects.set(project.id, { ...project, status: "analyzed" });
    }
    const result = { run: this.#workflowRuns.get(run.id)!, task: completedTask, ...(nextTask ? { nextTask } : {}) };
    this.#recordCommand(`complete:${taskId}`, input.idempotencyKey, input.inputHash, result);
    return copy(result);
  }

  async failWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: FailWorkflowTaskInput,
  ): Promise<WorkflowTaskRecord> {
    const replay = this.#commandReplay<WorkflowTaskRecord>(`fail:${taskId}`, input.idempotencyKey, input.inputHash);
    if (replay) return replay;
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)) throw new RepositoryError("INVALID_STATE");
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const terminal = input.classification === "permanent" || task.attempts >= task.maxAttempts;
    const now = this.clock();
    const availableAt = terminal ? now.toISOString() : new Date(now.getTime() + workflowRetryDelayMs(
      task.attempts,
      input.classification === "rate_limited" ? input.retryAfterMs : undefined,
      this.workflowOptions.random,
    )).toISOString();
    const failed: WorkflowTaskRecord = {
      ...task,
      status: terminal ? "failed" : "queued",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryClassification: input.classification,
      errorCode: input.errorCode,
      availableAt,
      updatedAt: now.toISOString(),
    };
    this.#workflowTasks.set(task.id, failed);
    const run = this.#workflowRuns.get(task.workflowRunId);
    if (!run) throw new RepositoryError("INVALID_STATE");
    this.#workflowRuns.set(run.id, {
      ...run,
      status: terminal ? "failed" : "queued",
      errorCode: input.errorCode,
      updatedAt: now.toISOString(),
    });
    this.#appendWorkflowEvent(run.id, terminal ? "task.failed" : "task.retry_scheduled", task.id, input.errorCode);
    if (terminal) {
      this.#appendWorkflowEvent(run.id, "workflow.failed", undefined, input.errorCode);
      const project = this.#projects.get(run.projectId);
      if (project) this.#projects.set(project.id, { ...project, status: "failed" });
    }
    this.#recordCommand(`fail:${taskId}`, input.idempotencyKey, input.inputHash, failed);
    return copy(failed);
  }

  async waitWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: WaitWorkflowTaskInput,
  ): Promise<Readonly<{ task: WorkflowTaskRecord; waitToken: string }>> {
    assertIdempotencyKey(input.idempotencyKey);
    stableHash(input.inputHash);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.reason)) throw new RepositoryError("INVALID_STATE");
    const expiry = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= this.clock().getTime()
      || expiry - this.clock().getTime() > 24 * 60 * 60 * 1_000) throw new RepositoryError("INVALID_STATE");
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const waitToken = randomUUID().replaceAll("-", "");
    const waitKeyHash = stableHash(waitToken);
    const now = this.#now();
    const waiting: WorkflowTaskRecord = {
      ...task,
      status: "waiting",
      waitKeyHash,
      waitReason: input.reason,
      waitExpiresAt: new Date(expiry).toISOString(),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    };
    this.#workflowTasks.set(task.id, waiting);
    const run = this.#workflowRuns.get(task.workflowRunId);
    if (!run) throw new RepositoryError("INVALID_STATE");
    this.#workflowRuns.set(run.id, { ...run, status: "waiting", updatedAt: now });
    this.#waitTokens.set(waitKeyHash, { workflowRunId: run.id, taskId: task.id, expiresAt: waiting.waitExpiresAt! });
    this.#appendWorkflowEvent(run.id, "task.waiting", task.id);
    return copy({ task: waiting, waitToken });
  }

  async resumeWorkflowTask(actor: RepositoryActor, input: ResumeWorkflowTaskInput): Promise<WorkflowTaskRecord> {
    const run = this.#workflowRunForActor(actor, input.runId);
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const replay = this.#commandReplay<WorkflowTaskRecord>(`resume:${run.id}`, input.idempotencyKey, input.inputHash);
    if (replay) return replay;
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.waitToken)) throw new RepositoryError("INVALID_STATE");
    const waitKeyHash = stableHash(input.waitToken);
    const token = this.#waitTokens.get(waitKeyHash);
    if (!token || token.workflowRunId !== run.id) throw new RepositoryError("NOT_FOUND");
    if (new Date(token.expiresAt) <= this.clock()) throw new RepositoryError("WAIT_EXPIRED");
    if (run.cancelRequestedAt || run.status === "cancelled") throw new RepositoryError("CANCELLED");
    const task = this.#workflowTask(token.taskId);
    if (task.status !== "waiting" || task.waitKeyHash !== waitKeyHash) throw new RepositoryError("INVALID_STATE");
    const now = this.#now();
    const resumed: WorkflowTaskRecord = {
      ...task,
      status: "queued",
      resumedAt: now,
      availableAt: now,
      updatedAt: now,
    };
    this.#workflowTasks.set(task.id, resumed);
    this.#waitTokens.set(waitKeyHash, {
      ...token,
      consumedAt: now,
      resumeIdempotencyKey: input.idempotencyKey,
      resumeInputHash: stableHash(input.inputHash),
    });
    this.#workflowRuns.set(run.id, { ...run, status: "queued", updatedAt: now });
    this.#appendWorkflowEvent(run.id, "task.resumed", task.id);
    this.#recordCommand(`resume:${run.id}`, input.idempotencyKey, input.inputHash, resumed);
    return copy(resumed);
  }

  async cancelWorkflow(actor: RepositoryActor, input: CancelWorkflowInput): Promise<WorkflowRunRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const run = this.#workflowRunForActor(actor, input.runId);
    const replay = this.#commandReplay<WorkflowRunRecord>(`cancel:${run.id}`, input.idempotencyKey, input.inputHash);
    if (replay) return replay;
    if (["succeeded", "failed", "cancelled"].includes(run.status)) throw new RepositoryError("INVALID_STATE");
    const now = this.#now();
    this.#workflowRuns.set(run.id, { ...run, cancelRequestedAt: now, updatedAt: now });
    this.#appendWorkflowEvent(run.id, "workflow.cancel_requested");
    for (const task of [...this.#workflowTasks.values()]
      .filter((candidate) => candidate.workflowRunId === run.id && !["succeeded", "failed", "cancelled"].includes(candidate.status))) {
      this.#workflowTasks.set(task.id, {
        ...task,
        status: "cancelled",
        cancelRequestedAt: now,
        cancelledAt: now,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      this.#appendWorkflowEvent(run.id, "task.cancelled", task.id);
    }
    const requested = this.#workflowRuns.get(run.id)!;
    const cancelled: WorkflowRunRecord = { ...requested, status: "cancelled", cancelledAt: now, updatedAt: now };
    this.#workflowRuns.set(run.id, cancelled);
    this.#appendWorkflowEvent(run.id, "workflow.cancelled");
    const analysis = run.analysisRunId ? this.#runs.get(run.analysisRunId) : undefined;
    if (analysis && ["queued", "running"].includes(analysis.status)) {
      this.#runs.set(analysis.id, {
        ...analysis, status: "cancelled", leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now,
      });
      this.#analysisAvailableAt.delete(analysis.id);
    }
    this.#recordCommand(`cancel:${run.id}`, input.idempotencyKey, input.inputHash, cancelled);
    return copy(this.#workflowRuns.get(run.id)!);
  }

  async reconcileWorkflows(workerId: string): Promise<number> {
    assertWorkerId(workerId);
    const now = this.clock();
    let repaired = 0;
    for (const task of [...this.#workflowTasks.values()]) {
      if (task.phase === "analysis" || task.status !== "running" || !task.leaseExpiresAt
        || new Date(task.leaseExpiresAt) > now) continue;
      const run = this.#workflowRuns.get(task.workflowRunId);
      if (!run || run.cancelRequestedAt || ["succeeded", "failed", "cancelled"].includes(run.status)) continue;
      const terminal = task.attempts >= task.maxAttempts;
      const updated: WorkflowTaskRecord = {
        ...task,
        status: terminal ? "failed" : "queued",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        availableAt: now.toISOString(),
        reconciledAt: now.toISOString(),
        errorCode: terminal ? "ATTEMPTS_EXHAUSTED" : task.errorCode,
        updatedAt: now.toISOString(),
      };
      this.#workflowTasks.set(task.id, updated);
      this.#workflowRuns.set(run.id, {
        ...run,
        status: terminal ? "failed" : "queued",
        errorCode: terminal ? "ATTEMPTS_EXHAUSTED" : run.errorCode,
        updatedAt: now.toISOString(),
      });
      this.#appendWorkflowEvent(run.id, "task.reconciled", task.id, terminal ? "ATTEMPTS_EXHAUSTED" : undefined);
      this.#appendWorkflowEvent(run.id, "workflow.reconciled");
      repaired += 1;
    }
    for (const task of [...this.#workflowTasks.values()]) {
      if (task.phase === "analysis" || task.status !== "succeeded") continue;
      const run = this.#workflowRuns.get(task.workflowRunId);
      if (!run || run.cancelRequestedAt || !["queued", "running", "waiting"].includes(run.status)) continue;
      const nextPhase = workflowPhase(task.phase).next;
      if (!nextPhase || run.currentPhase !== nextPhase
        || [...this.#workflowTasks.values()].some((candidate) => candidate.workflowRunId === run.id
          && candidate.phase === nextPhase)) continue;
      const nextTask = this.#createWorkflowTask(run, nextPhase, task.outputHash ?? task.inputHash);
      this.#workflowTasks.set(nextTask.id, { ...nextTask, reconciledAt: now.toISOString() });
      this.#appendWorkflowEvent(run.id, "workflow.reconciled");
      repaired += 1;
    }
    return repaired;
  }

  async claimAnalysis(
    workerId: string,
    leaseMs: number,
    sourceTypes?: readonly SourceType[],
  ): Promise<ClaimedAnalysisRunRecord | undefined> {
    const now = this.clock();
    const allowedSourceTypes = normalizeAnalysisSourceTypes(sourceTypes);
    const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
    const quota = Math.max(1, Math.min(this.workflowOptions.activeTaskQuota
      ?? WORKFLOW_DEFAULT_ACTIVE_TASK_QUOTA, 100));
    const activeByOrganization = new Map<string, number>();
    for (const task of this.#workflowTasks.values()) {
      if (task.status === "running" && task.leaseExpiresAt && new Date(task.leaseExpiresAt) > now) {
        activeByOrganization.set(task.organizationId, (activeByOrganization.get(task.organizationId) ?? 0) + 1);
      }
    }
    const candidates = [...this.#runs.values()].sort((left, right) =>
      (this.#organizationClaimOrder.get(left.organizationId) ?? 0)
        - (this.#organizationClaimOrder.get(right.organizationId) ?? 0)
      || compareCodePoints(left.createdAt, right.createdAt)
      || compareCodePoints(left.id, right.id));
    for (const run of candidates) {
      const source = this.#analysisSources.get(run.id);
      if (!source) throw new RepositoryError("INVALID_STATE");
      if (allowedSourceTypes && !allowedSourceTypes.has(source.sourceType)) continue;
      if ((activeByOrganization.get(run.organizationId) ?? 0) >= quota) continue;
      const expired = run.status === "running" && run.leaseExpiresAt !== undefined && new Date(run.leaseExpiresAt) <= now;
      if (run.status !== "queued" && !expired) continue;
      if (run.status === "queued" && new Date(this.#analysisAvailableAt.get(run.id) ?? run.createdAt) > now) continue;
      if (run.attempts >= 3) {
        this.#runs.set(run.id, { ...run, status: "failed", errorCode: "ATTEMPTS_EXHAUSTED", updatedAt: now.toISOString() });
        const project = this.#projects.get(run.projectId);
        if (project) this.#projects.set(project.id, { ...project, status: "failed" });
        this.#analysisAvailableAt.delete(run.id);
        const workflow = this.#workflowRuns.get(run.id);
        const task = [...this.#workflowTasks.values()].find((candidate) => candidate.workflowRunId === run.id && candidate.phase === "analysis");
        if (workflow && task && workflow.status !== "failed") {
          this.#workflowTasks.set(task.id, {
            ...task, status: "failed", errorCode: undefined, leaseOwner: undefined, leaseExpiresAt: undefined,
            updatedAt: now.toISOString(),
          } as WorkflowTaskRecord);
          this.#workflowRuns.set(workflow.id, { ...workflow, status: "failed", errorCode: "ATTEMPTS_EXHAUSTED", updatedAt: now.toISOString() });
          this.#appendWorkflowEvent(workflow.id, "task.failed", task.id, "ATTEMPTS_EXHAUSTED");
          this.#appendWorkflowEvent(workflow.id, "workflow.failed", undefined, "ATTEMPTS_EXHAUSTED");
        }
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
      const workflow = this.#workflowRuns.get(run.id);
      const task = [...this.#workflowTasks.values()].find((candidate) => candidate.workflowRunId === run.id && candidate.phase === "analysis");
      if (!workflow || !task || !["queued", "running"].includes(task.status)) throw new RepositoryError("INVALID_STATE");
      const workflowTask: WorkflowTaskRecord = {
        ...task,
        status: "running",
        attempts: claimed.attempts,
        leaseGeneration: task.leaseGeneration + 1,
        leaseOwner: workerId,
        leaseExpiresAt: claimed.leaseExpiresAt,
        updatedAt: now.toISOString(),
      };
      this.#workflowTasks.set(task.id, workflowTask);
      this.#organizationClaimOrder.set(run.organizationId, ++this.#claimSequence);
      this.#workflowRuns.set(workflow.id, { ...workflow, status: "running", currentPhase: "analysis", updatedAt: now.toISOString() });
      this.#appendWorkflowEvent(workflow.id, "task.claimed", task.id);
      return copy({
        ...claimed,
        ...source,
        workflowTaskId: workflowTask.id,
        leaseGeneration: workflowTask.leaseGeneration,
      });
    }
    return undefined;
  }

  async heartbeatAnalysis(workerId: string, runId: string, leaseMs: number, leaseGeneration?: number): Promise<void> {
    const workflow = this.#workflowRuns.get(runId);
    if (workflow?.cancelRequestedAt || workflow?.status === "cancelled") throw new RepositoryError("CANCELLED");
    const run = this.#runs.get(runId);
    const now = this.clock();
    if (!run || run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= now) throw new RepositoryError("LEASE_LOST");
    const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
    const task = [...this.#workflowTasks.values()].find((candidate) => candidate.workflowRunId === runId && candidate.phase === "analysis");
    if (!task) throw new RepositoryError("INVALID_STATE");
    this.#assertWorkflowLease(workerId, task, leaseGeneration ?? task.leaseGeneration);
    const leaseExpiresAt = new Date(now.getTime() + boundedLease).toISOString();
    this.#runs.set(run.id, {
      ...run,
      leaseExpiresAt,
      updatedAt: now.toISOString()
    });
    this.#workflowTasks.set(task.id, { ...task, leaseExpiresAt, updatedAt: now.toISOString() });
    this.#appendWorkflowEvent(task.workflowRunId, "task.heartbeat", task.id);
  }

  async completeAnalysis(
    workerId: string,
    runId: string,
    result: AnalysisResult,
    leaseGeneration?: number,
  ): Promise<AnalysisRunRecord> {
    const workflow = this.#workflowRuns.get(runId);
    if (workflow?.cancelRequestedAt || workflow?.status === "cancelled") throw new RepositoryError("CANCELLED");
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= this.clock()) throw new RepositoryError("LEASE_LOST");
    const workflowTask = [...this.#workflowTasks.values()].find((candidate) => candidate.workflowRunId === runId && candidate.phase === "analysis");
    if (!workflowTask) throw new RepositoryError("INVALID_STATE");
    this.#assertWorkflowLease(workerId, workflowTask, leaseGeneration ?? workflowTask.leaseGeneration);
    if (result.capabilities.length > MAX_CAPABILITIES || result.evidence.length > MAX_CAPABILITIES
      || result.release !== undefined && Buffer.byteLength(result.release.code) > MAX_RELEASE_BYTES) {
      throw new RepositoryError("INVALID_STATE");
    }
    let canonicalPlans: readonly CapabilityPlan[];
    try {
      canonicalPlans = result.capabilities.length === 0
        ? []
        : canonicalizeCapabilityPlans(result.capabilities.map(({ plan }) => plan));
    } catch {
      throw new RepositoryError("INVALID_STATE");
    }
    const normalizedDiagnostics = normalizeAnalysisDiagnostics(result.diagnostics);
    if (canonicalPlans.length === 0) {
      if (normalizedDiagnostics.length === 0 || result.evidence.length === 0 || result.release !== undefined) {
        throw new RepositoryError("INVALID_STATE");
      }
    } else {
      if (result.release === undefined) throw new RepositoryError("INVALID_STATE");
      const sourcePlans = plansFromManifest(result.release.manifest);
      if (!sourcePlans || !equalPlanSets(sourcePlans, canonicalPlans)) throw new RepositoryError("INVALID_STATE");
    }
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
    const releaseCode = result.release === undefined ? undefined : Buffer.from(result.release.code);
    const normalizedResult: AnalysisResult = {
      ...structuredClone(result),
      capabilities: canonicalPlans.map((plan) => ({ plan, status: statuses.get(plan.tool.name) ?? "proposed" })),
      diagnostics: normalizedDiagnostics,
      evidence: normalizedEvidence,
      release: result.release === undefined || releaseCode === undefined ? undefined : {
        ...structuredClone(result.release),
        contentHash: createHash("sha256").update(releaseCode).digest("hex"),
        manifest: structuredClone(result.release.manifest ?? {})
      },
    };
    this.#results.set(run.id, normalizedResult);
    const insertedCapabilities: CapabilityRecord[] = [];
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
      insertedCapabilities.push(capability);
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
    const outputHash = stableHash(canonicalJson({
      diagnostics: normalizedDiagnostics,
      evidence: normalizedEvidence.map(({ reference }) => reference).sort(compareCodePoints),
      plans: insertedCapabilities.map(({ planDigest }) => planDigest).sort(compareCodePoints),
      release: normalizedResult.release?.contentHash,
    }));
    this.#workflowTasks.set(workflowTask.id, {
      ...workflowTask,
      status: "succeeded",
      outputHash,
      outputReference: normalizedResult.release
        ? `urn:sha256:${normalizedResult.release.contentHash}`
        : normalizedEvidence[0]?.reference,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      updatedAt: now,
    });
    const currentWorkflow = this.#workflowRuns.get(run.id);
    if (!currentWorkflow) throw new RepositoryError("INVALID_STATE");
    this.#workflowRuns.set(currentWorkflow.id, { ...currentWorkflow, status: "succeeded", errorCode: undefined, updatedAt: now });
    this.#workflowEvidence.set(run.id, normalizedEvidence.map((evidence) => ({
      id: randomUUID(),
      organizationId: run.organizationId,
      projectId: run.projectId,
      workflowRunId: run.id,
      taskId: workflowTask.id,
      evidenceId: evidence.id!,
      reference: evidence.reference,
      createdAt: now,
    })));
    this.#workflowCapabilityPlans.set(run.id, insertedCapabilities.map((capability) => ({
      id: randomUUID(),
      organizationId: run.organizationId,
      projectId: run.projectId,
      workflowRunId: run.id,
      taskId: workflowTask.id,
      capabilityId: capability.id,
      planDigest: capability.planDigest,
      createdAt: now,
    })));
    this.#appendWorkflowEvent(currentWorkflow.id, "task.completed", workflowTask.id);
    this.#appendWorkflowEvent(currentWorkflow.id, "workflow.completed");
    return copy(completed);
  }

  async failAnalysis(
    workerId: string,
    runId: string,
    code: string,
    retryable: boolean,
    leaseGeneration?: number,
  ): Promise<AnalysisRunRecord> {
    const workflow = this.#workflowRuns.get(runId);
    if (workflow?.cancelRequestedAt || workflow?.status === "cancelled") throw new RepositoryError("CANCELLED");
    const run = this.#runs.get(runId);
    if (!run || run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= this.clock()) throw new RepositoryError("LEASE_LOST");
    const workflowTask = [...this.#workflowTasks.values()].find((candidate) => candidate.workflowRunId === runId && candidate.phase === "analysis");
    if (!workflowTask) throw new RepositoryError("INVALID_STATE");
    this.#assertWorkflowLease(workerId, workflowTask, leaseGeneration ?? workflowTask.leaseGeneration);
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
    else this.#analysisAvailableAt.set(run.id, new Date(this.clock().getTime()
      + workflowRetryDelayMs(run.attempts, undefined, this.workflowOptions.random)).toISOString());
    if (terminal) {
      const project = this.#projects.get(run.projectId);
      if (project) this.#projects.set(project.id, { ...project, status: "failed" });
    }
    const availableAt = this.#analysisAvailableAt.get(run.id) ?? this.#now();
    this.#workflowTasks.set(workflowTask.id, {
      ...workflowTask,
      status: terminal ? "failed" : "queued",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryClassification: retryable ? "transient" : "permanent",
      errorCode: code.slice(0, 64),
      availableAt,
      updatedAt: this.#now(),
    });
    const currentWorkflow = this.#workflowRuns.get(run.id);
    if (!currentWorkflow) throw new RepositoryError("INVALID_STATE");
    this.#workflowRuns.set(currentWorkflow.id, {
      ...currentWorkflow,
      status: terminal ? "failed" : "queued",
      errorCode: code.slice(0, 64),
      updatedAt: this.#now(),
    });
    this.#appendWorkflowEvent(currentWorkflow.id, terminal ? "task.failed" : "task.retry_scheduled", workflowTask.id, code.slice(0, 64));
    if (terminal) this.#appendWorkflowEvent(currentWorkflow.id, "workflow.failed", undefined, code.slice(0, 64));
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
    if (input.action === "approve" && capability.riskTier === "R2" && actor.role !== "owner") {
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
    this.#personalOrganizations.clear();
    this.#memberships.clear();
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
    this.#projectSources.clear();
    this.#sourceSnapshots.clear();
    this.#workflowRuns.clear();
    this.#workflowTasks.clear();
    this.#workflowEvents.clear();
    this.#workflowEvidence.clear();
    this.#workflowCapabilityPlans.clear();
    this.#workflowCommands.clear();
    this.#waitTokens.clear();
    this.#organizationClaimOrder.clear();
    this.#claimSequence = 0;
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

type ProjectCursor = Readonly<{ createdAt: string; id: string }>;

function compareProjectPosition(project: ProjectRecord, cursor: ProjectCursor): number {
  return compareCodePoints(project.createdAt, cursor.createdAt) || compareCodePoints(project.id, cursor.id);
}

function encodeProjectCursor(project: ProjectRecord): string {
  return Buffer.from(JSON.stringify({ createdAt: project.createdAt, id: project.id })).toString("base64url");
}

function decodeProjectCursor(value: string): ProjectCursor {
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(value)) throw new RepositoryError("INVALID_CURSOR");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort(compareCodePoints).join(",") !== "createdAt,id") {
      throw new RepositoryError("INVALID_CURSOR");
    }
    const cursor = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))
      || typeof cursor.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) {
      throw new RepositoryError("INVALID_CURSOR");
    }
    return { createdAt: new Date(cursor.createdAt).toISOString(), id: cursor.id };
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("INVALID_CURSOR");
  }
}

function stableHash(value: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new RepositoryError("INVALID_STATE");
  }
  return /^[0-9a-f]{64}$/.test(value) ? value : createHash("sha256").update(value, "utf8").digest("hex");
}

function workflowTaskIdempotencyKey(runId: string, phase: WorkflowTaskRecord["phase"], inputHash: string): string {
  const normalizedHash = stableHash(inputHash);
  return `wft_${stableHash(`${runId.length}:${runId}:${phase.length}:${phase}:${normalizedHash}`)}`;
}

function sourceIdentityMaterial(sourceType: string, sourceUrl: string): string {
  return `${Buffer.byteLength(sourceType)}:${sourceType}:${Buffer.byteLength(sourceUrl)}:${sourceUrl}`;
}

function assertIdempotencyKey(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
}

function assertWorkerId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
}

function validateWorkflowReference(value: string | undefined): void {
  if (value !== undefined && !/^urn:sha256:[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
