import { NextResponse } from "next/server";
import { openApiDocument } from "../../../src/openapi";

/**
 * The same description under any revision path. Analysis binds a project to the
 * document URL, so a reviewed change is adopted by pointing at a new revision.
 */
export function GET() {
  return NextResponse.json(openApiDocument(), {
    headers: { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
  });
}
