import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  assertSameOrigin,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireActor,
  successResponse
} from "../../../../src/api.ts";
import { publishPersistedRelease } from "../../../../src/releases.ts";
import { recordLifecycle, recordLifecycleFailure } from "../../../../src/telemetry.ts";

const PublishInputSchema = z.object({
  projectId: z.string().uuid(),
  analysisRunId: z.string().uuid()
}).strict();
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9._:-]{8,128}$/;

/** Compatibility endpoint; new clients should use /api/projects/:id/releases. */
export async function POST(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    assertSameOrigin(request);
    const actor = requireActor(request);
    const input = await parseJsonBody(request, PublishInputSchema);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const release = await publishPersistedRelease(
      getControlPlaneRepository(),
      actor,
      input.projectId,
      input.analysisRunId,
      idempotencyKey
    );
    await recordLifecycle({
      event: "release_published",
      operation: "publish",
      outcome: "success",
      requestId,
      properties: { release_result: "published", duration_ms: Date.now() - startedAt }
    });
    return successResponse({ release }, requestId, 201);
  } catch (error) {
    const response = errorResponse(error, requestId);
    await recordLifecycleFailure({ event: "release_published", operation: "publish", requestId, startedAt }, error, response.status);
    return response;
  }
}
