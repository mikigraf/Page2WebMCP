import { NextResponse } from "next/server";
import { openApiDocument } from "../../src/openapi";

export function GET() {
  return NextResponse.json(openApiDocument(), {
    headers: { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" },
  });
}
