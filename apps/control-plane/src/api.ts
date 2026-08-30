import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  RepositoryError,
  type ControlPlaneRepository,
  type RepositoryActor
} from "../../../packages/database/src/control-plane.ts";
import { getControlPlaneRepository } from "../../../packages/database/src/factory.ts";
import { AuthError, getAuthService, type AuthIdentity } from "./auth.ts";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const CSRF_COOKIE = "page2webmcp_csrf_nonce";
const CSRF_VERSION = "v1";
const CSRF_TTL_SECONDS = 15 * 60;

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

export async function requireIdentityActor(
  request: Request,
  repository: ControlPlaneRepository = getControlPlaneRepository()
): Promise<{ actor: RepositoryActor; identity: AuthIdentity }> {
  const authService = getAuthService();
  const identity = await authService.identity(request);
  if (!identity) throw new ApiError("AUTH_REQUIRED", 401);
  const requestedOrganization = request.headers.get("x-page2webmcp-organization-id") ?? undefined;
  if (requestedOrganization
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedOrganization)) {
    throw new ApiError("MEMBERSHIP_REQUIRED", 403);
  }
  const actor = await repository.resolveActor(
    identity.id,
    requestedOrganization,
    identity.sessionId
  );
  return { actor, identity };
}

export async function requireActor(
  request: Request,
  repository: ControlPlaneRepository = getControlPlaneRepository()
): Promise<RepositoryActor> {
  return (await requireIdentityActor(request, repository)).actor;
}

export async function requireMutationActor(
  request: Request,
  repository: ControlPlaneRepository = getControlPlaneRepository()
): Promise<RepositoryActor> {
  const { actor, identity } = await requireIdentityActor(request, repository);
  assertCsrf(request, { sessionId: identity.sessionId });
  return actor;
}

type CsrfOptions = Readonly<{
  secret?: string;
  now?: Date;
  sessionId?: string;
  nonce?: string;
}>;

function csrfSecret(explicit?: string): string {
  const value = explicit ?? process.env.PAGE2WEBMCP_SESSION_SECRET;
  if (!value || value.length < 32) throw new ApiError("CSRF_CONFIGURATION_REQUIRED", 503);
  return value;
}

function csrfSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${CSRF_VERSION}.${payload}`).digest("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function requestCookie(request: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

export function issueCsrfChallenge(
  request: Request,
  options: CsrfOptions = {}
): { token: string; cookie: string } {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const nonce = options.nonce ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new ApiError("CSRF_TOKEN_INVALID", 403);
  const payload = Buffer.from(JSON.stringify({
    nonce: digest(nonce),
    session: digest(options.sessionId ?? "anonymous"),
    exp: now + CSRF_TTL_SECONDS
  })).toString("base64url");
  const token = `${CSRF_VERSION}.${payload}.${csrfSignature(payload, csrfSecret(options.secret))}`;
  const secure = process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
  const cookie = `${CSRF_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${CSRF_TTL_SECONDS}${secure ? "; Secure" : ""}`;
  return { token, cookie };
}

export function assertCsrf(request: Request, options: CsrfOptions = {}): void {
  assertSameOrigin(request);
  const token = request.headers.get("x-csrf-token");
  const nonce = requestCookie(request, CSRF_COOKIE);
  if (!token || !nonce) throw new ApiError("CSRF_TOKEN_REQUIRED", 403);
  const [version, encoded, suppliedSignature, extra] = token.split(".");
  if (version !== CSRF_VERSION || !encoded || !suppliedSignature || extra) {
    throw new ApiError("CSRF_TOKEN_INVALID", 403);
  }
  const expectedSignature = csrfSignature(encoded, csrfSecret(options.secret));
  if (!safeEqual(expectedSignature, suppliedSignature)) throw new ApiError("CSRF_TOKEN_INVALID", 403);
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "exp,nonce,session") {
      throw new ApiError("CSRF_TOKEN_INVALID", 403);
    }
    const payload = value as { nonce?: unknown; session?: unknown; exp?: unknown };
    if (typeof payload.nonce !== "string" || typeof payload.session !== "string"
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)
      || !safeEqual(payload.nonce, digest(nonce))
      || !safeEqual(payload.session, digest(options.sessionId ?? "anonymous"))) {
      throw new ApiError("CSRF_TOKEN_INVALID", 403);
    }
    const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
    if (payload.exp <= now) throw new ApiError("CSRF_TOKEN_EXPIRED", 403);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("CSRF_TOKEN_INVALID", 403);
  }
}

export function appendSetCookies(headers: Headers, cookies: readonly string[]): Headers {
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

export function clearCsrfCookie(request: Request): string {
  const secure = process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
  return `${CSRF_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
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
  const headers = error instanceof AuthError && error.cookies.length > 0
    ? appendSetCookies(new Headers(), error.cookies)
    : undefined;
  return successResponse(body, requestId, mapped.status, headers);
}

function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AuthError) {
    const statusByCode: Record<string, number> = {
      AUTH_REQUIRED: 401,
      EMAIL_VERIFICATION_REQUIRED: 403,
      SESSION_EXPIRED: 401,
      SESSION_REVOKED: 401,
      SUPABASE_CONFIGURATION_REQUIRED: 503,
      SIGNUP_FAILED: 400,
      AUTH_CALLBACK_FAILED: 400,
      PASSWORD_RECOVERY_FAILED: 400,
      PASSWORD_UPDATE_FAILED: 400,
      SIGNOUT_FAILED: 502,
      AUTH_PROVIDER_ERROR: 502
    };
    return new ApiError(error.code, statusByCode[error.code] ?? 500);
  }
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
      LEASE_LOST: 409,
      MEMBERSHIP_REQUIRED: 403,
      INVALID_CURSOR: 400,
      SESSION_REVOKED: 401
    };
    return new ApiError(error.code, statusByCode[error.code] ?? 500, false, error.details);
  }
  return new ApiError("INTERNAL_ERROR", 500);
}
