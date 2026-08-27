import { NextRequest, NextResponse } from "next/server";
import { AcmeError, AcmeSupport } from "../../src/app";

export const acme = new AcmeSupport();
export function session(request: NextRequest): string { return request.cookies.get("acme_session")?.value ?? ""; }
export function errorResponse(error: unknown) { const code = error instanceof AcmeError ? error.code : "INTERNAL_ERROR"; const status = code === "AUTH_REQUIRED" ? 401 : code === "HIGH_RISK_ACTION" ? 403 : code === "NOT_FOUND" ? 404 : 400; return NextResponse.json({ code }, { status }); }
