import { z } from "zod";
import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { appendSetCookies, createRequestId, errorResponse, parseJsonBody, requireMutationActor, successResponse } from "../../../../src/api.ts";
import { getAuthService } from "../../../../src/auth.ts";

const InputSchema = z.object({ password: z.string().min(12).max(1_024) }).strict();

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    await requireMutationActor(request, getControlPlaneRepository());
    const input = await parseJsonBody(request, InputSchema);
    const updated = await getAuthService().updatePassword(request, input.password);
    const revoked = await getAuthService().signOut(request, "others");
    return successResponse({ passwordUpdated: true }, requestId, 200,
      appendSetCookies(new Headers(), [...updated.cookies, ...revoked.cookies]));
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
