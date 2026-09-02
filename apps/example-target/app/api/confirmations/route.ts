import { NextRequest } from "next/server";
import { errorResponse, jsonResponse, partsConsole, readJsonBody, requireSameOrigin, session } from "../_runtime";

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const evidence = partsConsole().issueConfirmation(session(request), await readJsonBody(request));
    return jsonResponse({ evidence }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
