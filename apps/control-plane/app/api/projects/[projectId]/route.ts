import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { ApiError, createRequestId, errorResponse, requireActor, successResponse } from "../../../../src/api.ts";

const ProjectIdSchema = z.string().uuid();

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireActor(request, repository);
    const { projectId: rawProjectId } = await context.params;
    const parsed = ProjectIdSchema.safeParse(rawProjectId);
    if (!parsed.success) throw new ApiError("NOT_FOUND", 404);
    const project = await repository.getProject(actor, parsed.data);
    const source = (await repository.listProjectSources(actor, project.id)).find((candidate) => candidate.active);
    if (!source) throw new ApiError("NOT_FOUND", 404);
    const latestAnalysis = await repository.getLatestAnalysis(actor, project.id);
    const capabilities = latestAnalysis?.status === "succeeded"
      ? await repository.listAnalysisCapabilities(actor, latestAnalysis.id)
      : [];
    return successResponse({ project, source, latestAnalysis, capabilities }, requestId);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
