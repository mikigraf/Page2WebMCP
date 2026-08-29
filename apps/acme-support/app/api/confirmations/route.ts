import { NextRequest, NextResponse } from "next/server";
import { acme, errorResponse, readJsonBody, requireSameOrigin, session } from "../_fixture";

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const evidence = acme.issueConfirmation(session(request), await readJsonBody(request));
    return NextResponse.json({ evidence }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
