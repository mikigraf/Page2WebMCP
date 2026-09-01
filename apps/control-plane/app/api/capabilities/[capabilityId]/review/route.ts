import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireMutationActor,
  successResponse
} from "../../../../../src/api.ts";
import { recordLifecycle, recordLifecycleFailure } from "../../../../../src/telemetry.ts";

const ReviewInputSchema = z.object({
  action: z.enum(["approve", "block", "reject"]),
  expectedVersion: z.number().int().positive()
}).strict();
const CapabilityIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ capabilityId: string }> }
) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    const input = await parseJsonBody(request, ReviewInputSchema);
    const { capabilityId: rawCapabilityId } = await context.params;
    const capabilityId = CapabilityIdSchema.safeParse(rawCapabilityId);
    if (!capabilityId.success) throw new ApiError("NOT_FOUND", 404);
    const capability = await repository.reviewCapability(actor, capabilityId.data, input);
    await recordLifecycle({
      event: "capability_reviewed",
      outcome: "success",
      requestId,
      properties: { actor_id: actor.id, organization_id: actor.organizationId,
        review_action: input.action, risk_tier: capability.riskTier, duration_ms: Date.now() - startedAt }
    });
    return successResponse({ capability }, requestId);
  } catch (error) {
    const response = errorResponse(error, requestId, request);
    await recordLifecycleFailure({ event: "capability_reviewed", requestId, startedAt }, error, response.status);
    return response;
  }
}
