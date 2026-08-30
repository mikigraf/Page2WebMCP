import { createRequestId, issueCsrfChallenge, successResponse } from "../../../../src/api.ts";

export async function GET(request: Request) {
  const requestId = createRequestId();
  const challenge = issueCsrfChallenge(request);
  return successResponse({ csrfToken: challenge.token }, requestId, 200, { "set-cookie": challenge.cookie });
}
