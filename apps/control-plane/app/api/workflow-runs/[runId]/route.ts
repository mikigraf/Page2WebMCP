import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  requireActor,
  successResponse,
} from "../../../../src/api.ts";
import {
  capabilityReviewPresentation,
  workflowPresentation,
} from "../../../../src/workflow-presentation.ts";
import { observeWorkflowStatus } from "../../../../../../packages/observability/src/workflow-runtime.ts";
import { websiteUserHandoffProjection } from "../../../../src/website-user-handoff-api.ts";
import { analysisOutcome } from "../../../../src/analysis-outcome.ts";
import { gitHubDraftPullRequestProjection } from "../../../../src/github-result.ts";

const RunIdSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireActor(request, repository);
    const parsedRunId = RunIdSchema.safeParse((await context.params).runId);
    if (!parsedRunId.success) throw new ApiError("NOT_FOUND", 404);
    const workflow = await repository.getWorkflowRun(actor, parsedRunId.data);
    const project = await repository.getProject(actor, workflow.projectId);
    const [tasks, events, evidence, capabilityPlans] = await Promise.all([
      repository.listWorkflowTasks(actor, workflow.id),
      repository.listWorkflowEvents(actor, workflow.id),
      repository.listWorkflowEvidence(actor, workflow.id),
      repository.listWorkflowCapabilityPlans(actor, workflow.id),
    ]);
    const analysisRunId = workflow.reviewedAnalysisRunId ?? workflow.analysisRunId;
    const analysis = analysisRunId
      ? await repository.getAnalysisResult(actor, analysisRunId)
      : undefined;
    const capabilities = analysisRunId
      ? await repository.listAnalysisCapabilities(actor, analysisRunId)
      : [];
    const presentation = workflowPresentation({
      sourceType: project.sourceType,
      run: workflow,
      tasks,
      diagnostics: analysis?.diagnostics ?? [],
    });
    const operational = await observeWorkflowStatus({
      run: workflow,
      tasks,
      events,
      evidence,
      capabilityPlans,
    });
    const draftPullRequest = project.sourceType === "github"
      ? await repository.getLatestGitHubDraftPullRequest(actor, workflow.id)
      : undefined;
    const outcome = project.sourceType === "github"
      ? workflow.status === "succeeded" && draftPullRequest
        ? "tested_patch_draft_pull_request_check_preview_reconciled"
        : workflow.status === "failed" || workflow.status === "cancelled"
          ? "github_workflow_terminal_without_installation"
          : "tested_patch_draft_pull_request_pending"
      : workflow.status === "succeeded"
        ? "analysis_workflow_succeeded"
        : workflow.status === "failed" || workflow.status === "cancelled"
          ? "analysis_workflow_terminal"
          : "analysis_workflow_pending";
    return successResponse({
      sourceType: project.sourceType,
      workflow,
      tasks,
      events,
      evidence,
      capabilityPlans,
      capabilities,
      capabilityReviews: capabilities.map(capabilityReviewPresentation),
      diagnostics: analysis?.diagnostics ?? [],
      analysisOutcome: analysisOutcome(analysis, capabilities.length),
      presentation,
      operational,
      outcome,
      ...(draftPullRequest ? { draftPullRequest: gitHubDraftPullRequestProjection(draftPullRequest) } : {}),
      ...(project.sourceType === "website" ? {
        websiteUserHandoff: websiteUserHandoffProjection(project.id),
      } : {}),
    }, requestId);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
