import { NextRequest, NextResponse } from "next/server";
import { normalizeLoginInput } from "../../../../src/validation";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  errorResponse,
  partsConsole,
  readJsonBody,
  requireSameOrigin,
} from "../../_runtime";

export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    const input = normalizeLoginInput(await readJsonBody(request));
    const value = partsConsole().login(input.email, input.password);
    const response = NextResponse.json({ authenticated: true }, { headers: { "cache-control": "no-store" } });
    response.cookies.set(SESSION_COOKIE, value, {
      httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: SESSION_MAX_AGE_SECONDS, priority: "high",
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
