import { NextRequest, NextResponse } from "next/server";
import { normalizeLoginInput } from "../../../../src/app";
import { acme, errorResponse, readJsonBody, requireSameOrigin } from "../../_fixture";

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const input = normalizeLoginInput(await readJsonBody(request));
    const value = acme.login(input.email, input.password);
    const response = NextResponse.json({ authenticated: true }, { headers: { "cache-control": "no-store" } });
    response.cookies.set("acme_session", value, {
      httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 1_800, priority: "high",
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
