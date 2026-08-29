import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RepositoryError } from "../../../packages/database/src/control-plane.ts";
import { sessionFromRequest, type Actor } from "./auth.ts";

const MAX_JSON_BODY_BYTES = 64 * 1024;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
    readonly details?: string[]
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export function createRequestId(): string {
  return randomUUID();
}

export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes = MAX_JSON_BODY_BYTES
): Promise<z.output<T>> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await request.body?.cancel();
    throw new ApiError("REQUEST_TOO_LARGE", 413);
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
        if (total > maxBytes) {
          await reader.cancel();
          throw new ApiError("REQUEST_TOO_LARGE", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("INVALID_REQUEST", 400);
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError("INVALID_REQUEST", 400);
  return parsed.data;
}

export function requireActor(request: Request): Actor {
  const actor = sessionFromRequest(request);
  if (!actor) throw new ApiError("AUTH_REQUIRED", 401);
  return actor;
}

export function assertSameOrigin(request: Request): void {
  const expected = process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN
    ? new URL(process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN).origin
    : new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || origin !== expected || fetchSite === "cross-site") {
    throw new ApiError("CROSS_SITE_REQUEST_BLOCKED", 403);
  }
}

export function successResponse(data: unknown, requestId: string, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-request-id", requestId);
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function errorResponse(error: unknown, requestId: string): Response {
  const mapped = mapError(error);
  const body: {
    code: string;
    error: { code: string; retryable: boolean; details?: string[] };
    requestId: string;
  } = {
    code: mapped.code,
    error: { code: mapped.code, retryable: mapped.retryable },
    requestId
  };
  if (mapped.details?.length) body.error.details = mapped.details;
  return successResponse(body, requestId, mapped.status);
}

function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof RepositoryError) {
    const statusByCode: Record<string, number> = {
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      IDEMPOTENCY_CONFLICT: 409,
      VERSION_CONFLICT: 409,
      OWNER_APPROVAL_REQUIRED: 403,
      HIGH_RISK_ACTION: 409,
      RELEASE_GATE_FAILED: 409,
      INVALID_STATE: 409,
      LEASE_LOST: 409
    };
    return new ApiError(error.code, statusByCode[error.code] ?? 500, false, error.details);
  }
  return new ApiError("INTERNAL_ERROR", 500);
}
