import { NextRequest } from "next/server";
import { errorResponse, jsonResponse, partsConsole, requireSameOrigin, session } from "../../_runtime";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return jsonResponse(partsConsole().getReservation(session(request), (await params).id));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    return jsonResponse(partsConsole().release(session(request), (await params).id));
  } catch (error) {
    return errorResponse(error);
  }
}
