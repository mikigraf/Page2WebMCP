import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "../../../../src/auth";

const InputSchema = z.object({ email: z.string().email(), password: z.string().min(1) }).strict();

export async function POST(request: Request) {
  const input = InputSchema.safeParse(await request.json().catch(() => null));
  const role = input.success ? authenticate(input.data.email, input.data.password) : undefined;
  if (!role) return NextResponse.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  return new NextResponse(JSON.stringify({ role }), { status: 200, headers: { "content-type": "application/json", "set-cookie": `page2webmcp_role=${role}; Path=/; HttpOnly; SameSite=Lax` } });
}
