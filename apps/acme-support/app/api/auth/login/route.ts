import { NextRequest, NextResponse } from "next/server";
import { acme, errorResponse } from "../../_fixture";

export async function POST(request: NextRequest) { try { const input = await request.json() as { email: string; password: string }; const value = acme.login(input.email, input.password); const response = NextResponse.json({ authenticated: true }); response.cookies.set("acme_session", value, { httpOnly: true, sameSite: "strict" }); return response; } catch (error) { return errorResponse(error); } }
