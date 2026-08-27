import { NextResponse } from "next/server";
import { evaluateRelease, VerificationReport } from "../../../../../../packages/evals/src/verify";

export async function POST(request: Request) { const report = await request.json() as VerificationReport; return NextResponse.json(evaluateRelease(report)); }
