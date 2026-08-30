import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import {
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireMutationActor,
  successResponse
} from "../../../../src/api.ts";
import { verifyPersistedRelease } from "../../../../src/releases.ts";
import { recordLifecycle, recordLifecycleFailure } from "../../../../src/telemetry.ts";

const VerifyInputSchema = z.object({
  projectId: z.string().uuid(),
  analysisRunId: z.string().uuid()
}).strict();

export async function POST(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    const input = await parseJsonBody(request, VerifyInputSchema);
    const verification = await verifyPersistedRelease(
      repository,
      actor,
      input.projectId,
      input.analysisRunId
    );
    await recordLifecycle({
      event: "release_verified",
      operation: "verify",
      outcome: verification.eligible ? "success" : "failure",
      requestId,
      properties: { duration_ms: Date.now() - startedAt }
    });
    return successResponse({ verification }, requestId);
  } catch (error) {
    const response = errorResponse(error, requestId, request);
    await recordLifecycleFailure({ event: "release_verified", operation: "verify", requestId, startedAt }, error, response.status);
    return response;
  }
}
