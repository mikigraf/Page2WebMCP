import { NextRequest, NextResponse } from "next/server";
import { acme, errorResponse, session } from "../_fixture";

export function GET(request: NextRequest) { try {
  return NextResponse.json(
    acme.searchOrders(session(request), request.nextUrl.searchParams.get("q") ?? ""),
    { headers: { "cache-control": "no-store" } }
  );
} catch (error) { return errorResponse(error); } }
