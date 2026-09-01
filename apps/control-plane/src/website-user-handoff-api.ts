import type {
  ControlPlaneRepository,
  RepositoryActor,
} from "../../../packages/database/src/control-plane.ts";
import { RepositoryError } from "../../../packages/database/src/control-plane.ts";
import type { WorkflowRunRecord } from "../../../packages/database/src/workflow.ts";
import { ApiError } from "./api.ts";
import type {
  WebsiteOwnershipState,
  WebsiteUserHandoffBinding,
} from "./website-user-handoff.ts";

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

export function websiteUserHandoffProjection(projectId: string) {
  return {
    ownership: {
      endpoint: `/api/projects/${projectId}/website-ownership`,
      requiredBeforeAnalysis: true,
    },
  } as const;
}
