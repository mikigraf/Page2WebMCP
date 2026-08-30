import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireMutationActor,
  successResponse,
} from "../../../../../../../src/api.ts";
import {
  configuredPublicOrigin,
  verifyInstalledRelease,
} from "../../../../../../../src/releases.ts";

const ParamsSchema = z.object({ projectId: z.string().uuid(), releaseId: z.string().uuid() }).strict();
const InputSchema = z.object({
  pageUrl: z.string().url().max(2_048),
  selfHostedUrl: z.string().url().max(2_048).optional(),
}).strict();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; releaseId: string }> },
) {
  const requestId = createRequestId();
  try {
    const repository = getControlPlaneRepository();
    const actor = await requireMutationActor(request, repository);
    const params = ParamsSchema.safeParse(await context.params);
    if (!params.success) throw new ApiError("NOT_FOUND", 404);
    const input = await parseJsonBody(request, InputSchema);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ApiError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const installation = await verifyInstalledRelease(
      repository,
      actor,
      params.data.projectId,
      params.data.releaseId,
      input.pageUrl,
      input.selfHostedUrl,
      idempotencyKey,
      configuredPublicOrigin(request),
      request.signal,
    );
    return successResponse({ installation }, requestId);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
