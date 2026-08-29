import { NextRequest, NextResponse } from "next/server";
import { acme, errorResponse, readJsonBody, requireSameOrigin, session } from "../_fixture";

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    return NextResponse.json(acme.createTicket(
      session(request),
      await readJsonBody(request),
      request.headers.get("idempotency-key"),
      request.headers.get("x-page2webmcp-confirmation"),
    ), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET(request: NextRequest) { try {
  const orderId = request.nextUrl.searchParams.get("orderId");
  if (!orderId) return NextResponse.json(
    { code: "VALIDATION_ERROR" },
    { status: 400, headers: { "cache-control": "no-store" } }
  );
  return NextResponse.json(acme.listTickets(session(request), orderId), { headers: { "cache-control": "no-store" } });
} catch (error) { return errorResponse(error); } }
