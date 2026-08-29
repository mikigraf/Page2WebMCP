import { z } from "zod";
import {
  ApiError,
  assertSameOrigin,
  createRequestId,
  errorResponse,
  parseJsonBody,
  successResponse
} from "../../../../src/api.ts";
import { authenticate, issueSession, sessionCookie } from "../../../../src/auth.ts";

const InputSchema = z.object({ email: z.string().email(), password: z.string().min(1) }).strict();

export async function POST(request: Request) {
  const requestId = createRequestId();
  try {
    assertSameOrigin(request);
    const input = await parseJsonBody(request, InputSchema);
    const actor = authenticate(input.email, input.password);
    if (!actor) throw new ApiError("AUTH_REQUIRED", 401);
    const token = issueSession(actor);
    const secure = new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production";
    return successResponse(
      { actorId: actor.id, role: actor.role },
      requestId,
      200,
      { "set-cookie": sessionCookie(token, secure) }
    );
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
