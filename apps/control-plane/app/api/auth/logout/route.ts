import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { appendSetCookies, clearCsrfCookie, createRequestId, errorResponse, requireMutationActor, successResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    await requireMutationActor(request, getControlPlaneRepository());
    const authService = getAuthService();
    const result = await authService.signOut(request, "local");
    const headers = appendSetCookies(new Headers(), [
      ...result.cookies,
      ...authService.clearSessionCookies(request),
      clearCsrfCookie(request)
    ]);
    return successResponse({ signedOut: true }, requestId, 200, headers);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
