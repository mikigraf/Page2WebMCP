import { appendSetCookies, clearCsrfCookie, createRequestId, errorResponse, requireAuthenticatedMutation, successResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    await requireAuthenticatedMutation(request);
    const authService = getAuthService();
    const result = await authService.signOut(request, "local");
    const headers = appendSetCookies(new Headers(), [
      ...result.cookies,
      ...authService.clearSessionCookies(request),
      clearCsrfCookie(request)
    ]);
    return successResponse({ signedOut: true }, requestId, 200, headers);
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
