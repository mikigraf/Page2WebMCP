import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type Role = "owner" | "editor" | "viewer";
export type Actor = { id: string; organizationId: string; role: Role };

type Credential = Actor & { passwordVariable: "PAGE2WEBMCP_OWNER_PASSWORD" | "PAGE2WEBMCP_EDITOR_PASSWORD" };
type SessionOptions = { secret?: string; now?: Date; ttlSeconds?: number };

const SESSION_COOKIE = "page2webmcp_session";
const SESSION_VERSION = "v1";
const DEFAULT_TTL_SECONDS = 60 * 60;
const LOCAL_SESSION_SECRET = "page2webmcp-local-fixture-session-secret-2026";

const credentials: Record<string, Credential> = {
  "owner@example.test": {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    passwordVariable: "PAGE2WEBMCP_OWNER_PASSWORD",
    role: "owner"
  },
  "editor@example.test": {
    id: "33333333-3333-3333-3333-333333333333",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    passwordVariable: "PAGE2WEBMCP_EDITOR_PASSWORD",
    role: "editor"
  }
};

const UuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const SessionPayloadSchema = z.object({
  sid: UuidSchema,
  sub: UuidSchema,
  org: UuidSchema,
  role: z.enum(["owner", "editor", "viewer"]),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive()
}).strict();

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = createHmac("sha256", "page2webmcp-constant-time-compare").update(left).digest();
  const rightBytes = createHmac("sha256", "page2webmcp-constant-time-compare").update(right).digest();
  return timingSafeEqual(leftBytes, rightBytes);
}

function signingSecret(explicit?: string): string {
  const value = explicit ?? process.env.PAGE2WEBMCP_SESSION_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET_REQUIRED");
  return LOCAL_SESSION_SECRET;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${SESSION_VERSION}.${payload}`).digest("base64url");
}

export function authenticate(
  email: string,
  password: string,
  environment: Record<string, string | undefined> = process.env
): Actor | undefined {
  const account = credentials[email.toLowerCase()];
  const configuredPassword = account
    ? environment[account.passwordVariable] ?? (environment.NODE_ENV === "production" ? undefined : "fixture-password")
    : undefined;
  const passwordMatches = constantTimeEqual(configuredPassword ?? "fixture-invalid-password", password);
  if (!account || !configuredPassword || !passwordMatches) return undefined;
  return { id: account.id, organizationId: account.organizationId, role: account.role };
}

export function issueSession(actor: Actor, options: SessionOptions = {}): string {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sid: randomUUID(),
    sub: actor.id,
    org: actor.organizationId,
    role: actor.role,
    iat: now,
    exp: now + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS)
  })).toString("base64url");
  return `${SESSION_VERSION}.${payload}.${signature(payload, signingSecret(options.secret))}`;
}

export function verifySessionToken(token: string, options: SessionOptions = {}): Actor | undefined {
  const [version, encoded, suppliedSignature, extra] = token.split(".");
  if (version !== SESSION_VERSION || !encoded || !suppliedSignature || extra) return undefined;
  const expected = signature(encoded, signingSecret(options.secret));
  if (!constantTimeEqual(expected, suppliedSignature)) return undefined;
  try {
    const payload = SessionPayloadSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (payload.iat > now + 30 || payload.exp <= now) return undefined;
    return { id: payload.sub, organizationId: payload.org, role: payload.role };
  } catch {
    return undefined;
  }
}

export function sessionFromRequest(request: Request, options: SessionOptions = {}): Actor | undefined {
  const cookie = request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = cookie?.slice(SESSION_COOKIE.length + 1);
  return token ? verifySessionToken(token, options) : undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DEFAULT_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function expiredSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
