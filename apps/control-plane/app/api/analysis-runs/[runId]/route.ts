import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  requireActor,
  successResponse
} from "../../../../src/api.ts";

const RunIdSchema = z.string().uuid();

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireActor(request, repository);
    const { runId: rawRunId } = await context.params;
    const parsed = RunIdSchema.safeParse(rawRunId);
    if (!parsed.success) throw new ApiError("NOT_FOUND", 404);
    const run = await repository.getAnalysis(actor, parsed.data);
    const result = run.status === "succeeded"
      ? await repository.getAnalysisResult(actor, run.id)
      : undefined;
    const capabilities = result
      ? await repository.listAnalysisCapabilities(actor, run.id)
      : [];
    return successResponse({ run, projectId: run.projectId, result, capabilities }, requestId);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
