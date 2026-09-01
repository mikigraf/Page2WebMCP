import { getControlPlaneRepository } from "../../../../../../packages/database/src/factory.ts";
import { RepositoryError, type RepositoryActor } from "../../../../../../packages/database/src/control-plane.ts";
import { createRequestId, errorResponse, issueCsrfChallenge, requireAuthenticatedIdentity, successResponse } from "../../../../src/api.ts";

export async function GET(request: Request) {
  const requestId = createRequestId();
  try {
    const identity = await requireAuthenticatedIdentity(request);
    let actor: RepositoryActor | undefined;
    try {
      actor = await getControlPlaneRepository().resolveActor(identity.id, undefined, identity.sessionId);
    } catch (error) {
      if (!(error instanceof RepositoryError) || error.code !== "MEMBERSHIP_REQUIRED") throw error;
    }
    const challenge = issueCsrfChallenge(request, { sessionId: identity.sessionId });
    return successResponse({
      ...(actor
        ? { actor: { id: actor.id, organizationId: actor.organizationId, role: actor.role } }
        : { membershipRequired: true }),
      csrfToken: challenge.token,
      expiresAt: identity.expiresAt
    }, requestId, 200, { "set-cookie": challenge.cookie });
  } catch (error) {
    return errorResponse(error, requestId, request);
  }
}
