import { NextResponse } from "next/server";
import { ProjectInputSchema, createProject, listProjects } from "../../../src/projects";

export function GET() {
  return NextResponse.json({ projects: listProjects() });
}

export async function POST(request: Request) {
  const input = ProjectInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ code: "INVALID_PROJECT_INPUT" }, { status: 400 });
  const result = createProject(input.data);
  if ("code" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
