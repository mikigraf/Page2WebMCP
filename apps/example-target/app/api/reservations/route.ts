import { NextRequest } from "next/server";
import { errorResponse, jsonResponse, partsConsole, readJsonBody, requireRequestToken, requireSameOrigin, session } from "../_runtime";

/** The operator's reservations, so a mutation's own effect can be read back. */
export function GET(request: NextRequest) {
  try {
    return jsonResponse(partsConsole().listReservations(session(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    requireRequestToken(request);
    return jsonResponse(partsConsole().reserve(
      session(request),
      await readJsonBody(request),
      request.headers.get("idempotency-key"),
      request.headers.get("x-page2webmcp-confirmation"),
    ), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
