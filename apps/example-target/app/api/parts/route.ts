import { NextRequest } from "next/server";
import { errorResponse, jsonResponse, partsConsole, session } from "../_runtime";

export function GET(request: NextRequest) {
  try {
    return jsonResponse(partsConsole().listParts(session(request), request.nextUrl.searchParams.get("q")));
  } catch (error) {
    return errorResponse(error);
  }
}
