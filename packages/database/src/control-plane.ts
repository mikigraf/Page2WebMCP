import { createHash, randomUUID } from "node:crypto";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../capability-ir/src/plan.ts";
import { validateTargetUrl } from "../../security/src/security.ts";
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
  type SourceConfiguration,
  type StartWorkflowInput,
  type WaitWorkflowTaskInput,
  type WorkflowCapabilityPlanLink,
  type WorkflowEventRecord,
  type WorkflowEventPayload,
  type WorkflowEventType,
  type WorkflowTaskEventInput,
  type WorkflowEvidenceLink,
  type WorkflowRepository,
  type WorkflowRunRecord,
  type WorkflowTaskCompletion,
  type WorkflowTaskRecord,
  type ImmutableSourceArtifactIdentity,
} from "./workflow.ts";
import { computeSourceIdentityHash } from "./source-identity.ts";

export type RepositoryRole = "owner" | "editor" | "viewer";
export type RepositoryActor = { id: string; organizationId: string; role: RepositoryRole };
export type AuthenticatedIdentity = { id: string; email?: string };
export type SourceType = "website" | "openapi" | "github";

export type ProviderProvenance =
  | Readonly<{ mode: "local"; adapter: "local-fixture"; adapterVersion: 1; fixture: true }>
  | Readonly<{ mode: "openapi"; adapter: "bounded-openapi"; adapterVersion: 1; fixture: false }>
  | Readonly<{ mode: "website"; adapter: "browser-use-v4"; adapterVersion: 4; fixture: false }>
  | Readonly<{ mode: "github"; adapter: "github-app"; adapterVersion: 20260310; fixture: false }>;

export type VerifierIdentityRecord = Readonly<{
  protocolVersion: 1 | 2;
  mode: "hermetic" | "local_live" | "live";
  webMcpImplementation: "native";
  verifierOriginDigest: string;
}>;

export type VerifierAttestationIdentityRecordV2 = Readonly<{
  protocolVersion: 2;
  attestationId: string;
  requestId: string;
  nonceDigest: string;
  operation: "candidate" | "installation";
  scopeDigest: string;
  payloadDigest: string;
  issuedAt: string;
  expiresAt: string;
  attestedAt: string;
}>;

export type CandidateVerificationObservation = Readonly<{
  observedContentHash: string;
  observedIntegrity: string;
  observedReleaseId: string;
  observedTargetOrigin: string;
  registeredTools: readonly string[];
  trustedLoader: Readonly<{ enforcedBeforeEvaluation: boolean; evaluatedContentHash: string }>;
  controlPlaneRequestsDuringExecution: number;
  modelRequestsDuringExecution: number;
  verifierAttestation?: VerifierAttestationIdentityRecordV2;
}>;

export type InstalledVerificationObservation = Readonly<{
  observedArtifactUrl: string;
  observedDownloadUrl: string;
  observedLocalOnly: boolean;
  observedIntegrity: string;
  executedArtifactUrl: string | null;
  servedContentHash: string;
  executedContentHash: string | null;
  observedTargetOrigin: string;
  registeredTools: readonly string[];
  webMcpImplementation: "native" | "compatibility_shim";
  normalPageLoad: boolean;
  routeInterception: boolean;
  injectedRegistration: boolean;
  syntheticHarness: boolean;
  duplicateLoadHarmless: boolean | null;
  executionEvidence: InstalledExecutionEvidence | null;
  csp: Readonly<{ hosted: "allowed" | "blocked"; directive?: string }>;
  verifierAttestation?: VerifierAttestationIdentityRecordV2;
}>;

export type InstalledExecutionEvidence = Readonly<{
  authenticatedRead: Readonly<{
    toolName: string;
    authenticated: true;
    succeeded: true;
  }>;
  confirmedReversibleMutation: Readonly<{
    toolName: string;
    confirmation: "explicit";
    reversible: true;
    succeeded: true;
    effectCount: 1;
  }>;
  authoritativeFinalState: Readonly<{
    mutationToolName: string;
    source: "target";
    verified: true;
  }>;
}>;

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
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: string;
  providerProvenance?: ProviderProvenance;
  createdAt: string;
  updatedAt: string;
};

export type WebsiteAuthenticationCheckpointState =
  | "waiting"
  | "consumed"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type WebsiteAuthenticationCheckpointRecord = Readonly<{
  organizationId: string;
  projectId: string;
  analysisRunId: string;
  workflowTaskId: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  checkpointReference: string;
  authenticationEvidenceReference?: string;
  state: WebsiteAuthenticationCheckpointState;
  expiresAt: string;
  consumedAt?: string;
  terminalAt?: string;
  cleanupStatus?: "pending" | "running" | "succeeded" | "failed";
  cleanupAttempts?: number;
  cleanupCompletedAt?: string;
  cleanupErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type WebsiteAuthenticationTtlSecretEvidence = Readonly<{
  purpose: "browser_cdp_url" | "browser_live_url";
  referenceDigest: string;
  expiresAt: string;
}>;

export type WebsiteAuthenticationSuspensionProjection = Readonly<{
  schemaVersion: 1;
  ownershipDecisionDigest: string;
  providerSessionIdentityDigest: string;
  browserUse: Readonly<{
    adapter: "browser-use-v4";
    adapterVersion: 4;
    apiVersion: "v4";
    model: "browser-use-2.0";
    policyDigest: string;
  }>;
  browserLease: Readonly<{ identityDigest: string; expiresAt: string }>;
  egressPolicy: Readonly<{ referenceDigest: string; policyDigest: string }>;
  cdpReferenceDigest: string;
  publicEvidenceReference: string;
  ttlSecrets: readonly WebsiteAuthenticationTtlSecretEvidence[];
  checkpoint: Readonly<{
    checkpointReference: string;
    sourceSnapshotId: string;
    sourceIdentityHash: string;
    targetOriginDigest: string;
    expiresAt: string;
  }>;
}>;

export type WebsiteAuthenticationSuspensionEvidence = Readonly<
  WebsiteAuthenticationSuspensionProjection & {
    suspendedWorkerIdentityDigest: string;
    suspendedLeaseGeneration: number;
  }
>;

export type WebsiteAuthenticationCleanupResourceKind =
  | "browser_session"
  | "browser_lease"
  | "egress_policy_proxy"
  | "ttl_secrets"
  | "authentication_handoff_checkpoint"
  | "evidence_lease"
  | "cdp_observation_lease";

export type WebsiteAuthenticationCleanupDisposition =
  | "pending"
  | "failed"
  | "revoked"
  | "released"
  | "reconciled"
  | "destroyed"
  | "retained_immutable";

export type WebsiteAuthenticationCleanupResourceEvidence = Readonly<{
  resource: WebsiteAuthenticationCleanupResourceKind;
  identityDigest: string;
  disposition: WebsiteAuthenticationCleanupDisposition;
  timestamp?: string;
  errorCode?: string;
}>;

export type WebsiteLiveReceiptEvidence = Readonly<WebsiteAuthenticationSuspensionEvidence & {
  authenticationEvidenceReferenceDigest?: string;
  authenticationConsumedAt?: string;
  resumedWorkerIdentityDigest?: string;
  resumeLeaseGeneration?: number;
  resumeClaimedAt?: string;
  resultCheckpointHash?: string;
  resultCheckpointOutputReference?: string;
  resultCheckpointWorkerIdentityDigest?: string;
  resultCheckpointLeaseGeneration?: number;
  resultCheckpointedAt?: string;
  completionWorkerIdentityDigest?: string;
  completionLeaseGeneration?: number;
  resumeAcknowledgedAt?: string;
  restartVerified: boolean;
  cleanupResources: readonly WebsiteAuthenticationCleanupResourceEvidence[];
}>;

export type WebsiteAuthenticationResultCheckpoint = Readonly<{
  resultHash: string;
  outputReference: string;
  leaseGeneration: number;
  checkpointedAt: string;
}>;

export type WebsiteAuthenticationCleanupTerminalState = Extract<
  WebsiteAuthenticationCheckpointState,
  "failed" | "cancelled" | "expired"
>;

export type ClaimedWebsiteAuthenticationCleanupRecord = Readonly<{
  organizationId: string;
  projectId: string;
  analysisRunId: string;
  workflowTaskId: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  sourceUrl: string;
  targetOriginDigest: string;
  checkpointReference: string;
  expiresAt: string;
  terminalState: WebsiteAuthenticationCleanupTerminalState;
  outcome: "failed" | "cancelled";
  cleanupIdempotencyKey: string;
  attempts: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  leaseGeneration: number;
  liveReceiptEvidence: WebsiteLiveReceiptEvidence;
}>;

export type WebsiteAuthenticationClaimCheckpoint = Readonly<{
  checkpointReference: string;
  authenticationEvidenceReference: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  expiresAt: string;
  resultCheckpoint?: WebsiteAuthenticationResultCheckpoint;
  liveReceiptEvidence?: WebsiteLiveReceiptEvidence;
}>;

type StoredWebsiteAuthenticationCheckpoint = WebsiteAuthenticationCheckpointRecord & Readonly<{
  waitIdempotencyKey: string;
  waitInputHash: string;
  resumeIdempotencyKey?: string;
  resumeInputHash?: string;
  cleanupStatus?: "pending" | "running" | "succeeded" | "failed";
  cleanupIdempotencyKey: string;
  cleanupAttempts: number;
  cleanupAvailableAt?: string;
  cleanupLeaseOwner?: string;
  cleanupLeaseExpiresAt?: string;
  cleanupLeaseGeneration: number;
  cleanupCompletedAt?: string;
  cleanupErrorCode?: string;
}>;

export type ClaimedAnalysisRunRecord = Readonly<AnalysisRunRecord & {
  sourceType: SourceType;
  sourceUrl: string;
  sourceConfiguration: SourceConfiguration;
  workflowTaskId: string;
  sourceSnapshotId: string;
  leaseGeneration: number;
  authenticationCheckpoint?: WebsiteAuthenticationClaimCheckpoint;
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
  disposition?: "completed";
  capabilities: Array<{ plan: CapabilityPlan; status: Pick<CapabilityRecord, "status">["status"] }>;
  diagnostics: AnalysisDiagnostic[];
  evidence: AnalysisEvidence[];
  release?: CandidateRelease;
  draftPullRequest?: { draft: boolean; url?: string; files?: string[] };
  providerProvenance?: ProviderProvenance;
  sourceArtifact?: ImmutableSourceArtifactIdentity;
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
  checks: ReleaseVerificationCheckRecord[];
  csp: { hosted: "allowed" | "blocked"; directive?: string };
  verificationMode: "live" | "local_live" | "hermetic";
  verifierIdentity?: VerifierIdentityRecord;
  observation?: CandidateVerificationObservation;
  eligible: boolean;
  failures: string[];
  createdAt: string;
};

export const RELEASE_VERIFICATION_CHECK_NAMES = [
  "authentication",
  "cancellation",
  "confirmation",
  "final_state",
  "no_control_plane_or_model_calls",
  "origin",
  "read",
  "replay_idempotency",
  "reversible_mutation",
  "schema",
  "secret_leakage",
  "tool_selection",
  "trusted_loader",
] as const;

export type ReleaseVerificationCheckName = typeof RELEASE_VERIFICATION_CHECK_NAMES[number];
export type ReleaseVerificationFailureCode =
  | "LOGGED_OUT"
  | "FORBIDDEN"
  | "STALE_PAGE"
  | "DEADLINE_EXCEEDED"
  | "INVALID_OUTPUT"
  | "WRONG_STATE"
  | "DUPLICATE_REGISTRATION"
  | "ORIGIN_MISMATCH"
  | "WEBMCP_UNAVAILABLE"
  | "TRUSTED_LOADER_REQUIRED"
  | "SECRET_LEAKAGE"
  | "CONTROL_PLANE_REQUEST"
  | "MODEL_REQUEST"
  | "CANCELLED";

export type ReleaseVerificationCheckRecord = {
  name: ReleaseVerificationCheckName;
  status: "passed" | "failed";
  code?: ReleaseVerificationFailureCode;
};

export type ReleaseArtifactIdentity =
  | Readonly<{ artifactUrl: string; downloadUrl: string; localOnly: boolean }>
  | Readonly<{ artifactUrl?: undefined; downloadUrl?: undefined; localOnly?: undefined }>;

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
  verificationRunId?: string;
  status: "published";
  createdAt: string;
} & ReleaseArtifactIdentity;

export type PublishedReleaseState = Readonly<{
  release: ReleaseRecord;
  verification: VerificationRecord;
}>;

export type ReleaseInstallationRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  releaseId: string;
  actorId: string;
  pageUrl: string;
  artifactUrl: string;
  downloadUrl: string;
  localOnly: boolean;
  selfHostedUrl?: string;
  targetOrigin: string;
  artifactContentHash: string;
  integrity: string;
  expectedTools: string[];
  status: "pending_self_host" | "verified" | "failed";
  delivery: "hosted" | "self_hosted";
  csp: { hosted: "allowed" | "blocked"; directive?: string };
  webMcpImplementation: "native" | "compatibility_shim";
  verifierIdentity?: VerifierIdentityRecord;
  attestation: InstalledVerificationObservation;
  idempotencyKey: string;
  inputHash: string;
  createdAt: string;
  verifiedAt?: string;
};

export type ReleaseInstallationRequest = Omit<ReleaseInstallationRecord,
  "id" | "organizationId" | "projectId" | "actorId" | "createdAt" | "verifiedAt" | "verifierIdentity">
  & Readonly<{ verifierIdentity: VerifierIdentityRecord }>;

export type GitHubDraftPullRequestRecord = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  workflowRunId: string;
  taskId: string;
  analysisRunId: string;
  sourceSnapshotId: string;
  projectSourceId: string;
  phase: "publish" | "install_verify";
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  requestedRef: string;
  baseCommitSha: string;
  patchDigest: string;
  branch: string;
  number: number;
  url: string;
  headCommitSha: string;
  draft: true;
  merged: false;
  check: Readonly<{
    externalId: string;
    status: "queued" | "in_progress" | "completed";
    conclusion?: "action_required" | "cancelled" | "failure" | "neutral" | "success" | "skipped" | "stale" | "timed_out";
  }>;
  sandboxReference: string;
  previewReference?: string;
  sideEffectIdempotencyKey: string;
  sideEffectInputHash: string;
  outputHash: string;
  outputReference: string;
  createdAt: string;
}>;

export type SaveGitHubDraftPullRequestRequest = Omit<GitHubDraftPullRequestRecord,
  "id" | "organizationId" | "projectId" | "taskId" | "sourceSnapshotId" | "projectSourceId"
  | "phase" | "url" | "createdAt">;

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
export type WaitAnalysisForAuthenticationInput = IdempotencyInput & Readonly<{
  checkpointReference: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  expiresAt: string;
  suspensionEvidence: WebsiteAuthenticationSuspensionEvidence;
}>;
export type ResumeAnalysisAfterAuthenticationInput = IdempotencyInput & Readonly<{
  runId: string;
  checkpointReference: string;
  authenticationEvidenceReference: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
}>;
export type TerminateAnalysisAuthenticationInput = IdempotencyInput & Readonly<{
  runId: string;
  checkpointReference: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  expiresAt: string;
  terminalState: "failed" | "expired";
}>;
export type ExpectedAnalysisSource = Readonly<{
  projectSourceId: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
}>;
export type EnqueueAnalysisRequest = IdempotentRequest & Readonly<{
  expectedSource?: ExpectedAnalysisSource;
}>;
export type CreateProjectRequest = {
  name: string;
  sourceType: SourceType;
  url: string;
  sourceConfiguration?: SourceConfiguration;
} & IdempotencyInput;
export type ProjectPageRequest = Readonly<{ limit?: number; cursor?: string }>;
export type ProjectPage = Readonly<{ projects: ProjectRecord[]; nextCursor?: string }>;
export type IdempotentRequest = { projectId: string } & IdempotencyInput;
export type VerificationRequest = Omit<
  VerificationRecord,
  "id" | "projectId" | "candidateContentHash" | "eligible" | "failures" | "createdAt" | "verifierIdentity" | "observation"
> & { candidate: CandidateRelease; verifierIdentity: VerifierIdentityRecord; observation: CandidateVerificationObservation };
export type PublishRequest = IdempotentRequest & {
  analysisRunId: string;
  capabilityStateDigest: string;
  candidateContentHash: string;
  verificationRunId: string;
} & Extract<ReleaseArtifactIdentity, { artifactUrl: string }>;

export type RepositoryErrorCode =
  | "FORBIDDEN"
  // The connected login cannot assume the role its execution context requires:
  // a deployment misconfiguration, never a per-request authorization outcome.
  | "DATABASE_ROLE_FORBIDDEN"
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
  | "SESSION_REVOKED"
  | "SOURCE_SNAPSHOT_STALE"
  | "OPENAPI_VERIFICATION_CONTEXT_REQUIRED";

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
  getActiveProjectSource(actor: RepositoryActor, projectId: string): Promise<ProjectSourceRecord>;
  getLatestAnalysis(actor: RepositoryActor, projectId: string): Promise<AnalysisRunRecord | undefined>;
  getAnalysisReplay(actor: RepositoryActor, input: IdempotentRequest): Promise<AnalysisRunRecord | undefined>;
  enqueueAnalysis(actor: RepositoryActor, input: EnqueueAnalysisRequest): Promise<AnalysisRunRecord>;
  getAnalysis(actor: RepositoryActor, id: string): Promise<AnalysisRunRecord>;
  claimAnalysis(
    workerId: string,
    leaseMs: number,
    sourceTypes?: readonly SourceType[],
  ): Promise<ClaimedAnalysisRunRecord | undefined>;
  heartbeatAnalysis(workerId: string, runId: string, leaseMs: number, leaseGeneration?: number): Promise<void>;
  waitAnalysisForAuthentication(
    workerId: string,
    runId: string,
    input: WaitAnalysisForAuthenticationInput,
    leaseGeneration?: number,
  ): Promise<WebsiteAuthenticationCheckpointRecord>;
  getWebsiteAuthenticationWait(
    actor: RepositoryActor,
    runId: string,
  ): Promise<WebsiteAuthenticationCheckpointRecord | undefined>;
  resumeAnalysisAfterAuthentication(
    actor: RepositoryActor,
    input: ResumeAnalysisAfterAuthenticationInput,
  ): Promise<WebsiteAuthenticationCheckpointRecord>;
  terminateAnalysisAuthentication(
    actor: RepositoryActor,
    input: TerminateAnalysisAuthenticationInput,
  ): Promise<WebsiteAuthenticationCheckpointRecord>;
  claimWebsiteAuthenticationCleanup(
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedWebsiteAuthenticationCleanupRecord | undefined>;
  completeWebsiteAuthenticationCleanup(
    workerId: string,
    runId: string,
    leaseGeneration: number,
    resourceUpdates?: readonly WebsiteAuthenticationCleanupResourceEvidence[],
  ): Promise<void>;
  retryWebsiteAuthenticationCleanup(
    workerId: string,
    runId: string,
    leaseGeneration: number,
    errorCode: string,
    retryable?: boolean,
    resourceUpdates?: readonly WebsiteAuthenticationCleanupResourceEvidence[],
  ): Promise<void>;
  checkpointWebsiteAuthenticationResult(
    workerId: string,
    runId: string,
    result: AnalysisResult,
    leaseGeneration: number,
  ): Promise<WebsiteAuthenticationResultCheckpoint>;
  completeCheckpointedWebsiteAuthenticationAnalysis(
    workerId: string,
    runId: string,
    resultHash: string,
    leaseGeneration: number,
    resourceUpdates?: readonly WebsiteAuthenticationCleanupResourceEvidence[],
  ): Promise<AnalysisRunRecord>;
  completeAnalysis(workerId: string, runId: string, result: AnalysisResult, leaseGeneration?: number): Promise<AnalysisRunRecord>;
  failAnalysis(workerId: string, runId: string, code: string, retryable: boolean, leaseGeneration?: number): Promise<AnalysisRunRecord>;
  getAnalysisResult(actor: RepositoryActor, runId: string): Promise<AnalysisResult | undefined>;
  getLatestReviewedWorkflowForAnalysis(
    actor: RepositoryActor,
    projectId: string,
    analysisRunId: string,
  ): Promise<WorkflowRunRecord | undefined>;
  getWorkflowExecutionMaterial(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<WorkflowExecutionMaterial>;
  getGitHubDraftPullRequestForTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<GitHubDraftPullRequestRecord | undefined>;
  saveGitHubDraftPullRequest(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: SaveGitHubDraftPullRequestRequest,
  ): Promise<GitHubDraftPullRequestRecord>;
  getLatestGitHubDraftPullRequest(
    actor: RepositoryActor,
    workflowRunId: string,
  ): Promise<GitHubDraftPullRequestRecord | undefined>;
  getLatestGitHubDraftPullRequestForProject(
    actor: RepositoryActor,
    projectId: string,
  ): Promise<GitHubDraftPullRequestRecord | undefined>;
  listCapabilities(actor: RepositoryActor, projectId: string): Promise<CapabilityRecord[]>;
  listAnalysisCapabilities(actor: RepositoryActor, runId: string): Promise<CapabilityRecord[]>;
  reviewCapability(actor: RepositoryActor, capabilityId: string, input: ReviewInput): Promise<CapabilityRecord>;
  saveVerification(actor: RepositoryActor, projectId: string, input: VerificationRequest): Promise<VerificationRecord>;
  publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord>;
  getRelease(actor: RepositoryActor, projectId: string, releaseId: string): Promise<ReleaseRecord>;
  getLatestPublishedRelease(actor: RepositoryActor, projectId: string): Promise<PublishedReleaseState | undefined>;
  getPreviousRelease(actor: RepositoryActor, projectId: string, releaseId: string): Promise<ReleaseRecord | undefined>;
  saveReleaseInstallation(actor: RepositoryActor, projectId: string,
    input: ReleaseInstallationRequest): Promise<ReleaseInstallationRecord>;
  getLatestReleaseInstallation(actor: RepositoryActor, projectId: string,
    releaseId: string): Promise<ReleaseInstallationRecord | undefined>;
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

type LegacyUnconfiguredSourceConfiguration = Readonly<{ kind: "legacy_unconfigured" }>;
type StoredSourceConfiguration = SourceConfiguration | LegacyUnconfiguredSourceConfiguration;

const SOURCE_CONFIGURATION_KEYS = new Map<string, readonly string[]>([
  ["website", ["kind"]],
  ["github", ["kind"]],
  ["openapi", ["kind", "targetOrigin", "testPageUrl", "environment"]],
  ["legacy_unconfigured", ["kind"]],
]);

export function normalizeSourceConfiguration(
  sourceType: SourceType,
  value: SourceConfiguration | undefined,
): SourceConfiguration {
  if (value === undefined) {
    if (sourceType === "openapi") throw new RepositoryError("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
    return { kind: sourceType };
  }
  return parseSourceConfiguration(value, sourceType);
}

export function parsePersistedSourceConfiguration(sourceType: SourceType, value: unknown): SourceConfiguration {
  return parseSourceConfiguration(value, sourceType);
}

function parseStoredSourceConfiguration(value: unknown): StoredSourceConfiguration {
  if (!isPlainRecord(value) || typeof value.kind !== "string") throw new RepositoryError("INVALID_STATE");
  const expectedKeys = SOURCE_CONFIGURATION_KEYS.get(value.kind);
  if (!expectedKeys || Object.keys(value).length !== expectedKeys.length
    || Object.keys(value).some((key) => !expectedKeys.includes(key))) {
    throw new RepositoryError("INVALID_STATE");
  }
  if (value.kind === "website" || value.kind === "github" || value.kind === "legacy_unconfigured") {
    return { kind: value.kind };
  }
  if (typeof value.targetOrigin !== "string" || typeof value.testPageUrl !== "string"
    || !["test", "staging", "production"].includes(String(value.environment))) {
    throw new RepositoryError("INVALID_STATE");
  }
  const targetOrigin = canonicalHttpsOrigin(value.targetOrigin);
  const testPageUrl = canonicalHttpsUrl(value.testPageUrl);
  if (new URL(testPageUrl).origin !== targetOrigin) throw new RepositoryError("INVALID_STATE");
  return { kind: "openapi", targetOrigin, testPageUrl, environment: value.environment as "test" | "staging" | "production" };
}

function parseSourceConfiguration(value: unknown, sourceType: SourceType): SourceConfiguration {
  let parsed: StoredSourceConfiguration;
  try {
    parsed = parseStoredSourceConfiguration(value);
  } catch (error) {
    if (sourceType === "openapi") throw new RepositoryError("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
    throw error;
  }
  if (parsed.kind === "legacy_unconfigured") {
    if (sourceType === "website" || sourceType === "github") return { kind: sourceType };
    throw new RepositoryError("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
  }
  if (parsed.kind !== sourceType) {
    if (sourceType === "openapi") throw new RepositoryError("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
    throw new RepositoryError("INVALID_STATE");
  }
  return parsed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalHttpsOrigin(value: string): string {
  if (!validateTargetUrl(value).ok) throw new RepositoryError("INVALID_STATE");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryError("INVALID_STATE");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash) throw new RepositoryError("INVALID_STATE");
  return url.origin;
}

function canonicalHttpsUrl(value: string): string {
  if (!validateTargetUrl(value).ok) throw new RepositoryError("INVALID_STATE");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryError("INVALID_STATE");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RepositoryError("INVALID_STATE");
  }
  return url.toString();
}

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

export type LiveCandidateVerifierScopeBinding = Readonly<{
  projectId: string;
  analysisRunId: string;
  sourceIdentityHash: string;
  targetOrigin: string;
  environment: "test" | "staging" | "production";
  contentHash: string;
}>;

export type LiveInstallationVerifierScopeBinding = Readonly<{
  projectId: string;
  releaseId: string;
  installationOperationId: string;
  sourceIdentityHash: string;
  pageUrl: string;
  targetOrigin: string;
  environment: "test" | "staging" | "production";
  selectedHash: string;
}>;

const STRICT_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRICT_SHA256 = /^[0-9a-f]{64}$/;
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function normalizeVerifierAttestationIdentity(
  value: VerifierAttestationIdentityRecordV2,
  operation: VerifierAttestationIdentityRecordV2["operation"],
): VerifierAttestationIdentityRecordV2 {
  if (!plainRecordWithKeys(value, [
    "attestationId", "attestedAt", "expiresAt", "issuedAt", "nonceDigest", "operation",
    "payloadDigest", "protocolVersion", "requestId", "scopeDigest",
  ]) || value.protocolVersion !== 2 || value.operation !== operation
    || !STRICT_UUID_V4.test(value.attestationId) || !STRICT_UUID_V4.test(value.requestId)
    || !STRICT_SHA256.test(value.nonceDigest) || !STRICT_SHA256.test(value.scopeDigest)
    || !STRICT_SHA256.test(value.payloadDigest)
    || !exactVerifierTimestamp(value.issuedAt) || !exactVerifierTimestamp(value.expiresAt)
    || !exactVerifierTimestamp(value.attestedAt)
    || Date.parse(value.issuedAt) >= Date.parse(value.expiresAt)
    || Date.parse(value.attestedAt) < Date.parse(value.issuedAt)
    || Date.parse(value.attestedAt) >= Date.parse(value.expiresAt)
    || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > 120_000) {
    throw new RepositoryError("INVALID_STATE", ["VERIFIER_ATTESTATION_INVALID"]);
  }
  return copy(value);
}

export function liveCandidateVerifierScopeDigest(binding: LiveCandidateVerifierScopeBinding): string {
  if (!binding || !STRICT_UUID_V4.test(binding.projectId) || !STRICT_UUID_V4.test(binding.analysisRunId)
    || !STRICT_SHA256.test(binding.sourceIdentityHash) || !STRICT_SHA256.test(binding.contentHash)
    || !["test", "staging", "production"].includes(binding.environment)
    || canonicalHttpsOrigin(binding.targetOrigin) !== binding.targetOrigin) {
    throw new RepositoryError("INVALID_STATE", ["VERIFIER_SCOPE_INVALID"]);
  }
  return createHash("sha256").update(canonicalJson({
    operation: "candidate",
    ...binding,
  }), "utf8").digest("hex");
}

export function liveInstallationVerifierScopeDigest(binding: LiveInstallationVerifierScopeBinding): string {
  let page: URL;
  try { page = new URL(binding.pageUrl); }
  catch { throw new RepositoryError("INVALID_STATE", ["VERIFIER_SCOPE_INVALID"]); }
  if (!STRICT_UUID_V4.test(binding.projectId) || !STRICT_UUID_V4.test(binding.releaseId)
    || !STRICT_SHA256.test(binding.installationOperationId)
    || !STRICT_SHA256.test(binding.sourceIdentityHash) || !STRICT_SHA256.test(binding.selectedHash)
    || !["test", "staging", "production"].includes(binding.environment)
    || canonicalHttpsOrigin(binding.targetOrigin) !== binding.targetOrigin
    || page.protocol !== "https:" || page.origin !== binding.targetOrigin || page.username || page.password
    || page.search || page.hash || page.toString() !== binding.pageUrl) {
    throw new RepositoryError("INVALID_STATE", ["VERIFIER_SCOPE_INVALID"]);
  }
  return createHash("sha256").update(canonicalJson({
    operation: "installation",
    ...binding,
  }), "utf8").digest("hex");
}

export function deriveInstallationOperationId(input: Readonly<{
  projectId: string;
  releaseId: string;
  idempotencyKey: string;
  inputHash: string;
}>): string {
  if (!input || !STRICT_UUID_V4.test(input.projectId) || !STRICT_UUID_V4.test(input.releaseId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    || !STRICT_SHA256.test(input.inputHash)) throw new RepositoryError("INVALID_STATE");
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

export function verifierEnvironmentForSource(
  configuration: SourceConfiguration,
): "test" | "staging" | "production" {
  return configuration.kind === "openapi" ? configuration.environment : "production";
}

export function candidateVerifierScopeMatches(
  input: VerificationRequest,
  projectId: string,
  sourceIdentityHash: string,
  sourceConfiguration: SourceConfiguration,
): boolean {
  if (input.verificationMode !== "live") return input.observation.verifierAttestation === undefined;
  try {
    const attestation = normalizeVerifierAttestationIdentity(input.observation.verifierAttestation!, "candidate");
    return attestation.scopeDigest === liveCandidateVerifierScopeDigest({
      projectId,
      analysisRunId: input.analysisRunId,
      sourceIdentityHash,
      targetOrigin: input.candidate.allowedOrigin,
      environment: verifierEnvironmentForSource(sourceConfiguration),
      contentHash: input.candidate.contentHash,
    });
  } catch { return false; }
}

export function installationVerifierScopeMatches(
  input: ReleaseInstallationRequest,
  projectId: string,
  sourceIdentityHash: string,
  sourceConfiguration: SourceConfiguration,
): boolean {
  if (input.verifierIdentity.mode !== "live") return input.attestation.verifierAttestation === undefined;
  try {
    const attestation = normalizeVerifierAttestationIdentity(input.attestation.verifierAttestation!, "installation");
    const installationOperationId = deriveInstallationOperationId({
      projectId,
      releaseId: input.releaseId,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
    });
    return attestation.scopeDigest === liveInstallationVerifierScopeDigest({
      projectId,
      releaseId: input.releaseId,
      installationOperationId,
      sourceIdentityHash,
      pageUrl: input.pageUrl,
      targetOrigin: input.targetOrigin,
      environment: verifierEnvironmentForSource(sourceConfiguration),
      selectedHash: input.artifactContentHash,
    });
  } catch { return false; }
}

function exactVerifierTimestamp(value: string): boolean {
  return STRICT_TIMESTAMP.test(value) && new Date(value).toISOString() === value;
}

export function releaseFailures(input: VerificationRequest): string[] {
  const typedFailures = verificationCheckFailures(input.checks);
  if (typedFailures.includes("VERIFICATION_REPORT_INVALID") || !verificationSummaryMatches(input)
    || !candidateObservationMatches(input)) {
    return ["VERIFICATION_REPORT_INVALID"];
  }
  return [...new Set(typedFailures)].sort(compareCodePoints);
}

function verificationSummaryMatches(input: VerificationRequest): boolean {
  const passed = new Set(input.checks.filter(({ status }) => status === "passed").map(({ name }) => name));
  const expectedProtocolVersion = input.verificationMode === "live" ? 2 : 1;
  return (input.verificationMode === "live" || input.verificationMode === "local_live"
      || input.verificationMode === "hermetic")
    && input.verifierIdentity.mode === input.verificationMode
    && input.verifierIdentity.protocolVersion === expectedProtocolVersion
    && input.verifierIdentity.webMcpImplementation === "native"
    && /^[0-9a-f]{64}$/.test(input.verifierIdentity.verifierOriginDigest)
    && (input.csp.hosted === "allowed" || input.csp.hosted === "blocked")
    && (input.csp.directive === undefined || input.csp.directive.length <= 512 && !/[\r\n]/.test(input.csp.directive))
    && input.schema === (passed.has("schema") && passed.has("trusted_loader"))
    && input.authenticated === (passed.has("authentication") && passed.has("origin"))
    && input.replayPasses === (passed.has("replay_idempotency") ? 3 : 0)
    && input.noSecretLeakage === (passed.has("secret_leakage") && passed.has("no_control_plane_or_model_calls"))
    && input.browserExecution === (passed.size === RELEASE_VERIFICATION_CHECK_NAMES.length)
    && input.selectionScore === (passed.has("tool_selection") ? 20 : 0);
}

export function normalizeProviderProvenance(
  value: ProviderProvenance,
  sourceType: SourceType,
): ProviderProvenance {
  if (!isPlainRecord(value) || Object.keys(value).sort(compareCodePoints).join(",")
    !== "adapter,adapterVersion,fixture,mode") throw new RepositoryError("INVALID_STATE");
  const exact = value.mode === "local"
    ? value.adapter === "local-fixture" && value.adapterVersion === 1 && value.fixture === true
    : value.mode === "openapi"
      ? value.adapter === "bounded-openapi" && value.adapterVersion === 1 && value.fixture === false
      : value.mode === "website"
        ? value.adapter === "browser-use-v4" && value.adapterVersion === 4 && value.fixture === false
        : value.mode === "github" && value.adapter === "github-app"
          && value.adapterVersion === 20260310 && value.fixture === false;
  if (!exact || value.mode !== "local" && value.mode !== sourceType) throw new RepositoryError("INVALID_STATE");
  return copy(value);
}

const OPENAPI_SOURCE_MIME_TYPES = new Set([
  "application/json",
  "application/openapi+json",
  "application/vnd.oai.openapi+json",
  "application/yaml",
  "application/x-yaml",
  "text/yaml",
  "application/vnd.oai.openapi",
  "application/vnd.oai.openapi+yaml",
]);

export function normalizeImmutableSourceArtifactIdentity(
  value: ImmutableSourceArtifactIdentity,
): ImmutableSourceArtifactIdentity {
  if (!isPlainRecord(value) || Object.keys(value).sort(compareCodePoints).join(",")
      !== "artifactReference,contentHash,finalUrl,mimeType,sizeBytes"
    || typeof value.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(value.contentHash)
    || value.artifactReference !== `urn:sha256:${value.contentHash}`
    || typeof value.finalUrl !== "string" || value.finalUrl.length > 4_096
    || canonicalHttpsUrl(value.finalUrl) !== value.finalUrl
    || typeof value.mimeType !== "string" || !OPENAPI_SOURCE_MIME_TYPES.has(value.mimeType)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > 1_000_000) {
    throw new RepositoryError("INVALID_STATE");
  }
  return copy(value);
}

export function normalizeAnalysisSourceArtifact(
  sourceArtifact: ImmutableSourceArtifactIdentity | undefined,
  provenance: ProviderProvenance | undefined,
  evidence: readonly AnalysisEvidence[],
  sourceType: SourceType,
): ImmutableSourceArtifactIdentity | undefined {
  if (sourceType !== "openapi" || provenance !== undefined && provenance.mode !== "openapi") {
    if (sourceArtifact !== undefined) throw new RepositoryError("INVALID_STATE");
    return undefined;
  }
  if (sourceArtifact === undefined) {
    if (provenance?.mode === "openapi") throw new RepositoryError("INVALID_STATE");
    return undefined;
  }
  const normalized = normalizeImmutableSourceArtifactIdentity(sourceArtifact);
  const matchingEvidence = evidence.some((item) => {
    if (item.source !== "openapi") return false;
    try {
      const content = JSON.parse(item.content) as unknown;
      return isPlainRecord(content) && content.sourceDigest === normalized.artifactReference;
    } catch { return false; }
  });
  if (!matchingEvidence) throw new RepositoryError("INVALID_STATE");
  return normalized;
}

export function normalizePersistedAnalysisSourceArtifact(
  sourceArtifact: ImmutableSourceArtifactIdentity | undefined,
  provenance: ProviderProvenance | undefined,
  sourceSnapshotArtifact: ImmutableSourceArtifactIdentity | undefined,
): ImmutableSourceArtifactIdentity | undefined {
  if (provenance !== undefined && provenance.mode !== "openapi") {
    if (sourceArtifact !== undefined) throw new RepositoryError("INVALID_STATE");
    return undefined;
  }
  if (sourceArtifact === undefined) {
    if (provenance?.mode === "openapi") throw new RepositoryError("INVALID_STATE");
    return undefined;
  }
  const normalized = normalizeImmutableSourceArtifactIdentity(sourceArtifact);
  let frozen: ImmutableSourceArtifactIdentity;
  try {
    if (sourceSnapshotArtifact === undefined) throw new Error("missing frozen source identity");
    frozen = normalizeImmutableSourceArtifactIdentity(sourceSnapshotArtifact);
  } catch {
    throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
  }
  if (canonicalJson(normalized) !== canonicalJson(frozen)) {
    throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
  }
  return normalized;
}

function candidateObservationMatches(input: VerificationRequest): boolean {
  const observation = input.observation;
  const manifest = input.candidate.manifest;
  const plans = plansFromManifest(manifest);
  const releaseId = isPlainRecord(manifest) && typeof manifest.releaseId === "string" ? manifest.releaseId : undefined;
  const expectedTools = plans?.map(({ tool }) => tool.name).sort(compareCodePoints);
  const integrity = `sha384-${createHash("sha384").update(input.candidate.code).digest("base64")}`;
  const expectedKeys = [
    "controlPlaneRequestsDuringExecution", "modelRequestsDuringExecution", "observedContentHash",
    "observedIntegrity", "observedReleaseId", "observedTargetOrigin", "registeredTools", "trustedLoader",
    ...(input.verificationMode === "live" ? ["verifierAttestation"] : []),
  ].sort(compareCodePoints).join(",");
  let verifierAttestation: VerifierAttestationIdentityRecordV2 | undefined;
  try {
    verifierAttestation = input.verificationMode === "live"
      ? normalizeVerifierAttestationIdentity(input.observation.verifierAttestation!, "candidate")
      : undefined;
  } catch { return false; }
  const expectedPayloadDigest = createHash("sha256").update(canonicalJson({
    code: input.candidate.code,
    contentHash: input.candidate.contentHash,
    expectedTools,
    integrity,
    manifest: input.candidate.manifest,
    targetOrigin: input.candidate.allowedOrigin,
  }), "utf8").digest("hex");
  return isPlainRecord(observation)
    && Object.keys(observation).sort(compareCodePoints).join(",") === expectedKeys
    && observation.observedContentHash === input.candidate.contentHash
    && observation.observedIntegrity === integrity
    && observation.observedReleaseId === releaseId
    && observation.observedTargetOrigin === input.candidate.allowedOrigin
    && expectedTools !== undefined && equalStringArrays(observation.registeredTools, expectedTools)
    && isPlainRecord(observation.trustedLoader)
    && observation.trustedLoader.enforcedBeforeEvaluation === true
    && observation.trustedLoader.evaluatedContentHash === input.candidate.contentHash
    && observation.controlPlaneRequestsDuringExecution === 0
    && observation.modelRequestsDuringExecution === 0
    && (input.verificationMode !== "live" || verifierAttestation?.payloadDigest === expectedPayloadDigest);
}

export function verificationCheckFailures(checks: readonly ReleaseVerificationCheckRecord[]): string[] {
  if (!Array.isArray(checks) || checks.length !== RELEASE_VERIFICATION_CHECK_NAMES.length) {
    return ["VERIFICATION_REPORT_INVALID"];
  }
  const expected = new Set<string>(RELEASE_VERIFICATION_CHECK_NAMES);
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const check of checks) {
    if (!check || !expected.has(check.name) || seen.has(check.name)
      || check.status === "passed" && check.code !== undefined
      || check.status === "failed" && !check.code) return ["VERIFICATION_REPORT_INVALID"];
    seen.add(check.name);
    if (check.status === "failed") failures.push(check.code!);
  }
  return failures.sort(compareCodePoints);
}

export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  readonly #personalOrganizations = new Map<string, { id: string; name: string }>();
  readonly #memberships = new Map<string, RepositoryActor>();
  readonly #projects = new Map<string, ProjectRecord>();
  readonly #runs = new Map<string, AnalysisRunRecord>();
  readonly #results = new Map<string, AnalysisResult>();
  readonly #capabilities = new Map<string, CapabilityRecord>();
  readonly #verifications = new Map<string, VerificationRecord>();
  readonly #verificationIdsByRun = new Map<string, string[]>();
  readonly #verificationCandidates = new Map<string, CandidateRelease>();
  readonly #releases = new Map<string, ReleaseRecord>();
  readonly #releaseByHash = new Map<string, string[]>();
  readonly #releaseByRun = new Map<string, string>();
  readonly #releaseInstallations = new Map<string, ReleaseInstallationRecord>();
  readonly #gitHubDraftPullRequests = new Map<string, GitHubDraftPullRequestRecord>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #analysisAvailableAt = new Map<string, string>();
  readonly #websiteAuthenticationCheckpoints = new Map<string, StoredWebsiteAuthenticationCheckpoint>();
  readonly #websiteLiveReceiptEvidence = new Map<string, WebsiteLiveReceiptEvidence>();
  readonly #analysisSources = new Map<string, Readonly<{
    sourceType: SourceType;
    sourceUrl: string;
    sourceConfiguration: SourceConfiguration;
  }>>();
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

  #closeWebsiteAuthenticationCheckpoint(
    runId: string,
    state: Extract<WebsiteAuthenticationCheckpointState, "completed" | "failed" | "cancelled" | "expired">,
    at: string,
  ): void {
    const checkpoint = this.#websiteAuthenticationCheckpoints.get(runId);
    if (!checkpoint || !["waiting", "consumed"].includes(checkpoint.state)) return;
    this.#websiteAuthenticationCheckpoints.set(runId, {
      ...checkpoint,
      state,
      terminalAt: at,
      cleanupStatus: state === "completed" ? "succeeded" : "pending",
      cleanupAvailableAt: state === "completed" ? undefined : at,
      cleanupLeaseOwner: undefined,
      cleanupLeaseExpiresAt: undefined,
      cleanupCompletedAt: state === "completed" ? at : undefined,
      cleanupErrorCode: undefined,
      updatedAt: at,
    });
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

  #idempotencyId(operation: "project" | "analysis" | "release" | "installation" | "workflow",
    actor: RepositoryActor, key: string): string {
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
    payload?: WorkflowEventPayload,
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
      ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
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
    const sourceConfiguration = normalizeSourceConfiguration(input.sourceType, input.sourceConfiguration);
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
      sourceConfiguration,
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
      sourceIdentityHash: computeSourceIdentityHash(project.sourceType, project.url, sourceConfiguration),
      isFixture: false,
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

  async getActiveProjectSource(actor: RepositoryActor, projectId: string): Promise<ProjectSourceRecord> {
    this.#assertProject(actor, projectId);
    const source = [...this.#projectSources.values()].find((candidate) =>
      candidate.projectId === projectId && candidate.organizationId === actor.organizationId && candidate.active);
    if (!source) throw new RepositoryError("NOT_FOUND");
    return copy(source);
  }

  async getLatestAnalysis(actor: RepositoryActor, projectId: string): Promise<AnalysisRunRecord | undefined> {
    this.#assertProject(actor, projectId);
    const run = [...this.#runs.values()]
      .filter((candidate) => candidate.projectId === projectId && candidate.organizationId === actor.organizationId)
      .sort((left, right) => compareCodePoints(right.createdAt, left.createdAt) || compareCodePoints(right.id, left.id))[0];
    return run ? copy(run) : undefined;
  }

  async getAnalysisReplay(actor: RepositoryActor, input: IdempotentRequest): Promise<AnalysisRunRecord | undefined> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const project = this.#assertProject(actor, input.projectId);
    const previous = this.#idempotentReplay(
      this.#idempotencyId("analysis", actor, input.idempotencyKey),
      input.inputHash,
    );
    if (!previous) return undefined;
    const run = this.#runs.get(previous.resultId);
    if (!run || run.organizationId !== actor.organizationId || run.projectId !== project.id) {
      throw new RepositoryError("INVALID_STATE");
    }
    return copy(run);
  }

  async enqueueAnalysis(actor: RepositoryActor, input: EnqueueAnalysisRequest): Promise<AnalysisRunRecord> {
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
    const source = [...this.#projectSources.values()].find((candidate) =>
      candidate.projectId === project.id && candidate.organizationId === actor.organizationId && candidate.active);
    const snapshot = this.#activeSourceSnapshot(project.id);
    if (!source || snapshot.projectSourceId !== source.id) throw new RepositoryError("INVALID_STATE");
    if (input.expectedSource && (input.expectedSource.projectSourceId !== source.id
      || input.expectedSource.sourceSnapshotId !== snapshot.id
      || input.expectedSource.sourceIdentityHash !== snapshot.sourceIdentityHash)) {
      throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
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
    this.#analysisSources.set(run.id, {
      sourceType: source.sourceType,
      sourceUrl: source.sourceUrl,
      sourceConfiguration: copy(source.sourceConfiguration),
    });
    this.#createWorkflowRun({
      id: run.id,
      project,
      sourceSnapshotId: snapshot.id,
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

  async getLatestReviewedWorkflowForAnalysis(
    actor: RepositoryActor,
    projectId: string,
    analysisRunId: string,
  ): Promise<WorkflowRunRecord | undefined> {
    const project = this.#assertProject(actor, projectId);
    if (project.sourceType !== "github") return undefined;
    const run = [...this.#workflowRuns.values()]
      .filter((item) => item.organizationId === actor.organizationId
        && item.projectId === project.id
        && item.reviewedAnalysisRunId === analysisRunId)
      .sort((left, right) => compareCodePoints(right.createdAt, left.createdAt)
        || compareCodePoints(right.id, left.id))[0];
    return run ? copy(run) : undefined;
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

  async recordWorkflowTaskEvent(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: WorkflowTaskEventInput,
  ): Promise<WorkflowEventRecord> {
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const payload = normalizeWorkflowTaskEvent(input);
    this.#appendWorkflowEvent(task.workflowRunId, input.type, task.id, undefined, payload);
    const event = this.#workflowEvents.get(task.workflowRunId)?.at(-1);
    if (!event) throw new RepositoryError("INVALID_STATE");
    return copy(event);
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

  async getGitHubDraftPullRequestForTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
  ): Promise<GitHubDraftPullRequestRecord | undefined> {
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const result = [...this.#gitHubDraftPullRequests.values()].find((item) => item.taskId === task.id);
    return result ? copy(result) : undefined;
  }

  async saveGitHubDraftPullRequest(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: SaveGitHubDraftPullRequestRequest,
  ): Promise<GitHubDraftPullRequestRecord> {
    const task = this.#workflowTask(taskId);
    this.#assertWorkflowLease(workerId, task, leaseGeneration);
    const material = await this.getWorkflowExecutionMaterial(workerId, taskId, leaseGeneration);
    const run = this.#workflowRuns.get(task.workflowRunId);
    const snapshot = run ? this.#sourceSnapshots.get(run.sourceSnapshotId) : undefined;
    const source = snapshot ? this.#projectSources.get(snapshot.projectSourceId) : undefined;
    if (!run || !snapshot || !source || input.workflowRunId !== run.id
      || input.analysisRunId !== material.analysisRunId
      || !["publish", "install_verify"].includes(task.phase)) throw new RepositoryError("INVALID_STATE");
    const record = normalizeGitHubDraftPullRequest({
      ...input,
      id: randomUUID(),
      organizationId: run.organizationId,
      projectId: run.projectId,
      workflowRunId: run.id,
      taskId: task.id,
      analysisRunId: material.analysisRunId,
      sourceSnapshotId: snapshot.id,
      projectSourceId: source.id,
      phase: task.phase as "publish" | "install_verify",
      url: `https://github.com/${input.owner}/${input.repository}/pull/${input.number}`,
      createdAt: this.#now(),
    }, material);
    const existing = [...this.#gitHubDraftPullRequests.values()].find((item) => item.taskId === task.id);
    if (existing) {
      if (canonicalJson(withoutGitHubRecordIdentity(existing))
        !== canonicalJson(withoutGitHubRecordIdentity(record))) throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      return copy(existing);
    }
    this.#gitHubDraftPullRequests.set(record.id, record);
    return copy(record);
  }

  async getLatestGitHubDraftPullRequest(
    actor: RepositoryActor,
    workflowRunId: string,
  ): Promise<GitHubDraftPullRequestRecord | undefined> {
    const run = this.#workflowRunForActor(actor, workflowRunId);
    const result = [...this.#gitHubDraftPullRequests.values()]
      .filter((item) => item.workflowRunId === run.id && item.organizationId === actor.organizationId)
      .sort((left, right) => Number(right.phase === "install_verify") - Number(left.phase === "install_verify")
        || compareCodePoints(right.createdAt, left.createdAt) || compareCodePoints(right.id, left.id))[0];
    return result ? copy(result) : undefined;
  }

  async getLatestGitHubDraftPullRequestForProject(
    actor: RepositoryActor,
    projectId: string,
  ): Promise<GitHubDraftPullRequestRecord | undefined> {
    const project = this.#assertProject(actor, projectId);
    if (project.sourceType !== "github") return undefined;
    const result = [...this.#gitHubDraftPullRequests.values()]
      .filter((item) => item.projectId === project.id && item.organizationId === actor.organizationId)
      .sort((left, right) => compareCodePoints(right.createdAt, left.createdAt)
        || Number(right.phase === "install_verify") - Number(left.phase === "install_verify")
        || compareCodePoints(right.id, left.id))[0];
    return result ? copy(result) : undefined;
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
    if (analysis && ["queued", "running", "waiting"].includes(analysis.status)) {
      this.#runs.set(analysis.id, {
        ...analysis, status: "cancelled", leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now,
      });
      this.#analysisAvailableAt.delete(analysis.id);
      this.#closeWebsiteAuthenticationCheckpoint(analysis.id, "cancelled", now);
    }
    this.#recordCommand(`cancel:${run.id}`, input.idempotencyKey, input.inputHash, cancelled);
    return copy(this.#workflowRuns.get(run.id)!);
  }

  async reconcileWorkflows(workerId: string): Promise<number> {
    assertWorkerId(workerId);
    const now = this.clock();
    let repaired = 0;
    for (const checkpoint of [...this.#websiteAuthenticationCheckpoints.values()]) {
      if (!["waiting", "consumed"].includes(checkpoint.state) || new Date(checkpoint.expiresAt) > now) continue;
      const analysis = this.#runs.get(checkpoint.analysisRunId);
      const run = this.#workflowRuns.get(checkpoint.analysisRunId);
      const task = this.#workflowTasks.get(checkpoint.workflowTaskId);
      if (!analysis || !run || !task || !["waiting", "queued"].includes(analysis.status)
        || !["waiting", "queued"].includes(run.status) || !["waiting", "queued"].includes(task.status)) continue;
      const timestamp = now.toISOString();
      this.#closeWebsiteAuthenticationCheckpoint(analysis.id, "expired", timestamp);
      this.#runs.set(analysis.id, {
        ...analysis,
        status: "failed",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        errorCode: "AUTHENTICATION_WAIT_EXPIRED",
        updatedAt: timestamp,
      });
      this.#analysisAvailableAt.delete(analysis.id);
      this.#workflowTasks.set(task.id, {
        ...task,
        status: "failed",
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        retryClassification: "permanent",
        errorCode: "AUTHENTICATION_WAIT_EXPIRED",
        reconciledAt: timestamp,
        updatedAt: timestamp,
      });
      this.#workflowRuns.set(run.id, {
        ...run,
        status: "failed",
        errorCode: "AUTHENTICATION_WAIT_EXPIRED",
        updatedAt: timestamp,
      });
      const project = this.#projects.get(run.projectId);
      if (project) this.#projects.set(project.id, { ...project, status: "failed" });
      this.#appendWorkflowEvent(run.id, "task.reconciled", task.id, "AUTHENTICATION_WAIT_EXPIRED");
      this.#appendWorkflowEvent(run.id, "workflow.reconciled");
      repaired += 1;
    }
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

  async claimWebsiteAuthenticationCleanup(
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedWebsiteAuthenticationCleanupRecord | undefined> {
    assertWorkerId(workerId);
    const now = this.clock();
    const boundedLease = Math.max(1_000, Math.min(leaseMs, 300_000));
    for (const checkpoint of this.#websiteAuthenticationCheckpoints.values()) {
      const eligible = (checkpoint.cleanupStatus === "pending"
        && new Date(checkpoint.cleanupAvailableAt ?? checkpoint.updatedAt) <= now)
        || (checkpoint.cleanupStatus === "running" && checkpoint.cleanupLeaseExpiresAt !== undefined
          && new Date(checkpoint.cleanupLeaseExpiresAt) <= now);
      if (!eligible || checkpoint.cleanupAttempts < 3) continue;
      this.#websiteAuthenticationCheckpoints.set(checkpoint.analysisRunId, {
        ...checkpoint,
        cleanupStatus: "failed",
        cleanupAvailableAt: undefined,
        cleanupLeaseOwner: undefined,
        cleanupLeaseExpiresAt: undefined,
        cleanupErrorCode: checkpoint.cleanupErrorCode
          ?? "WEBSITE_AUTHENTICATION_CLEANUP_ATTEMPTS_EXHAUSTED",
        updatedAt: now.toISOString(),
      });
    }
    const candidates = [...this.#websiteAuthenticationCheckpoints.values()]
      .filter((checkpoint): checkpoint is StoredWebsiteAuthenticationCheckpoint & Readonly<{
        state: WebsiteAuthenticationCleanupTerminalState;
      }> => ["failed", "cancelled", "expired"].includes(checkpoint.state))
      .filter((checkpoint) => (checkpoint.cleanupStatus === "pending"
        && new Date(checkpoint.cleanupAvailableAt ?? checkpoint.terminalAt ?? checkpoint.updatedAt) <= now)
        || (checkpoint.cleanupStatus === "running" && checkpoint.cleanupLeaseExpiresAt !== undefined
          && new Date(checkpoint.cleanupLeaseExpiresAt) <= now))
      .filter((checkpoint) => checkpoint.cleanupAttempts < 3)
      .sort((left, right) => compareCodePoints(
        left.cleanupAvailableAt ?? left.terminalAt ?? left.updatedAt,
        right.cleanupAvailableAt ?? right.terminalAt ?? right.updatedAt,
      ) || compareCodePoints(left.analysisRunId, right.analysisRunId));
    const checkpoint = candidates[0];
    if (!checkpoint) return undefined;
    const source = this.#analysisSources.get(checkpoint.analysisRunId);
    if (!source || source.sourceType !== "website") throw new RepositoryError("INVALID_STATE");
    const liveReceiptEvidence = this.#websiteLiveReceiptEvidence.get(checkpoint.analysisRunId);
    if (!liveReceiptEvidence) throw new RepositoryError("INVALID_STATE");
    const claimed: StoredWebsiteAuthenticationCheckpoint = {
      ...checkpoint,
      cleanupStatus: "running",
      cleanupAttempts: checkpoint.cleanupAttempts + 1,
      cleanupLeaseOwner: workerId,
      cleanupLeaseExpiresAt: new Date(now.getTime() + boundedLease).toISOString(),
      cleanupLeaseGeneration: checkpoint.cleanupLeaseGeneration + 1,
      cleanupErrorCode: undefined,
      updatedAt: now.toISOString(),
    };
    this.#websiteAuthenticationCheckpoints.set(checkpoint.analysisRunId, claimed);
    const terminalState = claimed.state as WebsiteAuthenticationCleanupTerminalState;
    return copy({
      organizationId: claimed.organizationId,
      projectId: claimed.projectId,
      analysisRunId: claimed.analysisRunId,
      workflowTaskId: claimed.workflowTaskId,
      sourceSnapshotId: claimed.sourceSnapshotId,
      sourceIdentityHash: claimed.sourceIdentityHash,
      sourceUrl: source.sourceUrl,
      targetOriginDigest: claimed.targetOriginDigest,
      checkpointReference: claimed.checkpointReference,
      expiresAt: claimed.expiresAt,
      terminalState,
      outcome: terminalState === "cancelled" ? "cancelled" : "failed",
      cleanupIdempotencyKey: claimed.cleanupIdempotencyKey,
      attempts: claimed.cleanupAttempts,
      leaseOwner: workerId,
      leaseExpiresAt: claimed.cleanupLeaseExpiresAt!,
      leaseGeneration: claimed.cleanupLeaseGeneration,
      liveReceiptEvidence,
    });
  }

  async completeWebsiteAuthenticationCleanup(
    workerId: string,
    runId: string,
    leaseGeneration: number,
    resourceUpdates: readonly WebsiteAuthenticationCleanupResourceEvidence[] = [],
  ): Promise<void> {
    assertWorkerId(workerId);
    const checkpoint = this.#websiteAuthenticationCheckpoints.get(runId);
    const now = this.clock();
    if (!checkpoint || checkpoint.cleanupStatus !== "running"
      || checkpoint.cleanupLeaseOwner !== workerId
      || checkpoint.cleanupLeaseGeneration !== leaseGeneration
      || !checkpoint.cleanupLeaseExpiresAt || new Date(checkpoint.cleanupLeaseExpiresAt) <= now) {
      throw new RepositoryError("LEASE_LOST");
    }
    const timestamp = now.toISOString();
    const receiptEvidence = this.#websiteLiveReceiptEvidence.get(runId);
    if (!receiptEvidence) throw new RepositoryError("INVALID_STATE");
    this.#websiteLiveReceiptEvidence.set(runId, {
      ...receiptEvidence,
      cleanupResources: advanceWebsiteCleanupResources(receiptEvidence.cleanupResources, resourceUpdates),
    });
    this.#websiteAuthenticationCheckpoints.set(runId, {
      ...checkpoint,
      cleanupStatus: "succeeded",
      cleanupLeaseOwner: undefined,
      cleanupLeaseExpiresAt: undefined,
      cleanupCompletedAt: timestamp,
      cleanupErrorCode: undefined,
      updatedAt: timestamp,
    });
  }

  async retryWebsiteAuthenticationCleanup(
    workerId: string,
    runId: string,
    leaseGeneration: number,
    errorCode: string,
    retryable = true,
    resourceUpdates: readonly WebsiteAuthenticationCleanupResourceEvidence[] = [],
  ): Promise<void> {
    assertWorkerId(workerId);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) throw new RepositoryError("INVALID_STATE");
    const checkpoint = this.#websiteAuthenticationCheckpoints.get(runId);
    const now = this.clock();
    if (!checkpoint || checkpoint.cleanupStatus !== "running"
      || checkpoint.cleanupLeaseOwner !== workerId
      || checkpoint.cleanupLeaseGeneration !== leaseGeneration
      || !checkpoint.cleanupLeaseExpiresAt || new Date(checkpoint.cleanupLeaseExpiresAt) <= now) {
      throw new RepositoryError("LEASE_LOST");
    }
    const timestamp = now.toISOString();
    const receiptEvidence = this.#websiteLiveReceiptEvidence.get(runId);
    if (!receiptEvidence) throw new RepositoryError("INVALID_STATE");
    this.#websiteLiveReceiptEvidence.set(runId, {
      ...receiptEvidence,
      cleanupResources: advanceWebsiteCleanupResources(receiptEvidence.cleanupResources, resourceUpdates),
    });
    const retryDelayMs = workflowRetryDelayMs(
      checkpoint.cleanupAttempts,
      undefined,
      this.workflowOptions.random,
    );
    const exhausted = !retryable || checkpoint.cleanupAttempts >= 3;
    this.#websiteAuthenticationCheckpoints.set(runId, {
      ...checkpoint,
      cleanupStatus: exhausted ? "failed" : "pending",
      cleanupAvailableAt: exhausted ? undefined : new Date(now.getTime() + retryDelayMs).toISOString(),
      cleanupLeaseOwner: undefined,
      cleanupLeaseExpiresAt: undefined,
      cleanupErrorCode: errorCode,
      updatedAt: timestamp,
    });
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
      const authenticationCheckpoint = this.#websiteAuthenticationCheckpoints.get(run.id);
      if (authenticationCheckpoint && (authenticationCheckpoint.state !== "consumed"
        || !authenticationCheckpoint.authenticationEvidenceReference
        || new Date(authenticationCheckpoint.expiresAt) <= now)) continue;
      if (run.attempts >= 3) {
        this.#runs.set(run.id, { ...run, status: "failed", errorCode: "ATTEMPTS_EXHAUSTED", updatedAt: now.toISOString() });
        const project = this.#projects.get(run.projectId);
        if (project) this.#projects.set(project.id, { ...project, status: "failed" });
        this.#analysisAvailableAt.delete(run.id);
        if (authenticationCheckpoint && ["waiting", "consumed"].includes(authenticationCheckpoint.state)) {
          this.#closeWebsiteAuthenticationCheckpoint(run.id, "failed", now.toISOString());
        }
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
      const sourceSnapshot = this.#sourceSnapshots.get(workflow.sourceSnapshotId);
      if (!sourceSnapshot) throw new RepositoryError("INVALID_STATE");
      if (authenticationCheckpoint && (authenticationCheckpoint.organizationId !== run.organizationId
        || authenticationCheckpoint.projectId !== run.projectId
        || authenticationCheckpoint.workflowTaskId !== task.id
        || authenticationCheckpoint.sourceSnapshotId !== sourceSnapshot.id
        || authenticationCheckpoint.sourceIdentityHash !== sourceSnapshot.sourceIdentityHash
        || authenticationCheckpoint.targetOriginDigest !== websiteTargetOriginDigest(source.sourceUrl))) {
        throw new RepositoryError("INVALID_STATE");
      }
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
      let liveReceiptEvidence: WebsiteLiveReceiptEvidence | undefined;
      if (authenticationCheckpoint) {
        const persistedEvidence = this.#websiteLiveReceiptEvidence.get(run.id);
        if (!persistedEvidence) throw new RepositoryError("INVALID_STATE");
        liveReceiptEvidence = persistedEvidence.resumedWorkerIdentityDigest ? persistedEvidence : {
          ...persistedEvidence,
          resumedWorkerIdentityDigest: websiteWorkerIdentityDigest(workerId),
          resumeLeaseGeneration: workflowTask.leaseGeneration,
          resumeClaimedAt: now.toISOString(),
        };
        this.#websiteLiveReceiptEvidence.set(run.id, liveReceiptEvidence);
      }
      this.#organizationClaimOrder.set(run.organizationId, ++this.#claimSequence);
      this.#workflowRuns.set(workflow.id, { ...workflow, status: "running", currentPhase: "analysis", updatedAt: now.toISOString() });
      this.#appendWorkflowEvent(workflow.id, "task.claimed", task.id);
      return copy({
        ...claimed,
        ...source,
        workflowTaskId: workflowTask.id,
        sourceSnapshotId: sourceSnapshot.id,
        leaseGeneration: workflowTask.leaseGeneration,
        ...(authenticationCheckpoint ? {
          authenticationCheckpoint: {
            checkpointReference: authenticationCheckpoint.checkpointReference,
            authenticationEvidenceReference: authenticationCheckpoint.authenticationEvidenceReference!,
            sourceSnapshotId: authenticationCheckpoint.sourceSnapshotId,
            sourceIdentityHash: authenticationCheckpoint.sourceIdentityHash,
            targetOriginDigest: authenticationCheckpoint.targetOriginDigest,
            expiresAt: authenticationCheckpoint.expiresAt,
            ...(websiteAuthenticationResultCheckpoint(liveReceiptEvidence!) ? {
              resultCheckpoint: websiteAuthenticationResultCheckpoint(liveReceiptEvidence!),
            } : {}),
            liveReceiptEvidence: liveReceiptEvidence!,
          },
        } : {}),
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

  async waitAnalysisForAuthentication(
    workerId: string,
    runId: string,
    input: WaitAnalysisForAuthenticationInput,
    leaseGeneration?: number,
  ): Promise<WebsiteAuthenticationCheckpointRecord> {
    assertWorkerId(workerId);
    const normalized = normalizeWebsiteAuthenticationWaitInput(input, this.clock());
    const inputHash = websiteAuthenticationWaitCommandHash(input.inputHash, normalized.suspensionEvidence);
    const existing = this.#websiteAuthenticationCheckpoints.get(runId);
    if (existing) {
      const existingEvidence = this.#websiteLiveReceiptEvidence.get(runId);
      if (existing.waitIdempotencyKey !== input.idempotencyKey || existing.waitInputHash !== inputHash
        || !websiteAuthenticationWaitMatches(existing, normalized) || !existingEvidence) {
        throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      }
      return publicWebsiteAuthenticationCheckpoint(existing);
    }
    const workflow = this.#workflowRuns.get(runId);
    const run = this.#runs.get(runId);
    const source = this.#analysisSources.get(runId);
    const task = [...this.#workflowTasks.values()]
      .find((candidate) => candidate.workflowRunId === runId && candidate.phase === "analysis");
    if (!workflow || !run || !source || !task) throw new RepositoryError("INVALID_STATE");
    if (workflow.cancelRequestedAt || workflow.status === "cancelled") throw new RepositoryError("CANCELLED");
    if (source.sourceType !== "website") throw new RepositoryError("INVALID_STATE");
    if (run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= this.clock()) throw new RepositoryError("LEASE_LOST");
    this.#assertWorkflowLease(workerId, task, leaseGeneration ?? task.leaseGeneration);
    if (normalized.suspensionEvidence.suspendedWorkerIdentityDigest !== websiteWorkerIdentityDigest(workerId)
      || normalized.suspensionEvidence.suspendedLeaseGeneration !== (leaseGeneration ?? task.leaseGeneration)) {
      throw new RepositoryError("LEASE_LOST");
    }
    const snapshot = this.#sourceSnapshots.get(workflow.sourceSnapshotId);
    if (!snapshot || snapshot.organizationId !== run.organizationId || snapshot.projectId !== run.projectId
      || normalized.sourceSnapshotId !== snapshot.id
      || normalized.sourceIdentityHash !== snapshot.sourceIdentityHash) {
      throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
    }
    if (normalized.targetOriginDigest !== websiteTargetOriginDigest(source.sourceUrl)) {
      throw new RepositoryError("INVALID_STATE");
    }
    const now = this.#now();
    const checkpoint: StoredWebsiteAuthenticationCheckpoint = {
      organizationId: run.organizationId,
      projectId: run.projectId,
      analysisRunId: run.id,
      workflowTaskId: task.id,
      sourceSnapshotId: snapshot.id,
      sourceIdentityHash: snapshot.sourceIdentityHash,
      targetOriginDigest: normalized.targetOriginDigest,
      checkpointReference: normalized.checkpointReference,
      state: "waiting",
      expiresAt: normalized.expiresAt,
      waitIdempotencyKey: input.idempotencyKey,
      waitInputHash: inputHash,
      cleanupIdempotencyKey: `website-auth-cleanup:${normalized.checkpointReference.slice("urn:sha256:".length)}`,
      cleanupAttempts: 0,
      cleanupLeaseGeneration: 0,
      createdAt: now,
      updatedAt: now,
    };
    if ([...this.#websiteAuthenticationCheckpoints.values()]
      .some((candidate) => candidate.checkpointReference === checkpoint.checkpointReference)) {
      throw new RepositoryError("INVALID_STATE");
    }
    this.#websiteAuthenticationCheckpoints.set(run.id, checkpoint);
    this.#websiteLiveReceiptEvidence.set(run.id, {
      ...normalized.suspensionEvidence,
      restartVerified: false,
      cleanupResources: initialWebsiteCleanupResources(normalized.suspensionEvidence),
    });
    this.#runs.set(run.id, {
      ...run,
      status: "waiting",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      updatedAt: now,
    });
    this.#analysisAvailableAt.delete(run.id);
    this.#workflowTasks.set(task.id, {
      ...task,
      status: "waiting",
      checkpointReference: checkpoint.checkpointReference,
      waitKeyHash: stableHash(`${input.idempotencyKey}\0${inputHash}`),
      waitReason: "external_authentication",
      waitExpiresAt: checkpoint.expiresAt,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      updatedAt: now,
    });
    this.#workflowRuns.set(workflow.id, { ...workflow, status: "waiting", errorCode: undefined, updatedAt: now });
    this.#appendWorkflowEvent(workflow.id, "task.waiting", task.id);
    return publicWebsiteAuthenticationCheckpoint(checkpoint);
  }

  async getWebsiteAuthenticationWait(
    actor: RepositoryActor,
    runId: string,
  ): Promise<WebsiteAuthenticationCheckpointRecord | undefined> {
    this.#workflowRunForActor(actor, runId);
    const checkpoint = this.#websiteAuthenticationCheckpoints.get(runId);
    return checkpoint ? publicWebsiteAuthenticationCheckpoint(checkpoint) : undefined;
  }

  async resumeAnalysisAfterAuthentication(
    actor: RepositoryActor,
    input: ResumeAnalysisAfterAuthenticationInput,
  ): Promise<WebsiteAuthenticationCheckpointRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const normalized = normalizeWebsiteAuthenticationResumeInput(input);
    const run = this.#workflowRunForActor(actor, input.runId);
    const checkpoint = this.#websiteAuthenticationCheckpoints.get(run.id);
    if (!checkpoint) throw new RepositoryError("INVALID_STATE");
    const inputHash = stableHash(input.inputHash);
    if (checkpoint.resumeIdempotencyKey !== undefined) {
      if (checkpoint.resumeIdempotencyKey !== input.idempotencyKey || checkpoint.resumeInputHash !== inputHash
        || !websiteAuthenticationResumeMatches(checkpoint, normalized)) {
        throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      }
      return publicWebsiteAuthenticationCheckpoint(checkpoint);
    }
    if (run.cancelRequestedAt || run.status === "cancelled") throw new RepositoryError("CANCELLED");
    if (checkpoint.state !== "waiting" || run.status !== "waiting") throw new RepositoryError("INVALID_STATE");
    if (new Date(checkpoint.expiresAt) <= this.clock()) throw new RepositoryError("WAIT_EXPIRED");
    if (checkpoint.sourceSnapshotId !== normalized.sourceSnapshotId
      || checkpoint.sourceIdentityHash !== normalized.sourceIdentityHash) {
      throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
    }
    if (!websiteAuthenticationResumeMatches(checkpoint, normalized)) throw new RepositoryError("INVALID_STATE");
    const snapshot = this.#sourceSnapshots.get(run.sourceSnapshotId);
    if (!snapshot || snapshot.id !== checkpoint.sourceSnapshotId
      || snapshot.sourceIdentityHash !== checkpoint.sourceIdentityHash) throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
    const task = [...this.#workflowTasks.values()]
      .find((candidate) => candidate.workflowRunId === run.id && candidate.phase === "analysis");
    const analysis = this.#runs.get(run.id);
    if (!task || !analysis || task.status !== "waiting" || task.checkpointReference !== checkpoint.checkpointReference
      || task.waitReason !== "external_authentication" || analysis.status !== "waiting") {
      throw new RepositoryError("INVALID_STATE");
    }
    const now = this.#now();
    const consumed: StoredWebsiteAuthenticationCheckpoint = {
      ...checkpoint,
      authenticationEvidenceReference: normalized.authenticationEvidenceReference,
      state: "consumed",
      consumedAt: now,
      resumeIdempotencyKey: input.idempotencyKey,
      resumeInputHash: inputHash,
      updatedAt: now,
    };
    this.#websiteAuthenticationCheckpoints.set(run.id, consumed);
    const persistedEvidence = this.#websiteLiveReceiptEvidence.get(run.id);
    if (!persistedEvidence) throw new RepositoryError("INVALID_STATE");
    this.#websiteLiveReceiptEvidence.set(run.id, {
      ...persistedEvidence,
      authenticationEvidenceReferenceDigest: websiteReferenceDigest(normalized.authenticationEvidenceReference),
      authenticationConsumedAt: now,
    });
    this.#runs.set(analysis.id, {
      ...analysis,
      status: "queued",
      errorCode: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    this.#analysisAvailableAt.set(analysis.id, now);
    this.#workflowTasks.set(task.id, {
      ...task,
      status: "queued",
      resumedAt: now,
      availableAt: now,
      errorCode: undefined,
      updatedAt: now,
    });
    this.#workflowRuns.set(run.id, { ...run, status: "queued", errorCode: undefined, updatedAt: now });
    this.#appendWorkflowEvent(run.id, "task.resumed", task.id);
    return publicWebsiteAuthenticationCheckpoint(consumed);
  }

  async terminateAnalysisAuthentication(
    actor: RepositoryActor,
    input: TerminateAnalysisAuthenticationInput,
  ): Promise<WebsiteAuthenticationCheckpointRecord> {
    if (actor.role === "viewer") throw new RepositoryError("FORBIDDEN");
    const normalized = normalizeWebsiteAuthenticationTerminalInput(input);
    const run = this.#workflowRunForActor(actor, normalized.runId);
    const checkpoint = this.#websiteAuthenticationCheckpoints.get(run.id);
    const task = [...this.#workflowTasks.values()]
      .find((candidate) => candidate.workflowRunId === run.id && candidate.phase === "analysis");
    const analysis = this.#runs.get(run.id);
    if (!checkpoint || !task || !analysis || !websiteAuthenticationTerminalMatches(checkpoint, normalized)) {
      throw new RepositoryError("INVALID_STATE");
    }
    if (checkpoint.state === normalized.terminalState) {
      if (run.status !== "failed" || task.status !== "failed" || analysis.status !== "failed") {
        throw new RepositoryError("INVALID_STATE");
      }
      return publicWebsiteAuthenticationCheckpoint(checkpoint);
    }
    if (checkpoint.state !== "waiting" || run.status !== "waiting" || task.status !== "waiting"
      || task.checkpointReference !== checkpoint.checkpointReference
      || task.waitReason !== "external_authentication" || analysis.status !== "waiting") {
      throw new RepositoryError("INVALID_STATE");
    }
    if (normalized.terminalState === "expired" && new Date(checkpoint.expiresAt) > this.clock()) {
      throw new RepositoryError("INVALID_STATE");
    }
    const snapshot = this.#sourceSnapshots.get(run.sourceSnapshotId);
    if (!snapshot || snapshot.id !== checkpoint.sourceSnapshotId
      || snapshot.sourceIdentityHash !== checkpoint.sourceIdentityHash) throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
    const now = this.#now();
    const errorCode = normalized.terminalState === "expired"
      ? "AUTHENTICATION_WAIT_EXPIRED"
      : "AUTHENTICATION_HANDOFF_FAILED";
    this.#closeWebsiteAuthenticationCheckpoint(run.id, normalized.terminalState, now);
    this.#runs.set(analysis.id, {
      ...analysis,
      status: "failed",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode,
      updatedAt: now,
    });
    this.#analysisAvailableAt.delete(analysis.id);
    this.#workflowTasks.set(task.id, {
      ...task,
      status: "failed",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      retryClassification: "permanent",
      errorCode,
      updatedAt: now,
    });
    this.#workflowRuns.set(run.id, { ...run, status: "failed", errorCode, updatedAt: now });
    const project = this.#projects.get(run.projectId);
    if (project) this.#projects.set(project.id, { ...project, status: "failed" });
    this.#appendWorkflowEvent(run.id, "task.failed", task.id, errorCode);
    this.#appendWorkflowEvent(run.id, "workflow.failed", undefined, errorCode);
    return publicWebsiteAuthenticationCheckpoint(this.#websiteAuthenticationCheckpoints.get(run.id)!);
  }

  async checkpointWebsiteAuthenticationResult(
    workerId: string,
    runId: string,
    result: AnalysisResult,
    leaseGeneration: number,
  ): Promise<WebsiteAuthenticationResultCheckpoint> {
    const persisted = await this.#persistAnalysisResult(workerId, runId, result, leaseGeneration, true);
    if ("status" in persisted) throw new RepositoryError("INVALID_STATE");
    return persisted;
  }

  async completeAnalysis(
    workerId: string,
    runId: string,
    result: AnalysisResult,
    leaseGeneration?: number,
  ): Promise<AnalysisRunRecord> {
    const persisted = await this.#persistAnalysisResult(workerId, runId, result, leaseGeneration, false);
    if (!("status" in persisted)) throw new RepositoryError("INVALID_STATE");
    return persisted;
  }

  async #persistAnalysisResult(
    workerId: string,
    runId: string,
    result: AnalysisResult,
    leaseGeneration: number | undefined,
    checkpointOnly: boolean,
  ): Promise<AnalysisRunRecord | WebsiteAuthenticationResultCheckpoint> {
    const workflow = this.#workflowRuns.get(runId);
    if (!workflow) throw new RepositoryError("INVALID_STATE");
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
    const analysisSource = this.#analysisSources.get(run.id);
    if (!analysisSource) throw new RepositoryError("INVALID_STATE");
    const providerProvenance = result.providerProvenance === undefined
      ? undefined : normalizeProviderProvenance(result.providerProvenance, analysisSource.sourceType);
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
    const sourceArtifact = normalizeAnalysisSourceArtifact(
      result.sourceArtifact,
      providerProvenance,
      normalizedEvidence,
      analysisSource.sourceType,
    );
    let sourceSnapshotToFreeze: SourceSnapshotRecord | undefined;
    if (sourceArtifact) {
      const snapshot = this.#sourceSnapshots.get(workflow.sourceSnapshotId);
      if (!snapshot || snapshot.projectId !== run.projectId || snapshot.organizationId !== run.organizationId) {
        throw new RepositoryError("INVALID_STATE");
      }
      if (snapshot.sourceArtifact !== undefined
        && canonicalJson(snapshot.sourceArtifact) !== canonicalJson(sourceArtifact)
        || snapshot.contentHash !== undefined && snapshot.contentHash !== sourceArtifact.contentHash
        || snapshot.artifactReference !== undefined
          && snapshot.artifactReference !== sourceArtifact.artifactReference) {
        throw new RepositoryError("SOURCE_SNAPSHOT_STALE");
      }
      sourceSnapshotToFreeze = {
        ...snapshot,
        contentHash: sourceArtifact.contentHash,
        artifactReference: sourceArtifact.artifactReference,
        sourceArtifact,
      };
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
      ...(providerProvenance ? { providerProvenance } : {}),
      ...(sourceArtifact ? { sourceArtifact } : {}),
    };
    const outputHash = stableHash(canonicalJson({
      diagnostics: normalizedDiagnostics,
      evidence: normalizedEvidence.map(({ reference }) => reference).sort(compareCodePoints),
      plans: canonicalPlans.map((plan) => capabilityPlanDigest(plan)).sort(compareCodePoints),
      release: normalizedResult.release?.contentHash,
      providerProvenance,
    }));
    const outputReference = normalizedResult.release
      ? `urn:sha256:${normalizedResult.release.contentHash}`
      : normalizedEvidence[0]?.reference;
    if (!outputReference) throw new RepositoryError("INVALID_STATE");
    const authenticationCheckpoint = this.#websiteAuthenticationCheckpoints.get(run.id);
    const persistedReceipt = this.#websiteLiveReceiptEvidence.get(run.id);
    if (checkpointOnly && authenticationCheckpoint?.state !== "consumed") {
      throw new RepositoryError("INVALID_STATE");
    }
    if (!checkpointOnly && authenticationCheckpoint?.state === "consumed") {
      throw new RepositoryError("INVALID_STATE");
    }
    if (persistedReceipt?.resultCheckpointHash) {
      if (!checkpointOnly || persistedReceipt.resultCheckpointHash !== outputHash
        || persistedReceipt.resultCheckpointOutputReference !== outputReference
        || persistedReceipt.resultCheckpointWorkerIdentityDigest !== websiteWorkerIdentityDigest(workerId)
        || persistedReceipt.resultCheckpointLeaseGeneration !== workflowTask.leaseGeneration
        || !persistedReceipt.resultCheckpointedAt) {
        throw new RepositoryError("IDEMPOTENCY_CONFLICT");
      }
      return copy({ resultHash: outputHash, outputReference,
        leaseGeneration: workflowTask.leaseGeneration, checkpointedAt: persistedReceipt.resultCheckpointedAt });
    }
    if (sourceSnapshotToFreeze) {
      this.#sourceSnapshots.set(sourceSnapshotToFreeze.id, sourceSnapshotToFreeze);
    }
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
    if (checkpointOnly) {
      if (!persistedReceipt?.resumedWorkerIdentityDigest || persistedReceipt.resumeAcknowledgedAt) {
        throw new RepositoryError("INVALID_STATE");
      }
      this.#websiteLiveReceiptEvidence.set(run.id, {
        ...persistedReceipt,
        resultCheckpointHash: outputHash,
        resultCheckpointOutputReference: outputReference,
        resultCheckpointWorkerIdentityDigest: websiteWorkerIdentityDigest(workerId),
        resultCheckpointLeaseGeneration: workflowTask.leaseGeneration,
        resultCheckpointedAt: now,
      });
      return copy({ resultHash: outputHash, outputReference,
        leaseGeneration: workflowTask.leaseGeneration, checkpointedAt: now });
    }
    const completed: AnalysisRunRecord = {
      ...run,
      status: "succeeded",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      ...(providerProvenance ? { providerProvenance } : {}),
      updatedAt: now
    };
    this.#runs.set(run.id, completed);
    this.#closeWebsiteAuthenticationCheckpoint(run.id, "completed", now);
    this.#analysisAvailableAt.delete(run.id);
    const project = this.#projects.get(run.projectId);
    if (project) this.#projects.set(project.id, { ...project, status: "analyzed" });
    this.#workflowTasks.set(workflowTask.id, {
      ...workflowTask,
      status: "succeeded",
      outputHash,
      outputReference,
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

  async completeCheckpointedWebsiteAuthenticationAnalysis(
    workerId: string,
    runId: string,
    resultHash: string,
    leaseGeneration: number,
    resourceUpdates: readonly WebsiteAuthenticationCleanupResourceEvidence[] = [],
  ): Promise<AnalysisRunRecord> {
    assertWorkerId(workerId);
    if (!/^[0-9a-f]{64}$/.test(resultHash) || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
      throw new RepositoryError("INVALID_STATE");
    }
    const workflow = this.#workflowRuns.get(runId);
    if (!workflow) throw new RepositoryError("INVALID_STATE");
    if (workflow.cancelRequestedAt || workflow.status === "cancelled") throw new RepositoryError("CANCELLED");
    const run = this.#runs.get(runId);
    const nowDate = this.clock();
    if (!run || run.status !== "running" || run.leaseOwner !== workerId || !run.leaseExpiresAt
      || new Date(run.leaseExpiresAt) <= nowDate) throw new RepositoryError("LEASE_LOST");
    const workflowTask = [...this.#workflowTasks.values()].find((candidate) =>
      candidate.workflowRunId === runId && candidate.phase === "analysis");
    if (!workflowTask) throw new RepositoryError("INVALID_STATE");
    this.#assertWorkflowLease(workerId, workflowTask, leaseGeneration);
    const authenticationCheckpoint = this.#websiteAuthenticationCheckpoints.get(run.id);
    const receipt = this.#websiteLiveReceiptEvidence.get(run.id);
    const result = this.#results.get(run.id);
    if (authenticationCheckpoint?.state !== "consumed" || !receipt || !result
      || receipt.resultCheckpointHash !== resultHash || !receipt.resultCheckpointOutputReference
      || !receipt.resultCheckpointWorkerIdentityDigest || !receipt.resultCheckpointLeaseGeneration
      || !receipt.resultCheckpointedAt || receipt.resumeAcknowledgedAt || result.evidence.length === 0
      || !(result.evidence.some(({ reference }) => reference === receipt.resultCheckpointOutputReference)
        || result.release !== undefined
          && `urn:sha256:${result.release.contentHash}` === receipt.resultCheckpointOutputReference)) {
      throw new RepositoryError("INVALID_STATE");
    }
    const capabilities = this.#analysisCapabilities(run.id);
    const now = nowDate.toISOString();
    this.#websiteLiveReceiptEvidence.set(run.id, acknowledgeWebsiteAuthenticationCompletion({
      ...receipt,
      cleanupResources: advanceWebsiteCleanupResources(receipt.cleanupResources, resourceUpdates),
    }, workerId, workflowTask.leaseGeneration, now));
    const completed: AnalysisRunRecord = {
      ...run,
      status: "succeeded",
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      ...(result.providerProvenance ? { providerProvenance: result.providerProvenance } : {}),
      updatedAt: now,
    };
    this.#runs.set(run.id, completed);
    this.#closeWebsiteAuthenticationCheckpoint(run.id, "completed", now);
    this.#analysisAvailableAt.delete(run.id);
    const project = this.#projects.get(run.projectId);
    if (project) this.#projects.set(project.id, { ...project, status: "analyzed" });
    this.#workflowTasks.set(workflowTask.id, {
      ...workflowTask,
      status: "succeeded",
      outputHash: resultHash,
      outputReference: receipt.resultCheckpointOutputReference,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      errorCode: undefined,
      updatedAt: now,
    });
    this.#workflowRuns.set(workflow.id, { ...workflow, status: "succeeded", errorCode: undefined, updatedAt: now });
    this.#workflowEvidence.set(run.id, result.evidence.map((evidence) => ({
      id: randomUUID(), organizationId: run.organizationId, projectId: run.projectId,
      workflowRunId: run.id, taskId: workflowTask.id, evidenceId: evidence.id!,
      reference: evidence.reference, createdAt: now,
    })));
    this.#workflowCapabilityPlans.set(run.id, capabilities.map((capability) => ({
      id: randomUUID(), organizationId: run.organizationId, projectId: run.projectId,
      workflowRunId: run.id, taskId: workflowTask.id, capabilityId: capability.id,
      planDigest: capability.planDigest, createdAt: now,
    })));
    this.#appendWorkflowEvent(workflow.id, "task.completed", workflowTask.id);
    this.#appendWorkflowEvent(workflow.id, "workflow.completed");
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
    if (terminal) this.#closeWebsiteAuthenticationCheckpoint(run.id, "failed", failed.updatedAt);
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
    const workflow = [...this.#workflowRuns.values()].find((item) => item.analysisRunId === run.id);
    const sourceSnapshot = workflow ? this.#sourceSnapshots.get(workflow.sourceSnapshotId) : undefined;
    const projectSource = sourceSnapshot ? this.#projectSources.get(sourceSnapshot.projectSourceId) : undefined;
    if (!workflow || !sourceSnapshot || !projectSource
      || workflow.projectId !== projectId || sourceSnapshot.projectId !== projectId
      || projectSource.projectId !== projectId || sourceSnapshot.organizationId !== actor.organizationId
      || projectSource.organizationId !== actor.organizationId
      || !candidateVerifierScopeMatches(input, projectId, sourceSnapshot.sourceIdentityHash,
        projectSource.sourceConfiguration)) throw new RepositoryError("INVALID_STATE");
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
      const verification = publishedRelease?.verificationRunId
        ? this.#verifications.get(publishedRelease.verificationRunId) : undefined;
      const verifiedCandidate = publishedRelease?.verificationRunId
        ? this.#verificationCandidates.get(publishedRelease.verificationRunId) : undefined;
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
    const verifierAttestation = input.observation.verifierAttestation;
    if (verifierAttestation && [...this.#verifications.values()].some((item) =>
      item.observation?.verifierAttestation?.attestationId === verifierAttestation.attestationId
      || item.observation?.verifierAttestation?.requestId === verifierAttestation.requestId)) {
      throw new RepositoryError("INVALID_STATE", ["VERIFIER_ATTESTATION_REPLAYED"]);
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
    this.#verificationCandidates.set(record.id, {
      ...structuredClone(candidate),
      contentHash: candidateContentHash,
      manifest: structuredClone(candidate.manifest ?? {})
    });
    this.#verifications.set(record.id, record);
    this.#verificationIdsByRun.set(input.analysisRunId,
      [...(this.#verificationIdsByRun.get(input.analysisRunId) ?? []), record.id]);
    return copy(record);
  }

  async publishRelease(actor: RepositoryActor, input: PublishRequest): Promise<ReleaseRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    this.#assertProject(actor, input.projectId);
    const artifactIdentity = normalizeReleaseArtifactIdentity(input, input.candidateContentHash);
    const idempotencyId = this.#idempotencyId("release", actor, input.idempotencyKey);
    const previous = this.#idempotentReplay(idempotencyId, input.inputHash);
    if (previous) {
      const release = this.#releases.get(previous.resultId);
      if (!release || release.organizationId !== actor.organizationId || release.projectId !== input.projectId
        || release.analysisRunId !== input.analysisRunId
        || !releaseMatchesPublication(release, input)) throw new RepositoryError("INVALID_STATE");
      return copy(release);
    }
    const run = this.#runs.get(input.analysisRunId);
    if (!run || run.organizationId !== actor.organizationId || run.projectId !== input.projectId || run.status !== "succeeded") {
      throw new RepositoryError("INVALID_STATE");
    }
    const latestVerificationId = this.#verificationIdsByRun.get(input.analysisRunId)?.at(-1);
    if (latestVerificationId !== input.verificationRunId) {
      throw new RepositoryError("RELEASE_GATE_FAILED", ["CANDIDATE_CHANGED"]);
    }
    const verification = this.#verifications.get(input.verificationRunId);
    if (verification?.projectId !== input.projectId || verification?.analysisRunId !== input.analysisRunId
      || !verification.eligible
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
    const candidate = this.#verificationCandidates.get(verification.id);
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
      if (!existing || !releaseMatchesPublication(existing, input)) throw new RepositoryError("INVALID_STATE");
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
      verificationRunId: verification.id,
      ...artifactIdentity,
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

  async getRelease(actor: RepositoryActor, projectId: string, releaseId: string): Promise<ReleaseRecord> {
    this.#assertProject(actor, projectId);
    const release = this.#releases.get(releaseId);
    if (!release || release.organizationId !== actor.organizationId || release.projectId !== projectId) {
      throw new RepositoryError("NOT_FOUND");
    }
    return copy(release);
  }

  async getLatestPublishedRelease(
    actor: RepositoryActor,
    projectId: string,
  ): Promise<PublishedReleaseState | undefined> {
    this.#assertProject(actor, projectId);
    const release = [...this.#releases.values()]
      .filter((candidate) => candidate.organizationId === actor.organizationId && candidate.projectId === projectId)
      .sort((left, right) => compareCodePoints(right.createdAt, left.createdAt)
        || compareCodePoints(right.id, left.id))[0];
    if (!release) return undefined;
    const verification = release.verificationRunId ? this.#verifications.get(release.verificationRunId) : undefined;
    const candidate = release.verificationRunId ? this.#verificationCandidates.get(release.verificationRunId) : undefined;
    if (!verification?.eligible || !candidate || verification.projectId !== projectId
      || verification.analysisRunId !== release.analysisRunId
      || verification.capabilityStateDigest !== release.capabilityStateDigest
      || verification.candidateContentHash !== release.contentHash
      || !candidateMatches(candidate, release)) {
      throw new RepositoryError("INVALID_STATE");
    }
    return copy({ release, verification });
  }

  async getPreviousRelease(
    actor: RepositoryActor,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | undefined> {
    const current = await this.getRelease(actor, projectId, releaseId);
    return [...this.#releases.values()]
      .filter((release) => release.organizationId === actor.organizationId && release.projectId === projectId
        && (release.createdAt < current.createdAt
          || release.createdAt === current.createdAt && compareCodePoints(release.id, current.id) < 0))
      .sort((left, right) => compareCodePoints(right.createdAt, left.createdAt) || compareCodePoints(right.id, left.id))[0];
  }

  async saveReleaseInstallation(
    actor: RepositoryActor,
    projectId: string,
    input: ReleaseInstallationRequest,
  ): Promise<ReleaseInstallationRecord> {
    if (actor.role !== "owner") throw new RepositoryError("FORBIDDEN");
    this.#assertProject(actor, projectId);
    const release = await this.getRelease(actor, projectId, input.releaseId);
    const normalized = normalizeReleaseInstallation(input, release);
    const idempotencyId = this.#idempotencyId("installation", actor, input.idempotencyKey);
    const replay = this.#idempotentReplay(idempotencyId, input.inputHash);
    if (replay) {
      const record = this.#releaseInstallations.get(replay.resultId);
      if (!record || record.projectId !== projectId || record.releaseId !== input.releaseId) {
        throw new RepositoryError("INVALID_STATE");
      }
      return copy(record);
    }
    const workflow = [...this.#workflowRuns.values()].find((item) => item.analysisRunId === release.analysisRunId);
    const sourceSnapshot = workflow ? this.#sourceSnapshots.get(workflow.sourceSnapshotId) : undefined;
    const projectSource = sourceSnapshot ? this.#projectSources.get(sourceSnapshot.projectSourceId) : undefined;
    if (!workflow || !sourceSnapshot || !projectSource
      || workflow.projectId !== projectId || sourceSnapshot.projectId !== projectId
      || projectSource.projectId !== projectId || sourceSnapshot.organizationId !== actor.organizationId
      || projectSource.organizationId !== actor.organizationId
      || !installationVerifierScopeMatches(normalized, projectId, sourceSnapshot.sourceIdentityHash,
        projectSource.sourceConfiguration)) throw new RepositoryError("INVALID_STATE");
    const verifierAttestation = normalized.attestation.verifierAttestation;
    if (verifierAttestation && [...this.#releaseInstallations.values()].some((item) =>
      item.attestation.verifierAttestation?.attestationId === verifierAttestation.attestationId
      || item.attestation.verifierAttestation?.requestId === verifierAttestation.requestId)) {
      throw new RepositoryError("INVALID_STATE", ["VERIFIER_ATTESTATION_REPLAYED"]);
    }
    const record: ReleaseInstallationRecord = {
      id: randomUUID(),
      organizationId: actor.organizationId,
      projectId,
      actorId: actor.id,
      ...normalized,
      createdAt: this.#now(),
      ...(normalized.status === "verified" ? { verifiedAt: this.#now() } : {}),
    };
    this.#releaseInstallations.set(record.id, record);
    this.#reserveIdempotency(idempotencyId, input.inputHash, record.id);
    this.#auditEvent(actor, `release.installation.${record.status}`, record.id);
    return copy(record);
  }

  async getLatestReleaseInstallation(
    actor: RepositoryActor,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseInstallationRecord | undefined> {
    this.#assertProject(actor, projectId);
    await this.getRelease(actor, projectId, releaseId);
    const record = [...this.#releaseInstallations.values()]
      .filter((item) => item.organizationId === actor.organizationId
        && item.projectId === projectId && item.releaseId === releaseId)
      .at(-1);
    return record ? copy(record) : undefined;
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
    this.#verificationIdsByRun.clear();
    this.#verificationCandidates.clear();
    this.#releases.clear();
    this.#releaseByHash.clear();
    this.#releaseByRun.clear();
    this.#releaseInstallations.clear();
    this.#gitHubDraftPullRequests.clear();
    this.#idempotency.clear();
    this.#analysisAvailableAt.clear();
    this.#websiteAuthenticationCheckpoints.clear();
    this.#websiteLiveReceiptEvidence.clear();
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

export function normalizeReleaseInstallation(
  input: ReleaseInstallationRequest,
  release: ReleaseRecord,
): ReleaseInstallationRequest {
  const plans = plansFromManifest(release.manifest);
  const expectedTools = plans?.map(({ tool }) => tool.name).sort(compareCodePoints);
  const releaseArtifactIdentity = persistedReleaseArtifactIdentity(release);
  let page: URL;
  let artifact: URL;
  try {
    page = new URL(input.pageUrl);
    artifact = new URL(input.artifactUrl);
  } catch {
    throw new RepositoryError("INVALID_STATE");
  }
  const selfHosted = input.selfHostedUrl ? safeUrl(input.selfHostedUrl) : undefined;
  const canonicalAttestation = canonicalJson(input.attestation);
  const attestation = canonicalAttestation === "__INVALID_JSON__"
    ? undefined : JSON.parse(canonicalAttestation) as InstalledVerificationObservation;
  if (!plans || !expectedTools || expectedTools.length === 0
    || !releaseArtifactIdentity
    || page.origin !== release.allowedOrigin || page.protocol !== "https:" || page.username || page.password
    || page.search || page.hash
    || artifact.toString() !== releaseArtifactIdentity.artifactUrl || input.artifactUrl !== releaseArtifactIdentity.artifactUrl
    || input.downloadUrl !== releaseArtifactIdentity.downloadUrl || input.localOnly !== releaseArtifactIdentity.localOnly
    || input.targetOrigin !== release.allowedOrigin || input.artifactContentHash !== release.contentHash
    || input.integrity !== release.sri || !equalStringArrays(input.expectedTools, expectedTools)
    || input.delivery === "self_hosted" && (!selfHosted || selfHosted.origin !== release.allowedOrigin)
    || input.delivery === "hosted" && input.selfHostedUrl !== undefined
    || input.status === "verified" && input.webMcpImplementation !== "native"
    || input.status === "verified" && input.delivery === "hosted" && input.csp.hosted !== "allowed"
    || input.status === "pending_self_host" && (input.delivery !== "hosted" || input.csp.hosted !== "blocked")
    || input.csp.directive !== undefined && (input.csp.directive.length > 512 || /[\r\n]/.test(input.csp.directive))
    || canonicalAttestation === "__INVALID_JSON__" || Buffer.byteLength(canonicalAttestation) > 16_384
    || !validVerifierIdentity(input.verifierIdentity, input.verifierIdentity.mode)
    || !attestation || !installedObservationMatches(input, releaseArtifactIdentity, release.manifest, plans, attestation)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    || !/^[0-9a-f]{64}$/.test(input.inputHash)) throw new RepositoryError("INVALID_STATE");
  return {
    ...copy(input),
    expectedTools,
    verifierIdentity: copy(input.verifierIdentity),
    attestation,
  };
}

function withoutGitHubRecordIdentity(record: GitHubDraftPullRequestRecord): Omit<GitHubDraftPullRequestRecord, "id" | "createdAt"> {
  const identity = { ...record } as {
    -readonly [Key in keyof GitHubDraftPullRequestRecord]?: GitHubDraftPullRequestRecord[Key]
  };
  delete identity.id;
  delete identity.createdAt;
  return identity as Omit<GitHubDraftPullRequestRecord, "id" | "createdAt">;
}

export function normalizeGitHubDraftPullRequest(
  input: GitHubDraftPullRequestRecord,
  material: WorkflowExecutionMaterial,
): GitHubDraftPullRequestRecord {
  const sourceEvidence = material.analysis.evidence.find(({ source }) => source === "github");
  let evidence: Record<string, unknown> | undefined;
  try {
    const value: unknown = sourceEvidence ? JSON.parse(sourceEvidence.content) : undefined;
    evidence = isPlainRecord(value) ? value : undefined;
  } catch {
    evidence = undefined;
  }
  const expectedUrl = `https://github.com/${input.owner}/${input.repository}/pull/${input.number}`;
  const checkKeys = Object.keys(input.check).sort(compareCodePoints).join(",");
  const allowedConclusions = [
    "action_required", "cancelled", "failure", "neutral", "success", "skipped", "stale", "timed_out",
  ];
  if (material.sourceType !== "github" || material.workflowRunId !== input.workflowRunId
    || material.projectId !== input.projectId || material.sourceSnapshotId !== input.sourceSnapshotId
    || material.analysisRunId !== input.analysisRunId
    || input.organizationId.length === 0 || !["publish", "install_verify"].includes(input.phase)
    || !Number.isSafeInteger(input.installationId) || input.installationId <= 0
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.owner)
    || !/^[A-Za-z0-9._-]{1,100}$/.test(input.repository)
    || !/^refs\/(?:heads|tags)\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,252})$/.test(input.requestedRef)
    || input.requestedRef.split("/").some((part) => part === "." || part === "..")
    || !/^[a-f0-9]{40}$/.test(input.baseCommitSha) || !/^[a-f0-9]{64}$/.test(input.patchDigest)
    || !/^page2webmcp\/[a-f0-9]{16}$/.test(input.branch)
    || !Number.isSafeInteger(input.number) || input.number <= 0 || input.number > 2_147_483_647
    || input.url !== expectedUrl || !/^[a-f0-9]{40}$/.test(input.headCommitSha)
    || input.headCommitSha === input.baseCommitSha || input.draft !== true || input.merged !== false
    || !/^wfx_[a-f0-9]{64}$/.test(input.check.externalId)
    || !["queued", "in_progress", "completed"].includes(input.check.status)
    || input.check.conclusion !== undefined && !allowedConclusions.includes(input.check.conclusion)
    || !["externalId,status", "conclusion,externalId,status"].includes(checkKeys)
    || !/^urn:sha256:[a-f0-9]{64}$/.test(input.sandboxReference)
    || input.previewReference !== undefined && !/^urn:sha256:[a-f0-9]{64}$/.test(input.previewReference)
    || input.phase === "install_verify" && (input.check.status !== "completed" || input.check.conclusion !== "success")
    || !/^wfx_[a-f0-9]{64}$/.test(input.sideEffectIdempotencyKey)
    || !/^[a-f0-9]{64}$/.test(input.sideEffectInputHash) || !/^[a-f0-9]{64}$/.test(input.outputHash)
    || input.outputReference !== `urn:sha256:${input.outputHash}`
    || evidence?.adapter !== "github-nextjs-source" || evidence.adapterVersion !== 1
    || evidence.installationId !== input.installationId || evidence.repositoryId !== input.repositoryId
    || evidence.repository !== `${input.owner}/${input.repository}` || evidence.requestedRef !== input.requestedRef
    || evidence.commitSha !== input.baseCommitSha) throw new RepositoryError("INVALID_STATE");
  return copy(input);
}

export function gitHubDraftPullRequestMatchesRequest(
  record: GitHubDraftPullRequestRecord,
  input: SaveGitHubDraftPullRequestRequest,
): boolean {
  const expected: SaveGitHubDraftPullRequestRequest = {
    workflowRunId: record.workflowRunId,
    analysisRunId: record.analysisRunId,
    installationId: record.installationId,
    repositoryId: record.repositoryId,
    owner: record.owner,
    repository: record.repository,
    requestedRef: record.requestedRef,
    baseCommitSha: record.baseCommitSha,
    patchDigest: record.patchDigest,
    branch: record.branch,
    number: record.number,
    headCommitSha: record.headCommitSha,
    draft: record.draft,
    merged: record.merged,
    check: record.check,
    sandboxReference: record.sandboxReference,
    ...(record.previewReference ? { previewReference: record.previewReference } : {}),
    sideEffectIdempotencyKey: record.sideEffectIdempotencyKey,
    sideEffectInputHash: record.sideEffectInputHash,
    outputHash: record.outputHash,
    outputReference: record.outputReference,
  };
  return canonicalJson(expected) === canonicalJson(input);
}

function validVerifierIdentity(
  identity: VerifierIdentityRecord,
  mode: VerifierIdentityRecord["mode"],
): boolean {
  return isPlainRecord(identity)
    && Object.keys(identity).sort(compareCodePoints).join(",")
      === "mode,protocolVersion,verifierOriginDigest,webMcpImplementation"
    && identity.protocolVersion === (mode === "live" ? 2 : 1)
    && identity.mode === mode
    && identity.webMcpImplementation === "native"
    && /^[0-9a-f]{64}$/.test(identity.verifierOriginDigest);
}

function installedObservationMatches(
  input: ReleaseInstallationRequest,
  identity: Extract<ReleaseArtifactIdentity, { artifactUrl: string }>,
  manifest: unknown,
  plans: readonly CapabilityPlan[],
  report: InstalledVerificationObservation,
): boolean {
  const expectedTools = plans.map(({ tool }) => tool.name).sort(compareCodePoints);
  const expectedKeys = [
    "csp", "duplicateLoadHarmless", "executedArtifactUrl", "executedContentHash", "executionEvidence",
    "injectedRegistration", "normalPageLoad", "observedArtifactUrl", "observedDownloadUrl",
    "observedIntegrity", "observedLocalOnly", "observedTargetOrigin", "registeredTools", "routeInterception",
    "servedContentHash", "syntheticHarness", "webMcpImplementation",
    ...(input.verifierIdentity.mode === "live" ? ["verifierAttestation"] : []),
  ].sort(compareCodePoints).join(",");
  let verifierAttestation: VerifierAttestationIdentityRecordV2 | undefined;
  try {
    verifierAttestation = input.verifierIdentity.mode === "live"
      ? normalizeVerifierAttestationIdentity(report.verifierAttestation!, "installation")
      : undefined;
  } catch { return false; }
  const payload = {
    pageUrl: input.pageUrl,
    artifactUrl: input.artifactUrl,
    downloadUrl: input.downloadUrl,
    localOnly: input.localOnly,
    contentHash: input.artifactContentHash,
    integrity: input.integrity,
    manifest,
    targetOrigin: input.targetOrigin,
    expectedTools,
    ...(input.selfHostedUrl ? { selfHostedUrl: input.selfHostedUrl } : {}),
  };
  if (!isPlainRecord(report) || Object.keys(report).sort(compareCodePoints).join(",") !== expectedKeys
    || report.observedArtifactUrl !== identity.artifactUrl
    || report.observedDownloadUrl !== identity.downloadUrl || report.observedLocalOnly !== identity.localOnly
    || report.observedIntegrity !== input.integrity || report.observedTargetOrigin !== input.targetOrigin
    || report.servedContentHash !== input.artifactContentHash || report.normalPageLoad !== true
    || report.routeInterception !== false || report.injectedRegistration !== false
    || report.syntheticHarness !== false || report.webMcpImplementation !== input.webMcpImplementation
    || !isPlainRecord(report.csp) || report.csp.hosted !== input.csp.hosted
    || report.csp.directive !== input.csp.directive
    || input.verifierIdentity.mode === "live" && verifierAttestation?.payloadDigest
      !== createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")) return false;
  if (input.status === "pending_self_host") {
    return report.executedArtifactUrl === null && report.executedContentHash === null
      && report.duplicateLoadHarmless === null && Array.isArray(report.registeredTools)
      && report.registeredTools.length === 0 && report.executionEvidence === null;
  }
  return report.executedArtifactUrl === (input.selfHostedUrl ?? identity.artifactUrl)
    && report.executedContentHash === input.artifactContentHash
    && report.duplicateLoadHarmless === true
    && equalStringArrays(report.registeredTools, expectedTools)
    && installedExecutionEvidenceMatches(report.executionEvidence, plans);
}

function installedExecutionEvidenceMatches(value: unknown, plans: readonly CapabilityPlan[]): boolean {
  if (!plainRecordWithKeys(value, ["authenticatedRead", "authoritativeFinalState", "confirmedReversibleMutation"])) {
    return false;
  }
  const read = value.authenticatedRead;
  const mutation = value.confirmedReversibleMutation;
  const finalState = value.authoritativeFinalState;
  if (!plainRecordWithKeys(read, ["authenticated", "succeeded", "toolName"])
    || !plainRecordWithKeys(mutation, ["confirmation", "effectCount", "reversible", "succeeded", "toolName"])
    || !plainRecordWithKeys(finalState, ["mutationToolName", "source", "verified"])
    || typeof read.toolName !== "string" || typeof mutation.toolName !== "string"
    || !/^[a-z][a-z0-9_]{0,63}$/.test(read.toolName) || !/^[a-z][a-z0-9_]{0,63}$/.test(mutation.toolName)
    || read.toolName === mutation.toolName || finalState.mutationToolName !== mutation.toolName
    || read.authenticated !== true || read.succeeded !== true
    || mutation.confirmation !== "explicit" || mutation.reversible !== true || mutation.succeeded !== true
    || mutation.effectCount !== 1
    || finalState.source !== "target" || finalState.verified !== true) return false;
  const readPlan = plans.find(({ tool }) => tool.name === read.toolName);
  const mutationPlan = plans.find(({ tool }) => tool.name === mutation.toolName);
  return readPlan?.effects.kind === "read" && readPlan.annotations.readOnly
    && ["same_origin_cookie", "browser_oauth"].includes(readPlan.authentication.mode)
    && mutationPlan?.effects.kind === "mutation" && !mutationPlan.annotations.readOnly
    && mutationPlan.effects.reversible && mutationPlan.effects.confirmation === "always";
}

function plainRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const HOSTED_RELEASE_ARTIFACT_PREFIX =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const LOCAL_RELEASE_ARTIFACT_PREFIX =
  "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases";

export function normalizeReleaseArtifactIdentity(
  input: Readonly<{ artifactUrl: string; downloadUrl: string; localOnly: boolean }>,
  contentHash: string,
): Extract<ReleaseArtifactIdentity, { artifactUrl: string }> {
  if (!input || typeof input.artifactUrl !== "string" || typeof input.downloadUrl !== "string"
    || typeof input.localOnly !== "boolean" || !/^[0-9a-f]{64}$/.test(contentHash)
    || input.artifactUrl.length > 2_048 || input.downloadUrl.length > 2_048) {
    throw new RepositoryError("INVALID_STATE");
  }
  const prefix = input.localOnly ? LOCAL_RELEASE_ARTIFACT_PREFIX : HOSTED_RELEASE_ARTIFACT_PREFIX;
  const artifactUrl = `${prefix}/${contentHash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${contentHash}.js`;
  if (input.artifactUrl !== artifactUrl || input.downloadUrl !== downloadUrl) {
    throw new RepositoryError("INVALID_STATE");
  }
  return { artifactUrl, downloadUrl, localOnly: input.localOnly };
}

export function persistedReleaseArtifactIdentity(
  release: Pick<ReleaseRecord, "contentHash" | "artifactUrl" | "downloadUrl" | "localOnly">,
): Extract<ReleaseArtifactIdentity, { artifactUrl: string }> | undefined {
  const present = release.artifactUrl !== undefined || release.downloadUrl !== undefined || release.localOnly !== undefined;
  if (!present) return undefined;
  if (release.artifactUrl === undefined || release.downloadUrl === undefined || release.localOnly === undefined) {
    throw new RepositoryError("INVALID_STATE");
  }
  return normalizeReleaseArtifactIdentity({
    artifactUrl: release.artifactUrl,
    downloadUrl: release.downloadUrl,
    localOnly: release.localOnly,
  }, release.contentHash);
}

function releaseMatchesPublication(release: ReleaseRecord, input: PublishRequest): boolean {
  let artifactIdentity: Extract<ReleaseArtifactIdentity, { artifactUrl: string }> | undefined;
  try {
    artifactIdentity = persistedReleaseArtifactIdentity(release);
  } catch {
    return false;
  }
  return release.projectId === input.projectId
    && release.analysisRunId === input.analysisRunId
    && release.capabilityStateDigest === input.capabilityStateDigest
    && release.contentHash === input.candidateContentHash
    && release.verificationRunId === input.verificationRunId
    && artifactIdentity !== undefined
    && artifactIdentity.artifactUrl === input.artifactUrl
    && artifactIdentity.downloadUrl === input.downloadUrl
    && artifactIdentity.localOnly === input.localOnly;
}

function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : undefined;
  } catch {
    return undefined;
  }
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(compareCodePoints);
  const b = [...right].sort(compareCodePoints);
  return a.length === b.length && new Set(a).size === a.length && a.every((value, index) => value === b[index]);
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

function normalizeWorkflowTaskEvent(input: WorkflowTaskEventInput): WorkflowEventPayload {
  if (!input || typeof input !== "object" || ![
    "task.side_effect_started", "task.side_effect_completed", "task.side_effect_failed",
  ].includes(input.type) || !input.payload || typeof input.payload !== "object") {
    throw new RepositoryError("INVALID_STATE");
  }
  const payload = input.payload;
  const allowed = input.type === "task.side_effect_started"
    ? ["inputHash", "operation"]
    : input.type === "task.side_effect_completed"
      ? ["costMicros", "durationMs", "inputHash", "operation", "outputHash", "version"]
      : ["durationMs", "inputHash", "operation", "outcome"];
  if (Object.keys(payload).some((key) => !allowed.includes(key))
    || typeof payload.operation !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(payload.operation)
    || typeof payload.inputHash !== "string" || !/^[0-9a-f]{64}$/.test(payload.inputHash)
    || input.type !== "task.side_effect_started" && (!Number.isSafeInteger(payload.durationMs)
      || payload.durationMs! < 0 || payload.durationMs! > 3_600_000)
    || input.type === "task.side_effect_completed" && (typeof payload.outputHash !== "string"
      || !/^[0-9a-f]{64}$/.test(payload.outputHash))
    || payload.version !== undefined && (typeof payload.version !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(payload.version))
    || payload.costMicros !== undefined && (!Number.isSafeInteger(payload.costMicros)
      || payload.costMicros < 0 || payload.costMicros > 1_000_000_000)
    || input.type === "task.side_effect_failed" && payload.outcome !== "failure") {
    throw new RepositoryError("INVALID_STATE");
  }
  return copy(payload);
}

function workflowTaskIdempotencyKey(runId: string, phase: WorkflowTaskRecord["phase"], inputHash: string): string {
  const normalizedHash = stableHash(inputHash);
  return `wft_${stableHash(`${runId.length}:${runId}:${phase.length}:${phase}:${normalizedHash}`)}`;
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

function normalizeWebsiteAuthenticationReference(value: string): string {
  if (typeof value !== "string" || !/^urn:sha256:[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
  return value;
}

function normalizeWebsiteAuthenticationDigest(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RepositoryError("INVALID_STATE");
  }
  return value;
}

function normalizeWebsiteAuthenticationWaitInput(
  input: WaitAnalysisForAuthenticationInput,
  now: Date,
): WaitAnalysisForAuthenticationInput {
  assertIdempotencyKey(input.idempotencyKey);
  stableHash(input.inputHash);
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry - now.getTime() > 10 * 60_000) {
    throw new RepositoryError("INVALID_STATE");
  }
  const suspensionEvidence = normalizeWebsiteSuspensionEvidence(input.suspensionEvidence);
  if (suspensionEvidence.checkpoint.checkpointReference !== input.checkpointReference
    || suspensionEvidence.checkpoint.sourceSnapshotId !== input.sourceSnapshotId
    || suspensionEvidence.checkpoint.sourceIdentityHash !== input.sourceIdentityHash
    || suspensionEvidence.checkpoint.targetOriginDigest !== input.targetOriginDigest
    || suspensionEvidence.checkpoint.expiresAt !== new Date(expiry).toISOString()) {
    throw new RepositoryError("INVALID_STATE");
  }
  return {
    ...input,
    checkpointReference: normalizeWebsiteAuthenticationReference(input.checkpointReference),
    sourceIdentityHash: normalizeWebsiteAuthenticationDigest(input.sourceIdentityHash),
    targetOriginDigest: normalizeWebsiteAuthenticationDigest(input.targetOriginDigest),
    expiresAt: new Date(expiry).toISOString(),
    suspensionEvidence,
  };
}

export function normalizeWebsiteSuspensionEvidence(
  value: WebsiteAuthenticationSuspensionEvidence,
): WebsiteAuthenticationSuspensionEvidence {
  const reference = (candidate: unknown): string => {
    if (typeof candidate !== "string" || !/^urn:sha256:[0-9a-f]{64}$/.test(candidate)) {
      throw new RepositoryError("INVALID_STATE");
    }
    return candidate;
  };
  const identifier = (candidate: unknown): string => {
    if (typeof candidate !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate)) {
      throw new RepositoryError("INVALID_STATE");
    }
    return candidate;
  };
  const instant = (candidate: unknown): string => {
    if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))
      || new Date(candidate).toISOString() !== candidate) throw new RepositoryError("INVALID_STATE");
    return candidate;
  };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== 1 || value.browserUse?.adapter !== "browser-use-v4"
    || value.browserUse.adapterVersion !== 4 || value.browserUse.apiVersion !== "v4"
    || value.browserUse.model !== "browser-use-2.0"
    || !Number.isSafeInteger(value.suspendedLeaseGeneration) || value.suspendedLeaseGeneration < 1
    || !Array.isArray(value.ttlSecrets) || value.ttlSecrets.length !== 2) {
    throw new RepositoryError("INVALID_STATE");
  }
  const ttlSecrets = [...value.ttlSecrets].map((item) => ({
    purpose: normalizeWebsiteTtlSecretPurpose(item?.purpose),
    referenceDigest: normalizeWebsiteAuthenticationDigest(item?.referenceDigest),
    expiresAt: instant(item?.expiresAt),
  })).sort((left, right) => compareCodePoints(left.purpose, right.purpose));
  if (ttlSecrets[0]?.purpose !== "browser_cdp_url" || ttlSecrets[1]?.purpose !== "browser_live_url"
    || new Set(ttlSecrets.map(({ referenceDigest }) => referenceDigest)).size !== 2) {
    throw new RepositoryError("INVALID_STATE");
  }
  const normalized: WebsiteAuthenticationSuspensionEvidence = {
    schemaVersion: 1,
    ownershipDecisionDigest: normalizeWebsiteAuthenticationDigest(value.ownershipDecisionDigest),
    providerSessionIdentityDigest: normalizeWebsiteAuthenticationDigest(value.providerSessionIdentityDigest),
    browserUse: {
      adapter: "browser-use-v4",
      adapterVersion: 4,
      apiVersion: "v4",
      model: "browser-use-2.0",
      policyDigest: normalizeWebsiteAuthenticationDigest(value.browserUse.policyDigest),
    },
    browserLease: {
      identityDigest: normalizeWebsiteAuthenticationDigest(value.browserLease?.identityDigest),
      expiresAt: instant(value.browserLease?.expiresAt),
    },
    egressPolicy: {
      referenceDigest: normalizeWebsiteAuthenticationDigest(value.egressPolicy?.referenceDigest),
      policyDigest: normalizeWebsiteAuthenticationDigest(value.egressPolicy?.policyDigest),
    },
    cdpReferenceDigest: normalizeWebsiteAuthenticationDigest(value.cdpReferenceDigest),
    publicEvidenceReference: reference(value.publicEvidenceReference),
    ttlSecrets: ttlSecrets as WebsiteAuthenticationTtlSecretEvidence[],
    checkpoint: {
      checkpointReference: reference(value.checkpoint?.checkpointReference),
      sourceSnapshotId: identifier(value.checkpoint?.sourceSnapshotId),
      sourceIdentityHash: normalizeWebsiteAuthenticationDigest(value.checkpoint?.sourceIdentityHash),
      targetOriginDigest: normalizeWebsiteAuthenticationDigest(value.checkpoint?.targetOriginDigest),
      expiresAt: instant(value.checkpoint?.expiresAt),
    },
    suspendedWorkerIdentityDigest: normalizeWebsiteAuthenticationDigest(value.suspendedWorkerIdentityDigest),
    suspendedLeaseGeneration: value.suspendedLeaseGeneration,
  };
  if (normalized.browserLease.expiresAt !== normalized.checkpoint.expiresAt
    || normalized.ttlSecrets.some(({ expiresAt }) => expiresAt !== normalized.checkpoint.expiresAt)
    || normalized.cdpReferenceDigest !== normalized.ttlSecrets[0]!.referenceDigest
    || canonicalJson(value) !== canonicalJson(normalized)
    || Buffer.byteLength(canonicalJson(normalized), "utf8") > 8_192) {
    throw new RepositoryError("INVALID_STATE");
  }
  return normalized;
}

function normalizeWebsiteTtlSecretPurpose(value: unknown): WebsiteAuthenticationTtlSecretEvidence["purpose"] {
  if (value !== "browser_cdp_url" && value !== "browser_live_url") {
    throw new RepositoryError("INVALID_STATE");
  }
  return value;
}

export function websiteReferenceDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function websiteWorkerIdentityDigest(workerId: string): string {
  assertWorkerId(workerId);
  return websiteReferenceDigest(workerId);
}

export function initialWebsiteCleanupResources(
  evidence: WebsiteAuthenticationSuspensionEvidence,
): WebsiteAuthenticationCleanupResourceEvidence[] {
  return [
    { resource: "authentication_handoff_checkpoint", identityDigest: websiteReferenceDigest(
      evidence.checkpoint.checkpointReference,
    ), disposition: "pending" },
    { resource: "browser_lease", identityDigest: evidence.browserLease.identityDigest, disposition: "pending" },
    { resource: "browser_session", identityDigest: evidence.providerSessionIdentityDigest, disposition: "pending" },
    { resource: "cdp_observation_lease", identityDigest: evidence.cdpReferenceDigest, disposition: "pending" },
    { resource: "egress_policy_proxy", identityDigest: evidence.egressPolicy.referenceDigest, disposition: "pending" },
    { resource: "evidence_lease", identityDigest: websiteReferenceDigest(
      evidence.publicEvidenceReference,
    ), disposition: "pending" },
    { resource: "ttl_secrets", identityDigest: websiteReferenceDigest(JSON.stringify(evidence.ttlSecrets)),
      disposition: "pending" },
  ];
}

const WEBSITE_CLEANUP_TERMINAL_DISPOSITIONS: Readonly<
  Record<WebsiteAuthenticationCleanupResourceKind, ReadonlySet<WebsiteAuthenticationCleanupDisposition>>
> = {
  authentication_handoff_checkpoint: new Set(["destroyed", "reconciled"]),
  browser_lease: new Set(["released", "reconciled"]),
  browser_session: new Set(["destroyed", "reconciled"]),
  cdp_observation_lease: new Set(["released", "reconciled"]),
  egress_policy_proxy: new Set(["revoked", "reconciled"]),
  evidence_lease: new Set(["released", "retained_immutable"]),
  ttl_secrets: new Set(["destroyed", "revoked"]),
};

export function normalizeWebsiteCleanupResources(
  value: readonly WebsiteAuthenticationCleanupResourceEvidence[],
  expected?: readonly WebsiteAuthenticationCleanupResourceEvidence[],
): WebsiteAuthenticationCleanupResourceEvidence[] {
  if (!Array.isArray(value) || value.length !== 7
    || Buffer.byteLength(canonicalJson(value), "utf8") > 16_384) throw new RepositoryError("INVALID_STATE");
  const normalized = value.map((item): WebsiteAuthenticationCleanupResourceEvidence => {
    if (!isPlainRecord(item)
      || typeof item.resource !== "string" || !(item.resource in WEBSITE_CLEANUP_TERMINAL_DISPOSITIONS)
      || typeof item.identityDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.identityDigest)
      || typeof item.disposition !== "string") throw new RepositoryError("INVALID_STATE");
    const resource = item.resource as WebsiteAuthenticationCleanupResourceKind;
    const disposition = item.disposition as WebsiteAuthenticationCleanupDisposition;
    const terminal = WEBSITE_CLEANUP_TERMINAL_DISPOSITIONS[resource];
    if (disposition !== "pending" && disposition !== "failed" && !terminal.has(disposition)) {
      throw new RepositoryError("INVALID_STATE");
    }
    const keys = Object.keys(item).sort(compareCodePoints).join(",");
    if (item.disposition === "pending") {
      if (keys !== "disposition,identityDigest,resource") throw new RepositoryError("INVALID_STATE");
      return { resource, identityDigest: item.identityDigest, disposition: "pending" as const };
    }
    if (typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp))
      || new Date(item.timestamp).toISOString() !== item.timestamp) throw new RepositoryError("INVALID_STATE");
    if (item.disposition === "failed") {
      if (keys !== "disposition,errorCode,identityDigest,resource,timestamp"
        || typeof item.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.errorCode)) {
        throw new RepositoryError("INVALID_STATE");
      }
      return { resource, identityDigest: item.identityDigest, disposition: "failed" as const,
        timestamp: item.timestamp, errorCode: item.errorCode };
    }
    if (keys !== "disposition,identityDigest,resource,timestamp") throw new RepositoryError("INVALID_STATE");
    return { resource, identityDigest: item.identityDigest, disposition, timestamp: item.timestamp };
  }).sort((left, right) => compareCodePoints(left.resource, right.resource));
  if (new Set(normalized.map(({ resource }) => resource)).size !== 7) throw new RepositoryError("INVALID_STATE");
  if (expected) {
    const identities = new Map(expected.map(({ resource, identityDigest }) => [resource, identityDigest]));
    if (normalized.some(({ resource, identityDigest }) => identities.get(resource) !== identityDigest)) {
      throw new RepositoryError("INVALID_STATE");
    }
  }
  return normalized;
}

export function advanceWebsiteCleanupResources(
  stored: readonly WebsiteAuthenticationCleanupResourceEvidence[],
  updates: readonly WebsiteAuthenticationCleanupResourceEvidence[],
): WebsiteAuthenticationCleanupResourceEvidence[] {
  const normalizedStored = normalizeWebsiteCleanupResources(stored);
  if (!Array.isArray(updates) || updates.length > 7) throw new RepositoryError("INVALID_STATE");
  const byResource = new Map(normalizedStored.map((item) => [item.resource, item]));
  for (const update of updates) {
    const existing = byResource.get(update.resource);
    if (!existing) throw new RepositoryError("INVALID_STATE");
    const normalizedUpdate = normalizeWebsiteCleanupResources([
      ...normalizedStored.filter(({ resource }) => resource !== update.resource), update,
    ], normalizedStored).find(({ resource }) => resource === update.resource)!;
    if (existing.disposition !== "pending" && existing.disposition !== "failed") {
      if (canonicalJson(existing) !== canonicalJson(normalizedUpdate)) throw new RepositoryError("INVALID_STATE");
      continue;
    }
    if (normalizedUpdate.disposition === "pending"
      || existing.timestamp && normalizedUpdate.timestamp
        && Date.parse(normalizedUpdate.timestamp) < Date.parse(existing.timestamp)) {
      throw new RepositoryError("INVALID_STATE");
    }
    byResource.set(update.resource, normalizedUpdate);
  }
  return [...byResource.values()].sort((left, right) => compareCodePoints(left.resource, right.resource));
}

export function acknowledgeWebsiteAuthenticationCompletion(
  evidence: WebsiteLiveReceiptEvidence,
  workerId: string,
  leaseGeneration: number,
  acknowledgedAt: string,
): WebsiteLiveReceiptEvidence {
  assertWorkerId(workerId);
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1
    || !Number.isFinite(Date.parse(acknowledgedAt))
    || new Date(acknowledgedAt).toISOString() !== acknowledgedAt
    || !evidence.resumedWorkerIdentityDigest || !evidence.resumeLeaseGeneration
    || evidence.resumeAcknowledgedAt || evidence.completionWorkerIdentityDigest
    || evidence.completionLeaseGeneration) {
    throw new RepositoryError("INVALID_STATE");
  }
  const completionWorkerIdentityDigest = websiteWorkerIdentityDigest(workerId);
  return {
    ...evidence,
    completionWorkerIdentityDigest,
    completionLeaseGeneration: leaseGeneration,
    resumeAcknowledgedAt: acknowledgedAt,
    restartVerified: completionWorkerIdentityDigest !== evidence.suspendedWorkerIdentityDigest,
  };
}

export function websiteAuthenticationResultCheckpoint(
  evidence: WebsiteLiveReceiptEvidence,
): WebsiteAuthenticationResultCheckpoint | undefined {
  const values = [evidence.resultCheckpointHash, evidence.resultCheckpointOutputReference,
    evidence.resultCheckpointWorkerIdentityDigest, evidence.resultCheckpointLeaseGeneration,
    evidence.resultCheckpointedAt];
  if (values.every((value) => value === undefined)) return undefined;
  if (!/^[0-9a-f]{64}$/.test(evidence.resultCheckpointHash ?? "")
    || !/^urn:sha256:[0-9a-f]{64}$/.test(evidence.resultCheckpointOutputReference ?? "")
    || !/^[0-9a-f]{64}$/.test(evidence.resultCheckpointWorkerIdentityDigest ?? "")
    || !Number.isSafeInteger(evidence.resultCheckpointLeaseGeneration)
    || (evidence.resultCheckpointLeaseGeneration ?? 0) < 1
    || typeof evidence.resultCheckpointedAt !== "string"
    || !Number.isFinite(Date.parse(evidence.resultCheckpointedAt))
    || new Date(evidence.resultCheckpointedAt).toISOString() !== evidence.resultCheckpointedAt) {
    throw new RepositoryError("INVALID_STATE");
  }
  return {
    resultHash: evidence.resultCheckpointHash!,
    outputReference: evidence.resultCheckpointOutputReference!,
    leaseGeneration: evidence.resultCheckpointLeaseGeneration!,
    checkpointedAt: evidence.resultCheckpointedAt,
  };
}

export function websiteSuspensionEvidenceMatches(
  stored: WebsiteLiveReceiptEvidence,
  expected: WebsiteAuthenticationSuspensionEvidence,
): boolean {
  const suspension = copy(stored) as Record<string, unknown>;
  for (const key of ["authenticationEvidenceReferenceDigest", "authenticationConsumedAt",
    "resumedWorkerIdentityDigest", "resumeLeaseGeneration", "resumeClaimedAt", "resumeAcknowledgedAt",
    "resultCheckpointHash", "resultCheckpointOutputReference", "resultCheckpointWorkerIdentityDigest",
    "resultCheckpointLeaseGeneration", "resultCheckpointedAt", "completionWorkerIdentityDigest",
    "completionLeaseGeneration", "restartVerified", "cleanupResources"]) delete suspension[key];
  return canonicalJson(suspension) === canonicalJson(expected);
}

export function websiteAuthenticationWaitCommandHash(
  inputHash: string,
  suspensionEvidence: WebsiteAuthenticationSuspensionEvidence,
): string {
  return stableHash(canonicalJson({
    inputHash: stableHash(inputHash),
    suspensionEvidence: normalizeWebsiteSuspensionEvidence(suspensionEvidence),
  }));
}

function normalizeWebsiteAuthenticationResumeInput(
  input: ResumeAnalysisAfterAuthenticationInput,
): ResumeAnalysisAfterAuthenticationInput {
  assertIdempotencyKey(input.idempotencyKey);
  stableHash(input.inputHash);
  return {
    ...input,
    checkpointReference: normalizeWebsiteAuthenticationReference(input.checkpointReference),
    authenticationEvidenceReference: normalizeWebsiteAuthenticationReference(input.authenticationEvidenceReference),
    sourceIdentityHash: normalizeWebsiteAuthenticationDigest(input.sourceIdentityHash),
    targetOriginDigest: normalizeWebsiteAuthenticationDigest(input.targetOriginDigest),
  };
}

function normalizeWebsiteAuthenticationTerminalInput(
  input: TerminateAnalysisAuthenticationInput,
): TerminateAnalysisAuthenticationInput {
  assertIdempotencyKey(input.idempotencyKey);
  stableHash(input.inputHash);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== input.expiresAt
    || !["failed", "expired"].includes(input.terminalState)) throw new RepositoryError("INVALID_STATE");
  return {
    ...input,
    checkpointReference: normalizeWebsiteAuthenticationReference(input.checkpointReference),
    sourceIdentityHash: normalizeWebsiteAuthenticationDigest(input.sourceIdentityHash),
    targetOriginDigest: normalizeWebsiteAuthenticationDigest(input.targetOriginDigest),
  };
}

function websiteTargetOriginDigest(sourceUrl: string): string {
  let origin: string;
  try { origin = new URL(sourceUrl).origin; }
  catch { throw new RepositoryError("INVALID_STATE"); }
  return createHash("sha256").update(origin, "utf8").digest("hex");
}

function websiteAuthenticationWaitMatches(
  checkpoint: WebsiteAuthenticationCheckpointRecord,
  input: WaitAnalysisForAuthenticationInput,
): boolean {
  return checkpoint.checkpointReference === input.checkpointReference
    && checkpoint.sourceSnapshotId === input.sourceSnapshotId
    && checkpoint.sourceIdentityHash === input.sourceIdentityHash
    && checkpoint.targetOriginDigest === input.targetOriginDigest
    && checkpoint.expiresAt === input.expiresAt;
}

function websiteAuthenticationResumeMatches(
  checkpoint: WebsiteAuthenticationCheckpointRecord,
  input: ResumeAnalysisAfterAuthenticationInput,
): boolean {
  return checkpoint.analysisRunId === input.runId
    && checkpoint.checkpointReference === input.checkpointReference
    && checkpoint.sourceSnapshotId === input.sourceSnapshotId
    && checkpoint.sourceIdentityHash === input.sourceIdentityHash
    && checkpoint.targetOriginDigest === input.targetOriginDigest
    && (checkpoint.authenticationEvidenceReference === undefined
      || checkpoint.authenticationEvidenceReference === input.authenticationEvidenceReference);
}

function websiteAuthenticationTerminalMatches(
  checkpoint: WebsiteAuthenticationCheckpointRecord,
  input: TerminateAnalysisAuthenticationInput,
): boolean {
  return checkpoint.analysisRunId === input.runId
    && checkpoint.checkpointReference === input.checkpointReference
    && checkpoint.sourceSnapshotId === input.sourceSnapshotId
    && checkpoint.sourceIdentityHash === input.sourceIdentityHash
    && checkpoint.targetOriginDigest === input.targetOriginDigest
    && checkpoint.expiresAt === input.expiresAt;
}

function publicWebsiteAuthenticationCheckpoint(
  checkpoint: StoredWebsiteAuthenticationCheckpoint,
): WebsiteAuthenticationCheckpointRecord {
  return copy({
    organizationId: checkpoint.organizationId,
    projectId: checkpoint.projectId,
    analysisRunId: checkpoint.analysisRunId,
    workflowTaskId: checkpoint.workflowTaskId,
    sourceSnapshotId: checkpoint.sourceSnapshotId,
    sourceIdentityHash: checkpoint.sourceIdentityHash,
    targetOriginDigest: checkpoint.targetOriginDigest,
    checkpointReference: checkpoint.checkpointReference,
    ...(checkpoint.authenticationEvidenceReference
      ? { authenticationEvidenceReference: checkpoint.authenticationEvidenceReference }
      : {}),
    state: checkpoint.state,
    expiresAt: checkpoint.expiresAt,
    ...(checkpoint.consumedAt ? { consumedAt: checkpoint.consumedAt } : {}),
    ...(checkpoint.terminalAt ? { terminalAt: checkpoint.terminalAt } : {}),
    ...(checkpoint.cleanupStatus ? {
      cleanupStatus: checkpoint.cleanupStatus,
      cleanupAttempts: checkpoint.cleanupAttempts,
      ...(checkpoint.cleanupCompletedAt ? { cleanupCompletedAt: checkpoint.cleanupCompletedAt } : {}),
      ...(checkpoint.cleanupErrorCode ? { cleanupErrorCode: checkpoint.cleanupErrorCode } : {}),
    } : {}),
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
  });
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
