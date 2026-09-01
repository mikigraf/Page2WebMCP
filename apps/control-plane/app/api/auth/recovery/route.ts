import { z } from "zod";
import { appendSetCookies, assertCsrf, clearCsrfCookie, createRequestId, errorResponse, parseJsonBody, successResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

const InputSchema = z.object({ email: z.string().email().max(320) }).strict();

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    assertCsrf(request);
    const input = await parseJsonBody(request, InputSchema);
    const publicOrigin = process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN ?? new URL(request.url).origin;
    const redirectTo = new URL("/api/auth/callback?flow=recovery", publicOrigin).toString();
    const authService = getAuthService();
    const result = await authService.requestPasswordRecovery(request, input.email, redirectTo);
    return successResponse({ recoveryRequested: true }, requestId, 202,
      appendSetCookies(new Headers(), [
        ...result.cookies,
        ...authService.clearSessionCookies(request),
        clearCsrfCookie(request)
      ]));
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
