import { NextResponse } from "next/server";
import { z } from "zod";
import { roleFromRequest } from "../../../../src/auth";

const InputSchema = z.object({
  name: z.string().min(1),
  riskTier: z.enum(["R0", "R1", "R2", "R3"]),
  action: z.enum(["approve", "block", "reject"])
}).strict();

export async function POST(request: Request) {
  const input = InputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ code: "INVALID_REVIEW_INPUT" }, { status: 400 });
  const role = roleFromRequest(request);
  if (!role) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  const { name, riskTier, action } = input.data;
  if (riskTier === "R3") return NextResponse.json({ name, status: "blocked", code: "HIGH_RISK_ACTION" }, { status: 409 });
  if (action !== "approve") return NextResponse.json({ name, status: "blocked" });
  if (riskTier !== "R0" && role !== "owner") return NextResponse.json({ code: "OWNER_APPROVAL_REQUIRED" }, { status: 403 });
  if (role === "viewer") return NextResponse.json({ code: "FORBIDDEN" }, { status: 403 });
  return NextResponse.json({ name, status: "reviewed" });
}
