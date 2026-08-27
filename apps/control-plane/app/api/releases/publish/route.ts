import { NextResponse } from "next/server";
import { evaluateRelease, VerificationReport } from "../../../../../../packages/evals/src/verify";
import { roleFromRequest } from "../../../../src/auth";

export async function POST(request: Request) {
  const input = await request.json() as { report: VerificationReport };
  if (roleFromRequest(request) !== "owner") return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
  const result = evaluateRelease(input.report);
  if (!result.eligible) return NextResponse.json({ code: "RELEASE_GATE_FAILED", failures: result.failures }, { status: 409 });
  return NextResponse.json({ status: "published", immutable: true }, { status: 201 });
}
