import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import {
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireMutationActor,
  successResponse
} from "../../../../src/api.ts";
import { recordLifecycle, recordLifecycleFailure } from "../../../../src/telemetry.ts";

const ReviewInputSchema = z.object({
  capabilityId: z.string().uuid(),
  action: z.enum(["approve", "block", "reject"]),
  expectedVersion: z.number().int().positive()
}).strict();

/** Compatibility endpoint; new clients should use /api/capabilities/:id/review. */
export async function POST(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    const { capabilityId, ...input } = await parseJsonBody(request, ReviewInputSchema);
    const capability = await repository.reviewCapability(actor, capabilityId, input);
    await recordLifecycle({
      event: "capability_reviewed",
      outcome: "success",
      requestId,
      properties: { review_action: input.action, risk_tier: capability.riskTier, duration_ms: Date.now() - startedAt }
    });
    return successResponse({ capability }, requestId);
  } catch (error) {
    const response = errorResponse(error, requestId, request);
    await recordLifecycleFailure({ event: "capability_reviewed", requestId, startedAt }, error, response.status);
    return response;
  }
}
