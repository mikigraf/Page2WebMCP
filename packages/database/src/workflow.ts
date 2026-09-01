import { createHash } from "node:crypto";

export const WORKFLOW_LEASE_MS = 60_000;
export const WORKFLOW_HEARTBEAT_MS = 15_000;
export const WORKFLOW_MAX_ATTEMPTS = 3;
export const WORKFLOW_MAX_RETRY_AFTER_MS = 5 * 60_000;
export const WORKFLOW_DEFAULT_ACTIVE_TASK_QUOTA = 2;

export type WorkflowPhase =
  | "analysis"
  | "preflight"
  | "ownership"
  | "browser_auth"
  | "explore"
  | "propose"
  | "review_wait"
  | "controlled_mutation_verification"
  | "compile"
  | "candidate_verify"
  | "publish"
  | "install_verify";

export type ProductionWorkflowPhase = Exclude<WorkflowPhase, "analysis">;

export type SourceConfiguration =
  | Readonly<{
    kind: "openapi";
    targetOrigin: string;
    testPageUrl: string;
    environment: "test" | "staging" | "production";
  }>
  | Readonly<{ kind: "website" }>
  | Readonly<{ kind: "github" }>;

export const WORKFLOW_PHASE_REGISTRY: readonly Readonly<{
  phase: ProductionWorkflowPhase;
  execution: "worker" | "wait";
  next?: ProductionWorkflowPhase;
}>[] = Object.freeze([
  { phase: "preflight", execution: "worker", next: "ownership" },
  { phase: "ownership", execution: "wait", next: "browser_auth" },
  { phase: "browser_auth", execution: "wait", next: "explore" },
  { phase: "explore", execution: "worker", next: "propose" },
  { phase: "propose", execution: "worker", next: "review_wait" },
  { phase: "review_wait", execution: "wait", next: "controlled_mutation_verification" },
  { phase: "controlled_mutation_verification", execution: "worker", next: "compile" },
  { phase: "compile", execution: "worker", next: "candidate_verify" },
  { phase: "candidate_verify", execution: "worker", next: "publish" },
  { phase: "publish", execution: "worker", next: "install_verify" },
  { phase: "install_verify", execution: "worker" },
]);

export const WORKFLOW_PHASES = new Set<WorkflowPhase>([
  "analysis",
  ...WORKFLOW_PHASE_REGISTRY.map(({ phase }) => phase),
]);

export type WorkflowRunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type WorkflowTaskStatus = WorkflowRunStatus;
export type WorkflowRetryClassification = "transient" | "rate_limited" | "permanent";

export type ProjectSourceRecord = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  sourceType: "website" | "openapi" | "github";
  sourceUrl: string;
  sourceConfiguration: SourceConfiguration;
  version: number;
  active: boolean;
  createdAt: string;
}>;

export type SourceSnapshotRecord = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  projectSourceId: string;
  sourceIdentityHash: string;
  artifactReference?: string;
  contentHash?: string;
  sourceArtifact?: ImmutableSourceArtifactIdentity;
  isFixture: boolean;
  createdAt: string;
}>;

export type ImmutableSourceArtifactIdentity = Readonly<{
  contentHash: string;
  artifactReference: string;
  finalUrl: string;
  mimeType: string;
  sizeBytes: number;
}>;

export type WorkflowRunRecord = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  sourceSnapshotId: string;
  analysisRunId?: string;
  reviewedAnalysisRunId?: string;
  status: WorkflowRunStatus;
  currentPhase: WorkflowPhase;
  inputHash: string;
  version: number;
  cancelRequestedAt?: string;
  cancelledAt?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkflowTaskRecord = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  workflowRunId: string;
  phase: WorkflowPhase;
  status: WorkflowTaskStatus;
  idempotencyKey: string;
  inputHash: string;
  outputHash?: string;
  checkpointReference?: string;
  outputReference?: string;
  waitKeyHash?: string;
  waitReason?: string;
  waitExpiresAt?: string;
  resumedAt?: string;
  cancelRequestedAt?: string;
  cancelledAt?: string;
  leaseGeneration: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attempts: number;
  maxAttempts: number;
  retryClassification?: WorkflowRetryClassification;
  errorCode?: string;
  availableAt: string;
  reconciledAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ClaimedWorkflowTaskRecord = Readonly<WorkflowTaskRecord & {
  status: "running";
  leaseOwner: string;
  leaseExpiresAt: string;
}>;

export type WorkflowEventType =
  | "workflow.created"
  | "workflow.completed"
  | "workflow.failed"
  | "workflow.cancel_requested"
  | "workflow.cancelled"
  | "workflow.reconciled"
  | "task.created"
  | "task.claimed"
  | "task.heartbeat"
  | "task.completed"
  | "task.retry_scheduled"
  | "task.failed"
  | "task.waiting"
  | "task.resumed"
  | "task.cancelled"
  | "task.reconciled"
  | "task.side_effect_started"
  | "task.side_effect_completed"
  | "task.side_effect_failed";

export type WorkflowEventPayload = Readonly<{
  operation?: string;
  inputHash?: string;
  outputHash?: string;
  durationMs?: number;
  version?: string;
  costMicros?: number;
  outcome?: "failure";
}>;

export type WorkflowEventRecord = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  workflowRunId: string;
  taskId?: string;
  sequence: number;
  version: number;
  type: WorkflowEventType;
  code?: string;
  payload?: WorkflowEventPayload;
  createdAt: string;
}>;

export type WorkflowTaskEventInput = Readonly<{
  type: Extract<WorkflowEventType,
    "task.side_effect_started" | "task.side_effect_completed" | "task.side_effect_failed">;
  payload: WorkflowEventPayload;
}>;

export type WorkflowEvidenceLink = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  workflowRunId: string;
  taskId: string;
  evidenceId?: string;
  reference: string;
  createdAt: string;
}>;

export type WorkflowCapabilityPlanLink = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  workflowRunId: string;
  taskId: string;
  capabilityId: string;
  planDigest: string;
  createdAt: string;
}>;

export type WorkflowActor = Readonly<{
  id: string;
  organizationId: string;
  role: "owner" | "editor" | "viewer";
}>;

export type WorkflowIdempotentCommand = Readonly<{
  idempotencyKey: string;
  inputHash: string;
}>;

export type StartWorkflowInput = WorkflowIdempotentCommand & Readonly<{
  projectId: string;
  analysisRunId?: string;
}>;
export type CompleteWorkflowTaskInput = WorkflowIdempotentCommand & Readonly<{
  checkpointReference?: string;
  outputReference?: string;
}>;
export type FailWorkflowTaskInput = WorkflowIdempotentCommand & Readonly<{
  errorCode: string;
  classification: WorkflowRetryClassification;
  retryAfterMs?: number;
}>;
export type WaitWorkflowTaskInput = WorkflowIdempotentCommand & Readonly<{
  reason: string;
  expiresAt: string;
}>;
export type ResumeWorkflowTaskInput = WorkflowIdempotentCommand & Readonly<{
  runId: string;
  waitToken: string;
}>;
export type CancelWorkflowInput = WorkflowIdempotentCommand & Readonly<{ runId: string }>;

export type WorkflowTaskCompletion = Readonly<{
  run: WorkflowRunRecord;
  task: WorkflowTaskRecord;
  nextTask?: WorkflowTaskRecord;
}>;

export interface WorkflowRepository {
  listProjectSources(actor: WorkflowActor, projectId: string): Promise<ProjectSourceRecord[]>;
  listSourceSnapshots(actor: WorkflowActor, projectId: string): Promise<SourceSnapshotRecord[]>;
  startWorkflow(actor: WorkflowActor, input: StartWorkflowInput): Promise<WorkflowRunRecord>;
  getWorkflowRun(actor: WorkflowActor, runId: string): Promise<WorkflowRunRecord>;
  listWorkflowTasks(actor: WorkflowActor, runId: string): Promise<WorkflowTaskRecord[]>;
  listWorkflowEvents(actor: WorkflowActor, runId: string): Promise<WorkflowEventRecord[]>;
  listWorkflowEvidence(actor: WorkflowActor, runId: string): Promise<WorkflowEvidenceLink[]>;
  listWorkflowCapabilityPlans(actor: WorkflowActor, runId: string): Promise<WorkflowCapabilityPlanLink[]>;
  claimWorkflowTask(workerId: string): Promise<ClaimedWorkflowTaskRecord | undefined>;
  assertWorkflowTaskLease(workerId: string, taskId: string, leaseGeneration: number): Promise<void>;
  recordWorkflowTaskEvent(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: WorkflowTaskEventInput,
  ): Promise<WorkflowEventRecord>;
  heartbeatWorkflowTask(workerId: string, taskId: string, leaseGeneration: number): Promise<WorkflowTaskRecord>;
  completeWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: CompleteWorkflowTaskInput,
  ): Promise<WorkflowTaskCompletion>;
  failWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: FailWorkflowTaskInput,
  ): Promise<WorkflowTaskRecord>;
  waitWorkflowTask(
    workerId: string,
    taskId: string,
    leaseGeneration: number,
    input: WaitWorkflowTaskInput,
  ): Promise<Readonly<{ task: WorkflowTaskRecord; waitToken: string }>>;
  resumeWorkflowTask(actor: WorkflowActor, input: ResumeWorkflowTaskInput): Promise<WorkflowTaskRecord>;
  cancelWorkflow(actor: WorkflowActor, input: CancelWorkflowInput): Promise<WorkflowRunRecord>;
  reconcileWorkflows(workerId: string): Promise<number>;
}

export function workflowPhase(phase: ProductionWorkflowPhase) {
  return WORKFLOW_PHASE_REGISTRY.find((entry) => entry.phase === phase)!;
}

export function workflowRetryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Math.max(1, Math.min(Math.floor(attempt), WORKFLOW_MAX_ATTEMPTS));
  const exponentialCap = Math.min(60_000, 1_000 * 2 ** (boundedAttempt - 1));
  const sample = Math.max(0, Math.min(random(), 0.999999999));
  const jitter = Math.floor(exponentialCap * sample);
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) return jitter;
  return Math.min(WORKFLOW_MAX_RETRY_AFTER_MS, Math.max(jitter, Math.max(0, Math.floor(retryAfterMs))));
}

export type WorkflowSideEffectResult = Readonly<{
  outputReference: string;
  outputHash: string;
  version?: string;
  costMicros?: number;
}>;

export type WorkflowSideEffectRequest = Readonly<{
  workerId: string;
  taskId: string;
  workflowRunId: string;
  phase: WorkflowPhase;
  leaseGeneration: number;
  idempotencyKey: string;
  kind: string;
  inputHash: string;
  signal: AbortSignal;
}>;

export interface WorkflowSideEffectPort {
  lookup(input: WorkflowSideEffectRequest): Promise<WorkflowSideEffectResult | undefined>;
  execute(input: WorkflowSideEffectRequest): Promise<WorkflowSideEffectResult>;
  reconcile(input: WorkflowSideEffectRequest): Promise<WorkflowSideEffectResult | undefined>;
  cleanup(input: WorkflowSideEffectRequest): Promise<void>;
}

export type WorkflowPhaseHandler = (context: Readonly<{
  task: ClaimedWorkflowTaskRecord;
  signal: AbortSignal;
  sideEffect(kind: string, inputHash: string): Promise<WorkflowSideEffectResult>;
}>) => Promise<WorkflowPhaseResult>;

export type WorkflowPhaseFailure = Readonly<{
  errorCode: string;
  classification: WorkflowRetryClassification;
  retryAfterMs?: number;
}>;

export type WorkflowPhaseResult = Readonly<{
  checkpointReference?: string;
  outputReference?: string;
  failure?: undefined;
}> | Readonly<{
  checkpointReference?: undefined;
  outputReference?: undefined;
  failure: WorkflowPhaseFailure;
}>;

function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : "WORKFLOW_PHASE_FAILED";
}

function errorClassification(error: unknown): WorkflowRetryClassification {
  const code = errorCode(error);
  return /(?:CONFIGURATION|VALIDATION|_INVALID|_REQUIRED|_UNSUPPORTED|_POLICY)/.test(code)
    ? "permanent"
    : "transient";
}

function validatePhaseFailure(failure: WorkflowPhaseFailure): WorkflowPhaseFailure {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.errorCode)
    || !["transient", "rate_limited", "permanent"].includes(failure.classification)
    || failure.retryAfterMs !== undefined && (!Number.isFinite(failure.retryAfterMs) || failure.retryAfterMs < 0)
    || failure.retryAfterMs !== undefined && failure.classification !== "rate_limited") {
    throw new Error("WORKFLOW_PHASE_FAILURE_INVALID");
  }
  return failure;
}

function validateSideEffectResult(result: WorkflowSideEffectResult | undefined): WorkflowSideEffectResult | undefined {
  if (!result) return undefined;
  if (!/^urn:sha256:[0-9a-f]{64}$/.test(result.outputReference)
    || !/^[0-9a-f]{64}$/.test(result.outputHash)
    || result.version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(result.version)
    || result.costMicros !== undefined && (!Number.isSafeInteger(result.costMicros)
      || result.costMicros < 0 || result.costMicros > 1_000_000_000)) {
    throw new Error("WORKFLOW_SIDE_EFFECT_RESULT_INVALID");
  }
  return result;
}

export class WorkflowController {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly configuration: Readonly<{
      handlers: Partial<Record<WorkflowPhase, WorkflowPhaseHandler>>;
      sideEffects: Readonly<Record<string, WorkflowSideEffectPort>>;
      heartbeatMs?: number;
    }>,
  ) {}

  async runNext(workerId: string, signal: AbortSignal = new AbortController().signal): Promise<WorkflowTaskRecord | undefined> {
    const task = await this.repository.claimWorkflowTask(workerId);
    if (!task) return undefined;
    const handler = this.configuration.handlers[task.phase];
    if (!handler) {
      await this.repository.failWorkflowTask(workerId, task.id, task.leaseGeneration, {
        idempotencyKey: `controller-no-handler-${task.id}`,
        inputHash: "CONTROLLER_PHASE_HANDLER_REQUIRED",
        errorCode: "CONTROLLER_PHASE_HANDLER_REQUIRED",
        classification: "permanent",
      });
      throw new Error("CONTROLLER_PHASE_HANDLER_REQUIRED");
    }
    const lifecycle = new AbortController();
    const abortLifecycle = () => lifecycle.abort(signal.reason ?? new Error("WORKFLOW_CANCELLED"));
    if (signal.aborted) abortLifecycle();
    else signal.addEventListener("abort", abortLifecycle, { once: true });
    let heartbeatFailure: unknown;
    const heartbeatMs = Math.max(10, Math.min(this.configuration.heartbeatMs
      ?? WORKFLOW_HEARTBEAT_MS, WORKFLOW_HEARTBEAT_MS));
    const heartbeat = (async () => {
      while (!lifecycle.signal.aborted) {
        await workflowDelay(heartbeatMs, lifecycle.signal);
        if (lifecycle.signal.aborted) return;
        try {
          await this.repository.heartbeatWorkflowTask(workerId, task.id, task.leaseGeneration);
        } catch (error) {
          heartbeatFailure = error;
          lifecycle.abort(error);
          return;
        }
      }
    })();
    const used = new Map<string, Readonly<{ port: WorkflowSideEffectPort; request: WorkflowSideEffectRequest }>>();
    const results = new Map<string, WorkflowSideEffectResult>();
    const sideEffect = async (kind: string, inputHash: string): Promise<WorkflowSideEffectResult> => {
      if (!/^[a-z][a-z0-9._:-]{0,127}$/.test(kind)) throw new Error("WORKFLOW_SIDE_EFFECT_KIND_INVALID");
      const port = this.configuration.sideEffects[kind];
      if (!port) throw new Error("WORKFLOW_SIDE_EFFECT_PORT_REQUIRED");
      await this.repository.assertWorkflowTaskLease(workerId, task.id, task.leaseGeneration);
      if (lifecycle.signal.aborted) throw heartbeatFailure ?? new Error("WORKFLOW_CANCELLED");
      const normalizedInputHash = /^[0-9a-f]{64}$/.test(inputHash)
        ? inputHash
        : createHash("sha256").update(inputHash, "utf8").digest("hex");
      const digest = createHash("sha256").update(`${task.id}\0${kind}\0${normalizedInputHash}`, "utf8").digest("hex");
      const idempotencyKey = `wfx_${digest}`;
      const cached = results.get(idempotencyKey);
      if (cached) return cached;
      const request: WorkflowSideEffectRequest = {
        workerId,
        taskId: task.id,
        workflowRunId: task.workflowRunId,
        phase: task.phase,
        leaseGeneration: task.leaseGeneration,
        idempotencyKey,
        kind,
        inputHash: normalizedInputHash,
        signal: lifecycle.signal,
      };
      used.set(idempotencyKey, { port, request });
      const startedAt = Date.now();
      await this.repository.recordWorkflowTaskEvent(workerId, task.id, task.leaseGeneration, {
        type: "task.side_effect_started",
        payload: { operation: kind, inputHash: normalizedInputHash },
      });
      try {
        let result = validateSideEffectResult(await port.lookup(request));
        if (!result) {
          try {
            result = validateSideEffectResult(await port.execute(request));
          } catch (error) {
            result = validateSideEffectResult(await port.reconcile(request));
            if (!result) throw error;
          }
        }
        if (!result) throw new Error("WORKFLOW_SIDE_EFFECT_RESULT_INVALID");
        await this.repository.recordWorkflowTaskEvent(workerId, task.id, task.leaseGeneration, {
          type: "task.side_effect_completed",
          payload: {
            operation: kind,
            inputHash: normalizedInputHash,
            outputHash: result.outputHash,
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(result.version === undefined ? {} : { version: result.version }),
            ...(result.costMicros === undefined ? {} : { costMicros: result.costMicros }),
          },
        });
        results.set(idempotencyKey, result);
        return result;
      } catch (error) {
        await this.repository.recordWorkflowTaskEvent(workerId, task.id, task.leaseGeneration, {
          type: "task.side_effect_failed",
          payload: {
            operation: kind,
            inputHash: normalizedInputHash,
            durationMs: Math.max(0, Date.now() - startedAt),
            outcome: "failure",
          },
        });
        throw error;
      }
    };
    try {
      let output: Awaited<ReturnType<WorkflowPhaseHandler>>;
      try {
        output = await handler({ task, signal: lifecycle.signal, sideEffect });
      } finally {
        lifecycle.abort();
        await heartbeat;
        signal.removeEventListener("abort", abortLifecycle);
      }
      if (heartbeatFailure) throw heartbeatFailure;
      if (signal.aborted) throw new Error("WORKFLOW_CANCELLED");
      if (output.failure) {
        const failure = validatePhaseFailure(output.failure);
        return await this.repository.failWorkflowTask(workerId, task.id, task.leaseGeneration, {
          idempotencyKey: `controller-fail-${task.id}-${task.leaseGeneration}`,
          inputHash: createHash("sha256").update(JSON.stringify(failure), "utf8").digest("hex"),
          errorCode: failure.errorCode,
          classification: failure.classification,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        });
      }
      const completion = await this.repository.completeWorkflowTask(workerId, task.id, task.leaseGeneration, {
        idempotencyKey: `controller-complete-${task.id}-${task.leaseGeneration}`,
        inputHash: createHash("sha256").update(JSON.stringify(output), "utf8").digest("hex"),
        ...output,
      });
      return completion.task;
    } catch (error) {
      if (!(error instanceof Error && ["LEASE_LOST", "CANCELLED"].includes(error.message))) {
        try {
          await this.repository.failWorkflowTask(workerId, task.id, task.leaseGeneration, {
            idempotencyKey: `controller-fail-${task.id}-${task.leaseGeneration}`,
            inputHash: errorCode(error),
            errorCode: errorCode(error),
            classification: errorClassification(error),
          });
        } catch {
          // Lease loss/cancellation is authoritative; keep the original error.
        }
      }
      throw error;
    } finally {
      lifecycle.abort();
      await heartbeat;
      signal.removeEventListener("abort", abortLifecycle);
      await Promise.allSettled([...used.values()].map(({ port, request }) => port.cleanup(request)));
    }
  }
}

async function workflowDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
