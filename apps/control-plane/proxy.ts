import { NextResponse } from "next/server";
import { getAuthService } from "./src/auth.ts";

/** Refresh only. Every protected route still performs fresh identity and DB authorization. */
export async function proxy(request: Request) {
  const response = NextResponse.next();
  try {
    const result = await getAuthService().refreshForProxy(request);
    for (const cookie of result.cookies) response.headers.append("set-cookie", cookie);
  } catch {
    // Routes return the precise expired/revoked diagnostic. Proxy is never an
    // authorization boundary and must not turn a public page into an auth error.
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/releases/).*)"]
};
