import { createHash } from "node:crypto";
import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireMutationActor,
  successResponse,
} from "../../../../../src/api.ts";

const InputSchema = z.object({ analysisRunId: z.string().uuid() }).strict();
const ProjectIdSchema = z.string().uuid();
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9._:-]{8,128}$/;

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    const input = await parseJsonBody(request, InputSchema);
    const parsedProjectId = ProjectIdSchema.safeParse((await context.params).projectId);
    if (!parsedProjectId.success) throw new ApiError("NOT_FOUND", 404);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const project = await repository.getProject(actor, parsedProjectId.data);
    if (project.sourceType !== "github") throw new ApiError("SOURCE_TYPE_UNSUPPORTED", 409);
    const inputHash = createHash("sha256").update(JSON.stringify({
      analysisRunId: input.analysisRunId,
      projectId: parsedProjectId.data,
    }), "utf8").digest("hex");
    const workflow = await repository.startWorkflow(actor, {
      projectId: parsedProjectId.data,
      analysisRunId: input.analysisRunId,
      idempotencyKey,
      inputHash,
    });
    return successResponse({
      workflow,
      outcome: "tested_patch_draft_pull_request_pending",
    }, requestId, 202);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
