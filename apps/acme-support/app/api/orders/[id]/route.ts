import { NextRequest, NextResponse } from "next/server";
import { acme, errorResponse, session } from "../../_fixture";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { try {
  return NextResponse.json(
    acme.getOrderStatus(session(request), (await params).id),
    { headers: { "cache-control": "no-store" } }
  );
} catch (error) { return errorResponse(error); } }
