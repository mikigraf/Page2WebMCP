import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RepositoryActor } from "../../../packages/database/src/control-plane.ts";
import type { AuthIdentity, AuthService } from "./auth.ts";

type Credential = RepositoryActor & { email: string };
type SessionOptions = { secret?: string; now?: Date; ttlSeconds?: number };
type Payload = { sid: string; sub: string; iat: number; exp: number };

const SESSION_COOKIE = "page2webmcp_fixture_session";
const SESSION_VERSION = "v1";
const DEFAULT_TTL_SECONDS = 60 * 60;
const FIXTURE_SECRET = "page2webmcp-explicit-hermetic-auth-fixture-secret";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const credentials: Record<string, Credential> = {
  "owner@example.test": {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
    email: "owner@page2webmcp.local"
  },
  "editor@example.test": {
    id: "33333333-3333-3333-3333-333333333333",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "editor",
    email: "editor@page2webmcp.local"
  },
  "viewer@example.test": {
    id: "44444444-4444-4444-4444-444444444444",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "viewer",
    email: "viewer@page2webmcp.local"
  }
};

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = createHmac("sha256", "fixture-compare").update(left).digest();
  const rightBytes = createHmac("sha256", "fixture-compare").update(right).digest();
  return timingSafeEqual(leftBytes, rightBytes);
}

function accountById(id: string): Credential | undefined {
  return Object.values(credentials).find((account) => account.id === id);
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${SESSION_VERSION}.${payload}`).digest("base64url");
}

function parseToken(token: string, options: SessionOptions = {}): Payload | undefined {
  const [version, encoded, suppliedSignature, extra] = token.split(".");
  if (version !== SESSION_VERSION || !encoded || !suppliedSignature || extra) return undefined;
  if (!constantTimeEqual(signature(encoded, options.secret ?? FIXTURE_SECRET), suppliedSignature)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "exp,iat,sid,sub") return undefined;
    const payload = value as Partial<Payload>;
    const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
    if (typeof payload.sid !== "string" || !UUID.test(payload.sid)
      || typeof payload.sub !== "string" || !UUID.test(payload.sub)
      || typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat)
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)
      || payload.iat > now + 30 || payload.exp <= now) return undefined;
    return payload as Payload;
  } catch {
    return undefined;
  }
}

function tokenFromRequest(request: Request): string | undefined {
  const prefix = `${SESSION_COOKIE}=`;
  return request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
}

export function authenticate(email: string, password: string): RepositoryActor | undefined {
  const account = credentials[email.toLowerCase()];
  if (!account || !constantTimeEqual(password, "fixture-password")) return undefined;
  return { id: account.id, organizationId: account.organizationId, role: account.role };
}

export function issueSession(actor: RepositoryActor, options: SessionOptions = {}): string {
  if (!accountById(actor.id)) throw new Error("FIXTURE_IDENTITY_REQUIRED");
  const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const encoded = Buffer.from(JSON.stringify({
    sid: randomUUID(),
    sub: actor.id,
    iat: now,
    exp: now + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS)
  })).toString("base64url");
  return `${SESSION_VERSION}.${encoded}.${signature(encoded, options.secret ?? FIXTURE_SECRET)}`;
}

export function verifySessionToken(token: string, options: SessionOptions = {}): RepositoryActor | undefined {
  const payload = parseToken(token, options);
  const account = payload ? accountById(payload.sub) : undefined;
  return account ? { id: account.id, organizationId: account.organizationId, role: account.role } : undefined;
}

export function fixtureSessionId(token: string, options: SessionOptions = {}): string | undefined {
  return parseToken(token, options)?.sid;
}

export function sessionFromRequest(request: Request, options: SessionOptions = {}): RepositoryActor | undefined {
  const token = tokenFromRequest(request);
  return token ? verifySessionToken(token, options) : undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DEFAULT_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function fixtureCookie(actor: RepositoryActor): string {
  return `${SESSION_COOKIE}=${issueSession(actor)}`;
}

export function createFixtureAuthService(options: SessionOptions = {}): AuthService {
  const revokedSessions = new Set<string>();
  const identity = (request: Request): AuthIdentity | undefined => {
    const token = tokenFromRequest(request);
    const payload = token ? parseToken(token, options) : undefined;
    const account = payload ? accountById(payload.sub) : undefined;
    return payload && account && !revokedSessions.has(payload.sid) ? {
      id: account.id,
      email: account.email,
      sessionId: payload.sid,
      expiresAt: new Date(payload.exp * 1_000).toISOString()
    } : undefined;
  };
  return {
    async identity(request) { return identity(request); },
    async signUp() { return { emailVerificationRequired: true, cookies: [] }; },
    async signIn(request, email, password) {
      const actor = authenticate(email, password);
      if (!actor) return { cookies: [] };
      const token = issueSession(actor, options);
      const secure = new URL(request.url).protocol === "https:";
      return { cookies: [sessionCookie(token, secure)], user: { id: actor.id, email: accountById(actor.id)!.email } };
    },
    async exchangeCode(request, code) {
      if (code !== "fixture-owner-code") return { cookies: [] };
      const actor = credentials["owner@example.test"]!;
      const token = issueSession(actor, options);
      return {
        cookies: [sessionCookie(token, new URL(request.url).protocol === "https:")],
        user: { id: actor.id, email: actor.email }
      };
    },
    async refresh(request) {
      const current = identity(request);
      if (!current) return { cookies: [] };
      revokedSessions.add(current.sessionId);
      const actor = accountById(current.id)!;
      return {
        cookies: [sessionCookie(issueSession(actor, options), new URL(request.url).protocol === "https:")],
        user: { id: actor.id, email: actor.email }
      };
    },
    async refreshForProxy(request) {
      return identity(request) ? { cookies: [] } : { cookies: [clearFixtureCookie(request)] };
    },
    async requestPasswordRecovery() { return { cookies: [] }; },
    async updatePassword() { return { cookies: [] }; },
    async signOut(request) {
      const token = tokenFromRequest(request);
      const payload = token ? parseToken(token, options) : undefined;
      if (payload) revokedSessions.add(payload.sid);
      return { cookies: [clearFixtureCookie(request)] };
    },
    clearSessionCookies(request) { return [clearFixtureCookie(request)]; }
  };
}

function clearFixtureCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
