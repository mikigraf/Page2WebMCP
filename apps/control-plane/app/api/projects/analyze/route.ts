import { NextResponse } from "next/server";
import { z } from "zod";
import { AcmeSupport } from "../../../../../acme-support/src/app";
import { runFixtureSourceHardening, runFixtureWorkflow } from "../../../../../worker/src/workflow";

const InputSchema = z.object({ sourceType: z.enum(["website", "openapi", "github"]) }).strict();

export async function POST(request: Request) {
  const input = InputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ code: "INVALID_SOURCE_TYPE" }, { status: 400 });
  if (input.data.sourceType === "github") {
    return NextResponse.json({ sourceType: "github", draftPullRequest: runFixtureSourceHardening() });
  }
  const result = runFixtureWorkflow(new AcmeSupport(), "https://acme.example");
  return NextResponse.json({ sourceType: input.data.sourceType, capabilities: result.capabilities, evidence: result.evidence, contentHash: result.release.contentHash });
}
