import { NextResponse } from "next/server";
import { acme } from "../api/_fixture";

export function GET() { return NextResponse.json(acme.openApiDocument()); }
