import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { ApiError, createRequestId, errorResponse, requireActor, successResponse } from "../../../../src/api.ts";
import { recoverLatestPublishedRelease } from "../../../../src/releases.ts";
import { websiteUserHandoffProjection } from "../../../../src/website-user-handoff-api.ts";
import { analysisOutcome } from "../../../../src/analysis-outcome.ts";
import { gitHubDraftPullRequestProjection } from "../../../../src/github-result.ts";

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
    const source = await repository.getActiveProjectSource(actor, project.id);
    const latestAnalysis = await repository.getLatestAnalysis(actor, project.id);
    const capabilities = latestAnalysis?.status === "succeeded"
      ? await repository.listAnalysisCapabilities(actor, latestAnalysis.id)
      : [];
    const latestAnalysisResult = latestAnalysis?.status === "succeeded"
      ? await repository.getAnalysisResult(actor, latestAnalysis.id)
      : undefined;
    const release = await recoverLatestPublishedRelease(repository, actor, project.id);
    const githubWorkflow = project.sourceType === "github" && latestAnalysis
      ? await repository.getLatestReviewedWorkflowForAnalysis(actor, project.id, latestAnalysis.id)
      : undefined;
    const draftPullRequest = githubWorkflow
      ? await repository.getLatestGitHubDraftPullRequest(actor, githubWorkflow.id)
      : undefined;
    return successResponse({
      project,
      source,
      latestAnalysis,
      capabilities,
      analysisOutcome: analysisOutcome(latestAnalysisResult, capabilities.length),
      release,
      ...(githubWorkflow ? { githubWorkflow: {
        id: githubWorkflow.id,
        status: githubWorkflow.status,
        currentPhase: githubWorkflow.currentPhase,
        ...(githubWorkflow.errorCode ? { errorCode: githubWorkflow.errorCode } : {}),
      } } : {}),
      ...(draftPullRequest ? { draftPullRequest: gitHubDraftPullRequestProjection(draftPullRequest) } : {}),
      ...(project.sourceType === "website" ? {
        websiteUserHandoff: websiteUserHandoffProjection(project.id),
      } : {}),
    }, requestId);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
