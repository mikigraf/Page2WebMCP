import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, errorResponse, partsConsole, requireSameOrigin, session } from "../../_runtime";

/**
 * Ends the operator session and clears its cookie. The form posts from the
 * console's own pages, so the redirect returns the visitor to the home page.
 */
export async function POST(request: NextRequest) {
  try {
    requireSameOrigin(request);
    partsConsole().logout(session(request));
    const response = NextResponse.redirect(new URL("/", request.nextUrl), {
      status: 303,
      headers: { "cache-control": "no-store" },
    });
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0, priority: "high",
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
