import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { createRequestId, errorResponse, issueCsrfChallenge, requireIdentityActor, successResponse } from "../../../../src/api.ts";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const { actor, identity } = await requireIdentityActor(request, getControlPlaneRepository());
    const challenge = issueCsrfChallenge(request, { sessionId: identity.sessionId });
    return successResponse({
      actor: { id: actor.id, organizationId: actor.organizationId, role: actor.role },
      csrfToken: challenge.token,
      expiresAt: identity.expiresAt
    }, requestId, 200, { "set-cookie": challenge.cookie });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
