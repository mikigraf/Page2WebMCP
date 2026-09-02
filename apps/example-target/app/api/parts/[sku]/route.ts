import { NextRequest } from "next/server";
import { errorResponse, jsonResponse, partsConsole, session } from "../../_runtime";

export async function GET(request: NextRequest, { params }: { params: Promise<{ sku: string }> }) {
  try {
    return jsonResponse(partsConsole().getPart(session(request), (await params).sku));
  } catch (error) {
    return errorResponse(error);
  }
}
