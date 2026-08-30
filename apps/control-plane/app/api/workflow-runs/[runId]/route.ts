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

const RunIdSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireActor(request, repository);
    const parsedRunId = RunIdSchema.safeParse((await context.params).runId);
    if (!parsedRunId.success) throw new ApiError("NOT_FOUND", 404);
    const workflow = await repository.getWorkflowRun(actor, parsedRunId.data);
    const [tasks, events, evidence, capabilityPlans] = await Promise.all([
      repository.listWorkflowTasks(actor, workflow.id),
      repository.listWorkflowEvents(actor, workflow.id),
      repository.listWorkflowEvidence(actor, workflow.id),
      repository.listWorkflowCapabilityPlans(actor, workflow.id),
    ]);
    const analysis = workflow.reviewedAnalysisRunId
      ? await repository.getAnalysisResult(actor, workflow.reviewedAnalysisRunId)
      : undefined;
    const capabilities = workflow.reviewedAnalysisRunId
      ? await repository.listAnalysisCapabilities(actor, workflow.reviewedAnalysisRunId)
      : [];
    const presentation = workflowPresentation({
      sourceType: "github",
      run: workflow,
      tasks,
      diagnostics: analysis?.diagnostics ?? [],
    });
    const outcome = workflow.status === "succeeded"
      ? "tested_patch_draft_pull_request_check_preview_reconciled"
      : workflow.status === "failed" || workflow.status === "cancelled"
        ? "github_workflow_terminal_without_installation"
        : "tested_patch_draft_pull_request_pending";
    return successResponse({
      workflow,
      tasks,
      events,
      evidence,
      capabilityPlans,
      capabilities,
      capabilityReviews: capabilities.map(capabilityReviewPresentation),
      diagnostics: analysis?.diagnostics ?? [],
      presentation,
      outcome,
    }, requestId);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
