import { createHash } from "node:crypto";
import type {
  ControlPlaneRepository,
  RepositoryActor,
  WebsiteAuthenticationCheckpointRecord,
} from "../../../packages/database/src/control-plane.ts";
import { RepositoryError } from "../../../packages/database/src/control-plane.ts";
import type { WorkflowRunRecord, WorkflowTaskRecord } from "../../../packages/database/src/workflow.ts";
import { ApiError } from "./api.ts";
import type {
  WebsiteAuthenticationHandoffBinding,
  WebsiteAuthenticationHandoffState,
  WebsiteOwnershipState,
  WebsiteUserHandoffBinding,
} from "./website-user-handoff.ts";

export type PublicWebsiteAuthenticationState = Readonly<{
  state: "waiting" | "ready" | "resumed" | "expired" | "failed" | "cancelled";
  targetOrigin: string;
  expiresAt: string;
  canAct: boolean;
  portalUrl?: string;
}>;

export type WebsiteAuthenticationHandoffContext = Readonly<{
  binding: WebsiteAuthenticationHandoffBinding;
  checkpoint: WebsiteAuthenticationCheckpointRecord;
  workflow: WorkflowRunRecord;
  task: WorkflowTaskRecord;
}>;

export async function loadWebsiteUserHandoffBinding(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  projectId: string,
  run?: Pick<WorkflowRunRecord, "projectId" | "sourceSnapshotId">,
): Promise<WebsiteUserHandoffBinding> {
  if (run && run.projectId !== projectId) throw new ApiError("NOT_FOUND", 404);
  const project = await repository.getProject(actor, projectId);
  if (project.sourceType !== "website") throw new ApiError("SOURCE_TYPE_UNSUPPORTED", 409);
  const [sources, snapshots] = await Promise.all([
    repository.listProjectSources(actor, project.id),
    repository.listSourceSnapshots(actor, project.id),
  ]);
  const snapshot = run
    ? snapshots.find(({ id }) => id === run.sourceSnapshotId)
    : snapshots.filter(({ projectSourceId }) =>
      sources.some(({ id, active }) => active && id === projectSourceId)).at(-1);
  const source = snapshot
    ? sources.find(({ id }) => id === snapshot.projectSourceId)
    : undefined;
  if (!source || !snapshot || source.sourceType !== "website"
    || source.sourceConfiguration.kind !== "website"
    || !run && !source.active) throw new ApiError("WEBSITE_SOURCE_BINDING_INVALID", 409);
  let sourceUrl: URL;
  try { sourceUrl = new URL(source.sourceUrl); }
  catch { throw new ApiError("WEBSITE_SOURCE_BINDING_INVALID", 409); }
  if (sourceUrl.protocol !== "https:" || sourceUrl.search || sourceUrl.hash
    || source.projectId !== project.id || snapshot.projectId !== project.id
    || source.organizationId !== actor.organizationId || snapshot.organizationId !== actor.organizationId) {
    throw new ApiError("WEBSITE_SOURCE_BINDING_INVALID", 409);
  }
  return {
    organizationId: actor.organizationId,
    projectId: project.id,
    projectSourceId: source.id,
    sourceSnapshotId: snapshot.id,
    sourceIdentityHash: snapshot.sourceIdentityHash,
    sourceUrl: source.sourceUrl,
    targetOrigin: sourceUrl.origin,
  };
}

export async function loadWebsiteAuthenticationHandoffContext(
  repository: ControlPlaneRepository,
  actor: RepositoryActor,
  workflowRunId: string,
): Promise<WebsiteAuthenticationHandoffContext> {
  const workflow = await repository.getWorkflowRun(actor, workflowRunId);
  const project = await repository.getProject(actor, workflow.projectId);
  if (project.sourceType !== "website" || !workflow.analysisRunId) throw new ApiError("NOT_FOUND", 404);
  const [checkpoint, tasks, source] = await Promise.all([
    repository.getWebsiteAuthenticationWait(actor, workflow.analysisRunId),
    repository.listWorkflowTasks(actor, workflow.id),
    loadWebsiteUserHandoffBinding(repository, actor, project.id, workflow),
  ]);
  const task = checkpoint
    ? tasks.find((candidate) => candidate.id === checkpoint.workflowTaskId)
    : undefined;
  if (!checkpoint || !task || checkpoint.organizationId !== actor.organizationId
    || checkpoint.projectId !== project.id || checkpoint.analysisRunId !== workflow.analysisRunId
    || checkpoint.workflowTaskId !== task.id || task.workflowRunId !== workflow.id
    || task.organizationId !== actor.organizationId || task.projectId !== project.id || task.phase !== "analysis"
    || checkpoint.sourceSnapshotId !== workflow.sourceSnapshotId
    || checkpoint.sourceSnapshotId !== source.sourceSnapshotId
    || checkpoint.sourceIdentityHash !== source.sourceIdentityHash
    || checkpoint.targetOriginDigest !== createHash("sha256").update(source.targetOrigin, "utf8").digest("hex")
    || checkpoint.checkpointReference !== task.checkpointReference) {
    throw new ApiError("NOT_FOUND", 404);
  }
  assertAuthenticationLifecycle(workflow, task, checkpoint);
  return {
    workflow,
    task,
    checkpoint,
    binding: {
      organizationId: actor.organizationId,
      projectId: project.id,
      workflowRunId: workflow.id,
      analysisRunId: workflow.analysisRunId,
      workflowTaskId: task.id,
      sourceSnapshotId: checkpoint.sourceSnapshotId,
      sourceIdentityHash: checkpoint.sourceIdentityHash,
      targetOrigin: source.targetOrigin,
      targetOriginDigest: checkpoint.targetOriginDigest,
      checkpointReference: checkpoint.checkpointReference,
      expiresAt: checkpoint.expiresAt,
    },
  };
}

function assertAuthenticationLifecycle(
  workflow: WorkflowRunRecord,
  task: WorkflowTaskRecord,
  checkpoint: WebsiteAuthenticationCheckpointRecord,
): void {
  if (checkpoint.state === "waiting") {
    if (workflow.status !== "waiting" || task.status !== "waiting"
      || task.waitReason !== "external_authentication" || task.waitExpiresAt !== checkpoint.expiresAt) {
      throw new ApiError("NOT_FOUND", 404);
    }
    return;
  }
  if (checkpoint.state === "consumed") {
    if (!checkpoint.authenticationEvidenceReference
      || !["queued", "running", "succeeded"].includes(workflow.status)
      || !["queued", "running", "succeeded"].includes(task.status)) {
      throw new ApiError("NOT_FOUND", 404);
    }
    return;
  }
  if (checkpoint.state === "cancelled") {
    if (workflow.status !== "cancelled" || task.status !== "cancelled") throw new ApiError("NOT_FOUND", 404);
    return;
  }
  if (["expired", "failed"].includes(checkpoint.state)) {
    if (workflow.status !== "failed" || task.status !== "failed") throw new ApiError("NOT_FOUND", 404);
    return;
  }
  if (checkpoint.state !== "completed" || workflow.status !== "succeeded" || task.status !== "succeeded") {
    throw new ApiError("NOT_FOUND", 404);
  }
}

export function publicAuthenticationState(
  context: WebsiteAuthenticationHandoffContext,
  canAct: boolean,
  external?: WebsiteAuthenticationHandoffState,
  now = new Date(),
): PublicWebsiteAuthenticationState {
  const { checkpoint, binding } = context;
  if (checkpoint.state === "consumed" || checkpoint.state === "completed") {
    return {
      state: "resumed",
      targetOrigin: binding.targetOrigin,
      expiresAt: checkpoint.expiresAt,
      canAct: false,
    };
  }
  if (["expired", "failed", "cancelled"].includes(checkpoint.state)) {
    return {
      state: checkpoint.state as "expired" | "failed" | "cancelled",
      targetOrigin: binding.targetOrigin,
      expiresAt: checkpoint.expiresAt,
      canAct: false,
    };
  }
  if (Date.parse(checkpoint.expiresAt) <= now.getTime()) {
    return {
      state: "expired",
      targetOrigin: binding.targetOrigin,
      expiresAt: checkpoint.expiresAt,
      canAct: false,
    };
  }
  if (!external) {
    return { state: "waiting", targetOrigin: binding.targetOrigin, expiresAt: checkpoint.expiresAt, canAct };
  }
  if (external.targetOrigin !== binding.targetOrigin || external.expiresAt !== checkpoint.expiresAt) {
    throw new ApiError("WEBSITE_HANDOFF_RESPONSE_INVALID", 502);
  }
  return {
    state: external.state,
    targetOrigin: binding.targetOrigin,
    expiresAt: checkpoint.expiresAt,
    canAct: canAct && ["waiting", "ready"].includes(external.state),
    ...(external.state === "waiting" && external.portalUrl && canAct ? { portalUrl: external.portalUrl } : {}),
  };
}

export function websiteAuthenticationProjection(
  workflow: WorkflowRunRecord,
  tasks: readonly WorkflowTaskRecord[],
  checkpoint: WebsiteAuthenticationCheckpointRecord | undefined,
) {
  if (!checkpoint || !["waiting", "consumed", "failed", "cancelled", "expired"].includes(checkpoint.state)
    || checkpoint.analysisRunId !== workflow.analysisRunId
    || checkpoint.projectId !== workflow.projectId
    || checkpoint.sourceSnapshotId !== workflow.sourceSnapshotId) return undefined;
  const task = tasks.find((candidate) => candidate.id === checkpoint.workflowTaskId);
  if (!task || task.workflowRunId !== workflow.id || task.phase !== "analysis") return undefined;
  if (checkpoint.state === "waiting" && (workflow.status !== "waiting" || task.status !== "waiting"
    || task.waitReason !== "external_authentication" || task.waitExpiresAt !== checkpoint.expiresAt)) return undefined;
  if (checkpoint.state === "consumed" && (!checkpoint.authenticationEvidenceReference
    || !["queued", "running", "succeeded"].includes(workflow.status)
    || !["queued", "running", "succeeded"].includes(task.status))) return undefined;
  if (checkpoint.state === "cancelled" && (workflow.status !== "cancelled" || task.status !== "cancelled")) {
    return undefined;
  }
  if (["failed", "expired"].includes(checkpoint.state)
    && (workflow.status !== "failed" || task.status !== "failed")) return undefined;
  return {
    endpoint: `/api/workflow-runs/${workflow.id}/website-authentication`,
    state: checkpoint.state === "waiting" && Date.parse(checkpoint.expiresAt) <= Date.now()
      ? "expired"
      : checkpoint.state === "consumed" ? "resumed" : checkpoint.state,
  } as const;
}

export function websiteUserHandoffApiError(error: unknown): unknown {
  if (error instanceof ApiError || error instanceof RepositoryError) return error;
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : "WEBSITE_HANDOFF_UNAVAILABLE";
  const status: Readonly<Record<string, number>> = {
    WEBSITE_LIVE_CONFIGURATION_REQUIRED: 503,
    WEBSITE_HANDOFF_ABORTED: 409,
    WEBSITE_HANDOFF_INPUT_INVALID: 400,
    WEBSITE_HANDOFF_PROTOCOL_UNSUPPORTED: 503,
    WEBSITE_HANDOFF_RESPONSE_INVALID: 502,
    WEBSITE_HANDOFF_TIMEOUT: 504,
    WEBSITE_HANDOFF_UNAVAILABLE: 502,
    WEBSITE_OWNERSHIP_REQUIRED: 409,
  };
  if (!(code in status)) return error;
  return new ApiError(code, status[code]!,
    code === "WEBSITE_HANDOFF_TIMEOUT" || code === "WEBSITE_HANDOFF_UNAVAILABLE");
}

export function publicOwnershipState(state: WebsiteOwnershipState): WebsiteOwnershipState {
  if (state.state === "pending" && state.method === "dns_txt") {
    return {
      state: "pending",
      method: "dns_txt",
      targetOrigin: state.targetOrigin,
      expiresAt: state.expiresAt,
      instructions: {
        recordName: state.instructions.recordName,
        recordType: "TXT",
        recordValue: state.instructions.recordValue,
      },
    };
  }
  if (state.state === "pending" && state.method === "well_known") {
    return {
      state: "pending",
      method: "well_known",
      targetOrigin: state.targetOrigin,
      expiresAt: state.expiresAt,
      instructions: { url: state.instructions.url, content: state.instructions.content },
    };
  }
  return {
    state: state.state,
    targetOrigin: state.targetOrigin,
    ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}),
  };
}

export function websiteUserHandoffProjection(
  projectId: string,
  authentication?: ReturnType<typeof websiteAuthenticationProjection>,
) {
  return {
    ownership: {
      endpoint: `/api/projects/${projectId}/website-ownership`,
      requiredBeforeAnalysis: true,
    },
    ...(authentication ? { authentication } : {}),
  } as const;
}
