import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { appendSetCookies, assertCsrf, createRequestId, errorResponse, parseJsonBody, successResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

const InputSchema = z.object({ email: z.string().email().max(320), password: z.string().min(12).max(1_024) }).strict();

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    assertCsrf(request);
    const input = await parseJsonBody(request, InputSchema);
    const origin = process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN ?? new URL(request.url).origin;
    const result = await getAuthService().signUp(
      request,
      input.email,
      input.password,
      new URL("/api/auth/callback", origin).toString()
    );
    const actor = result.user
      ? await getControlPlaneRepository().provisionPersonalOrganization(result.user)
      : undefined;
    return successResponse({
      emailVerificationRequired: result.emailVerificationRequired,
      ...(actor ? { role: actor.role, organizationId: actor.organizationId } : {})
    }, requestId, 202,
      appendSetCookies(new Headers(), result.cookies));
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
