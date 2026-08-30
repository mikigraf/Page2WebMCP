import { appendSetCookies, assertCsrf, createRequestId, errorResponse, successResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    assertCsrf(request);
    const result = await getAuthService().refresh(request);
    return successResponse({ refreshed: true }, requestId, 200, appendSetCookies(new Headers(), result.cookies));
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
