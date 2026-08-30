import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { ApiError, appendSetCookies, createRequestId, errorResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const url = new URL(request.url);
    if (["access_token", "refresh_token", "token", "token_hash"].some((key) => url.searchParams.has(key))) {
      throw new ApiError("BEARER_QUERY_TOKEN_FORBIDDEN", 400);
    }
    const code = url.searchParams.get("code");
    if (!code || !/^[A-Za-z0-9._~-]{8,2048}$/.test(code)) throw new ApiError("AUTH_CALLBACK_FAILED", 400);
    const result = await getAuthService().exchangeCode(request, code);
    if (!result.user) throw new ApiError("AUTH_CALLBACK_FAILED", 400);
    await getControlPlaneRepository().provisionPersonalOrganization(result.user);
    const publicOrigin = process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN ?? url.origin;
    const flow = url.searchParams.get("flow") === "recovery" ? "recovery" : "verified";
    const headers = appendSetCookies(new Headers({
      location: new URL(`/?auth=${flow}`, publicOrigin).toString(),
      "cache-control": "no-store",
      "x-request-id": requestId
    }), result.cookies);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
