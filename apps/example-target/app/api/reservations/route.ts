import { NextRequest } from "next/server";
import { errorResponse, jsonResponse, partsConsole, readJsonBody, requireSameOrigin, session } from "../_runtime";

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
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
