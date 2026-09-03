import { NextRequest, NextResponse } from "next/server";
import { PartsConsole } from "../../src/console";
import { parseOperatorCredentials, secretsMatch } from "../../src/credentials";
import { ConsoleError, consoleErrorStatus } from "../../src/errors";

export const SESSION_COOKIE = "parts_console_session";
export const SESSION_MAX_AGE_SECONDS = 1_800;
const MAX_BODY_BYTES = 16_384;

const CONSOLE_REGISTRY_KEY = "__page2webmcp_example_target_console__";
type ConsoleRegistry = Record<string, PartsConsole | undefined>;

/**
 * The single in-memory console for this server process. It is registered on
 * `globalThis` because route handlers and server components are bundled
 * separately: a module-level instance would not be shared between them.
 */
export function partsConsole(): PartsConsole {
  const registry = globalThis as unknown as ConsoleRegistry;
  const existing = registry[CONSOLE_REGISTRY_KEY];
  if (existing) return existing;
  const created = new PartsConsole({ operator: parseOperatorCredentials(process.env) });
  registry[CONSOLE_REGISTRY_KEY] = created;
  return created;
}

export function session(request: NextRequest): string {
  return request.cookies.get(SESSION_COOKIE)?.value ?? "";
}

/**
 * A reviewed mutation must echo the session's published request token, so a
 * request that only carries the cookie is refused.
 */
export function requireRequestToken(request: NextRequest): void {
  const expected = partsConsole().requestToken(session(request));
  const presented = request.headers.get("x-csrf-token") ?? "";
  if (!expected || presented.length !== expected.length || !secretsMatch(presented, expected)) {
    throw new ConsoleError("REQUEST_TOKEN_REQUIRED");
  }
}

export function requireSameOrigin(request: NextRequest): void {
  const host = request.headers.get("host");
  const expected = host ? `${request.nextUrl.protocol}//${host}` : "";
  if (!expected || request.headers.get("origin") !== expected) throw new ConsoleError("ORIGIN_MISMATCH");
}

export function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function errorResponse(error: unknown): NextResponse {
  const code = error instanceof ConsoleError ? error.code : "INTERNAL_ERROR";
  return NextResponse.json({ code }, { status: consoleErrorStatus(code), headers: { "cache-control": "no-store" } });
}

/** Streams and bounds a JSON request body, cancelling anything oversized. */
export async function readJsonBody(request: NextRequest): Promise<unknown> {
  const declaredHeader = request.headers.get("content-length");
  const declared = declaredHeader === null ? 0 : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await request.body?.cancel();
    throw new ConsoleError("PAYLOAD_TOO_LARGE");
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
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ConsoleError("PAYLOAD_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);
  try {
    if (!text) throw new Error("empty");
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConsoleError("INVALID_JSON");
  }
}
