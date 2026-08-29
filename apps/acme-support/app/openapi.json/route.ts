import { NextResponse } from "next/server";
import { acme } from "../api/_fixture";

export function GET() {
  return NextResponse.json(acme.openApiDocument(), {
    headers: { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" }
  });
}
