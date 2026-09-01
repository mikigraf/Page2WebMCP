import { createHash } from "node:crypto";
import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireActor,
  requireMutationActor,
  successResponse,
} from "../../../../../src/api.ts";
import {
  loadWebsiteAuthenticationHandoffContext,
  publicAuthenticationState,
  websiteUserHandoffApiError,
} from "../../../../../src/website-user-handoff-api.ts";
import { websiteAuthenticationHandoffPort } from "../../../../../src/website-user-handoff.ts";

const RunIdSchema = z.string().uuid();
const MutationSchema = z.object({ action: z.enum(["check", "cancel"]) }).strict();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireActor(request, repository);
    const runId = parsedRunId((await context.params).runId);
    const handoff = await loadWebsiteAuthenticationHandoffContext(repository, actor, runId);
    const canAct = actor.role !== "viewer";
    const durable = publicAuthenticationState(handoff, canAct);
    if (!canAct || durable.state !== "waiting") {
      return successResponse({ authentication: durable }, requestId);
    }
    const external = await websiteAuthenticationHandoffPort()
      .loadAuthenticationPortal(handoff.binding, request.signal);
    return successResponse({
      authentication: external.state === "waiting"
        ? publicAuthenticationState(handoff, true, external)
        : durable,
    }, requestId);
  } catch (error) {
    return errorResponse(websiteUserHandoffApiError(error), requestId, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    const runId = parsedRunId((await context.params).runId);
    const handoff = await loadWebsiteAuthenticationHandoffContext(repository, actor, runId);
    if (actor.role === "viewer") throw new ApiError("FORBIDDEN", 403);
    const input = await parseJsonBody(request, MutationSchema);
    const callerIdempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(callerIdempotencyKey)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const idempotencyKey = commandIdempotencyKey(input.action, handoff.binding);

    if (input.action === "check") {
      if (["consumed", "completed"].includes(handoff.checkpoint.state)) {
        return successResponse({ authentication: publicAuthenticationState(handoff, false) }, requestId);
      }
      if (handoff.checkpoint.state !== "waiting") {
        return successResponse({ authentication: publicAuthenticationState(handoff, false) }, requestId);
      }
      const durable = publicAuthenticationState(handoff, true);
      if (durable.state === "expired") {
        await repository.terminateAnalysisAuthentication(actor, {
          ...terminalCommand(handoff.binding, "expired"),
          idempotencyKey,
          inputHash: commandHash("check", handoff.binding, "expired"),
        });
        const expired = await loadWebsiteAuthenticationHandoffContext(repository, actor, runId);
        return successResponse({ authentication: publicAuthenticationState(expired, false) }, requestId);
      }
      if (durable.state !== "waiting") {
        return successResponse({ authentication: durable }, requestId);
      }
      const external = await websiteAuthenticationHandoffPort()
        .checkAuthentication(handoff.binding, idempotencyKey, request.signal);
      if (external.state !== "ready") {
        if (external.state === "cancelled") {
          await repository.cancelWorkflow(actor, {
            runId: handoff.workflow.id,
            idempotencyKey: commandIdempotencyKey("cancel", handoff.binding),
            inputHash: commandHash("cancel", handoff.binding),
          });
          const cancelled = await loadWebsiteAuthenticationHandoffContext(repository, actor, runId);
          return successResponse({ authentication: publicAuthenticationState(cancelled, false) }, requestId);
        }
        if (external.state === "expired" && Date.parse(handoff.binding.expiresAt) > Date.now()) {
          throw new ApiError("WEBSITE_HANDOFF_RESPONSE_INVALID", 502);
        }
        if (external.state === "failed" || external.state === "expired") {
          await repository.terminateAnalysisAuthentication(actor, {
            ...terminalCommand(handoff.binding, external.state),
            idempotencyKey,
            inputHash: commandHash("check", handoff.binding, external.state),
          });
          const terminal = await loadWebsiteAuthenticationHandoffContext(repository, actor, runId);
          return successResponse({ authentication: publicAuthenticationState(terminal, false) }, requestId);
        }
        return successResponse({
          authentication: publicAuthenticationState(handoff, true, external),
        }, requestId);
      }
      await repository.resumeAnalysisAfterAuthentication(actor, {
        runId: handoff.binding.analysisRunId,
        checkpointReference: handoff.binding.checkpointReference,
        authenticationEvidenceReference: external.authenticationEvidenceReference,
        sourceSnapshotId: handoff.binding.sourceSnapshotId,
        sourceIdentityHash: handoff.binding.sourceIdentityHash,
        targetOriginDigest: handoff.binding.targetOriginDigest,
        idempotencyKey,
        inputHash: commandHash("check", handoff.binding, external.authenticationEvidenceReference),
      });
      const resumed = await loadWebsiteAuthenticationHandoffContext(repository, actor, runId);
      return successResponse({ authentication: publicAuthenticationState(resumed, false) }, requestId);
    }

    if (!["waiting", "cancelled"].includes(handoff.checkpoint.state)) {
      throw new ApiError("INVALID_STATE", 409);
    }
    await repository.cancelWorkflow(actor, {
      runId: handoff.workflow.id,
      idempotencyKey,
      inputHash: commandHash("cancel", handoff.binding),
    });
    const cancelled = await loadWebsiteAuthenticationHandoffContext(repository, actor, runId);
    return successResponse({ authentication: publicAuthenticationState(cancelled, false) }, requestId);
  } catch (error) {
    return errorResponse(websiteUserHandoffApiError(error), requestId, request);
  }
}

function terminalCommand(
  binding: Parameters<typeof commandHash>[1],
  terminalState: "failed" | "expired",
) {
  return {
    runId: binding.analysisRunId,
    checkpointReference: binding.checkpointReference,
    sourceSnapshotId: binding.sourceSnapshotId,
    sourceIdentityHash: binding.sourceIdentityHash,
    targetOriginDigest: binding.targetOriginDigest,
    expiresAt: binding.expiresAt,
    terminalState,
  } as const;
}

function parsedRunId(value: string): string {
  const parsed = RunIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("NOT_FOUND", 404);
  return parsed.data;
}

function commandHash(
  action: "check" | "cancel",
  binding: Readonly<{
    organizationId: string;
    projectId: string;
    workflowRunId: string;
    analysisRunId: string;
    workflowTaskId: string;
    sourceSnapshotId: string;
    sourceIdentityHash: string;
    targetOriginDigest: string;
    checkpointReference: string;
    expiresAt: string;
  }>,
  authenticationEvidenceReference?: string,
): string {
  return createHash("sha256").update([
    action,
    binding.organizationId,
    binding.projectId,
    binding.workflowRunId,
    binding.analysisRunId,
    binding.workflowTaskId,
    binding.sourceSnapshotId,
    binding.sourceIdentityHash,
    binding.targetOriginDigest,
    binding.checkpointReference,
    binding.expiresAt,
    authenticationEvidenceReference ?? "",
  ].join("\0"), "utf8").digest("hex");
}

function commandIdempotencyKey(
  action: "check" | "cancel",
  binding: Parameters<typeof commandHash>[1],
): string {
  return `website-authentication:${action}:${commandHash(action, binding)}`;
}
