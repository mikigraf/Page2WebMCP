import { appendSetCookies, clearCsrfCookie, createRequestId, errorResponse, requireAuthenticatedMutation, successResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    await requireAuthenticatedMutation(request);
    const authService = getAuthService();
    const result = await authService.signOut(request, "global");
    return successResponse({ revoked: true }, requestId, 200,
      appendSetCookies(new Headers(), [
        ...result.cookies,
        ...authService.clearSessionCookies(request),
        clearCsrfCookie(request)
      ]));
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
