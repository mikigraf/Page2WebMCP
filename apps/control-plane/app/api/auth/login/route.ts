import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import {
  ApiError,
  appendSetCookies,
  assertCsrf,
  createRequestId,
  errorResponse,
  parseJsonBody,
  successResponse
} from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

const InputSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1_024) }).strict();

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    assertCsrf(request);
    const input = await parseJsonBody(request, InputSchema);
    const result = await getAuthService().signIn(request, input.email, input.password);
    if (!result.user) throw new ApiError("AUTH_REQUIRED", 401);
    const actor = await getControlPlaneRepository().provisionPersonalOrganization(result.user);
    const headers = appendSetCookies(new Headers(), result.cookies);
    return successResponse(
      { actorId: actor.id, role: actor.role, organizationId: actor.organizationId },
      requestId,
      200,
      headers
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
