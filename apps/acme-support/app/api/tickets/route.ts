import { NextRequest, NextResponse } from "next/server";
import { acme, errorResponse, session } from "../_fixture";

export async function POST(request: NextRequest) { try { return NextResponse.json(acme.createTicket(session(request), await request.json()), { status: 201 }); } catch (error) { return errorResponse(error); } }

export function GET(request: NextRequest) { try {
  const orderId = request.nextUrl.searchParams.get("orderId");
  if (!orderId) return NextResponse.json({ code: "VALIDATION_ERROR" }, { status: 400 });
  return NextResponse.json(acme.listTickets(session(request), orderId));
} catch (error) { return errorResponse(error); } }
