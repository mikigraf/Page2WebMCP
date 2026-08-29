import { NextRequest, NextResponse } from "next/server";
import { AcmeError, AcmeSupport, acmeErrorStatus } from "../../src/app";

export const acme = new AcmeSupport();
export function session(request: NextRequest): string { return request.cookies.get("acme_session")?.value ?? ""; }
export function requireSameOrigin(request: NextRequest): void {
  const host = request.headers.get("host");
  const expected = host ? `${request.nextUrl.protocol}//${host}` : "";
  if (!expected || request.headers.get("origin") !== expected) throw new AcmeError("ORIGIN_MISMATCH");
}
export function errorResponse(error: unknown) {
  const code = error instanceof AcmeError ? error.code : "INTERNAL_ERROR";
  return NextResponse.json({ code }, { status: acmeErrorStatus(code), headers: { "cache-control": "no-store" } });
}

export async function readJsonBody(request: NextRequest): Promise<unknown> {
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? 0 : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > 16_384) {
    await request.body?.cancel();
    throw new AcmeError("PAYLOAD_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 16_384) {
          await reader.cancel();
          throw new AcmeError("PAYLOAD_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(body);
  try {
    if (!text) throw new Error("empty");
    return JSON.parse(text) as unknown;
  } catch {
    throw new AcmeError("INVALID_JSON");
  }
}
