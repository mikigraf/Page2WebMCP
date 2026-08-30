import { createBrowserClient, createServerClient } from "@supabase/ssr";
import { unsafeSupabaseBrowserKey } from "./supabase-config.ts";

export type AuthIdentity = Readonly<{
  id: string;
  email?: string;
  sessionId: string;
  expiresAt: string;
}>;

type AuthUserLike = Readonly<{
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  user_metadata?: unknown;
}>;

type AuthProviderError = Readonly<{ message?: string; code?: string; status?: number }>;
type AuthDataResult<T> = Promise<{ data: T; error: AuthProviderError | null }>;

export type SupabaseAuthClientLike = Readonly<{
  auth: {
    getUser(): AuthDataResult<{ user: AuthUserLike | null }>;
    getClaims(): AuthDataResult<{ claims: Record<string, unknown> | null }>;
    signUp(input: {
      email: string;
      password: string;
      options: { emailRedirectTo: string };
    }): AuthDataResult<{ user: AuthUserLike | null; session: unknown | null }>;
    signInWithPassword(input: { email: string; password: string }): AuthDataResult<{
      user: AuthUserLike | null;
      session: unknown | null;
    }>;
    exchangeCodeForSession(code: string): AuthDataResult<{ user: AuthUserLike | null; session: unknown | null }>;
    refreshSession(): AuthDataResult<{ user: AuthUserLike | null; session: unknown | null }>;
    resetPasswordForEmail(email: string, options: { redirectTo: string }): AuthDataResult<Record<string, never>>;
    updateUser(attributes: { password: string }): AuthDataResult<{ user: AuthUserLike | null }>;
    signOut(options: { scope: "local" | "global" | "others" }): Promise<{ error: AuthProviderError | null }>;
  };
}>;

export type SupabaseCookieOptions = Readonly<{
  domain?: string;
  expires?: Date;
  maxAge?: number;
  path?: string;
  sameSite?: boolean | "lax" | "strict" | "none";
  secure?: boolean;
}>;

type SupabaseCookieWrite = Readonly<{
  name: string;
  value: string;
  options: SupabaseCookieOptions;
}>;

export type SupabaseAuthClientFactory = (
  request: Request,
  setCookies: (cookies: readonly SupabaseCookieWrite[]) => void
) => SupabaseAuthClientLike;

export type AuthenticatedAuthUser = Readonly<{ id: string; email?: string }>;
export type AuthOperationResult = Readonly<{ cookies: string[]; user?: AuthenticatedAuthUser }>;
export type SignUpResult = AuthOperationResult & Readonly<{ emailVerificationRequired: boolean }>;

export interface AuthService {
  identity(request: Request): Promise<AuthIdentity | undefined>;
  signUp(request: Request, email: string, password: string, redirectTo: string): Promise<SignUpResult>;
  signIn(request: Request, email: string, password: string): Promise<AuthOperationResult>;
  exchangeCode(request: Request, code: string): Promise<AuthOperationResult>;
  refresh(request: Request): Promise<AuthOperationResult>;
  refreshForProxy(request: Request): Promise<AuthOperationResult>;
  requestPasswordRecovery(request: Request, email: string, redirectTo: string): Promise<AuthOperationResult>;
  updatePassword(request: Request, password: string): Promise<AuthOperationResult>;
  signOut(request: Request, scope: "local" | "global" | "others"): Promise<AuthOperationResult>;
  clearSessionCookies(request: Request): string[];
}

type AuthServiceOptions = Readonly<{
  createClient: SupabaseAuthClientFactory;
  now?: () => Date;
}>;

export class AuthError extends Error {
  constructor(readonly code: string, readonly cookies: readonly string[] = []) {
    super(code);
    this.name = "AuthError";
  }
}

function expiredCookies(request: Request, cookieWrites: readonly string[] = []): string[] {
  const secure = process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
  const names = new Set(parseCookies(request).map(({ name }) => name).filter((name) => name.startsWith("sb-")));
  for (const cookie of cookieWrites) {
    const name = cookie.slice(0, cookie.indexOf("="));
    if (name.startsWith("sb-") && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) names.add(name);
  }
  return [...names].sort().map((name) => serializeSupabaseCookie(name, "", { maxAge: 0 }, secure));
}

function sessionFailure(request: Request, code: "SESSION_EXPIRED" | "SESSION_REVOKED", cookies: string[]): never {
  throw new AuthError(code, expiredCookies(request, cookies));
}

function providerError(error: AuthProviderError | null, fallback = "AUTH_PROVIDER_ERROR"): void {
  if (!error) return;
  const marker = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  if (marker.includes("email") && (marker.includes("confirm") || marker.includes("verif"))) {
    throw new AuthError("EMAIL_VERIFICATION_REQUIRED");
  }
  if (marker.includes("expired")) throw new AuthError("SESSION_EXPIRED");
  if (marker.includes("invalid login") || marker.includes("invalid credential")) throw new AuthError("AUTH_REQUIRED");
  throw new AuthError(fallback);
}

function cookieCollector(request: Request): {
  writes: string[];
  setCookies: (cookies: readonly SupabaseCookieWrite[]) => void;
} {
  const writes: string[] = [];
  const secure = process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
  return {
    writes,
    setCookies(cookies) {
      for (const cookie of cookies) {
        writes.push(serializeSupabaseCookie(cookie.name, cookie.value, cookie.options, secure));
      }
    }
  };
}

export function createSupabaseAuthService(options: AuthServiceOptions): AuthService {
  const now = options.now ?? (() => new Date());
  const context = (request: Request) => {
    const collector = cookieCollector(request);
    return { client: options.createClient(request, collector.setCookies), cookies: collector.writes };
  };
  return {
    async identity(request) {
      const { client, cookies } = context(request);
      const userResult = await client.auth.getUser();
      if (userResult.error) {
        const marker = `${userResult.error.code ?? ""} ${userResult.error.message ?? ""}`.toLowerCase();
        sessionFailure(request, marker.includes("expir") ? "SESSION_EXPIRED" : "SESSION_REVOKED", cookies);
      }
      if (!userResult.data.user) return undefined;
      const user = userResult.data.user;
      if (!user.email_confirmed_at && !user.confirmed_at) {
        throw new AuthError("EMAIL_VERIFICATION_REQUIRED", expiredCookies(request, cookies));
      }
      const claimsResult = await client.auth.getClaims();
      if (claimsResult.error || !claimsResult.data.claims) sessionFailure(request, "SESSION_REVOKED", cookies);
      const claims = claimsResult.data.claims;
      const subject = typeof claims.sub === "string" ? claims.sub : undefined;
      const sessionId = typeof claims.session_id === "string" ? claims.session_id : undefined;
      const expires = typeof claims.exp === "number" && Number.isSafeInteger(claims.exp) ? claims.exp : undefined;
      if (!subject || subject !== user.id || !sessionId
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
        || !expires) sessionFailure(request, "SESSION_REVOKED", cookies);
      if (expires <= Math.floor(now().getTime() / 1_000)) sessionFailure(request, "SESSION_EXPIRED", cookies);
      return {
        id: user.id,
        ...(user.email ? { email: user.email } : {}),
        sessionId,
        expiresAt: new Date(expires * 1_000).toISOString()
      };
    },
    async signUp(request, email, password, redirectTo) {
      const { client, cookies } = context(request);
      const result = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
      providerError(result.error, "SIGNUP_FAILED");
      const emailVerificationRequired = result.data.session === null;
      if (emailVerificationRequired) return { emailVerificationRequired, cookies };
      if (!result.data.user || (!result.data.user.email_confirmed_at && !result.data.user.confirmed_at)) {
        throw new AuthError("SIGNUP_FAILED", expiredCookies(request, cookies));
      }
      return {
        emailVerificationRequired,
        cookies,
        user: {
          id: result.data.user.id,
          ...(result.data.user.email ? { email: result.data.user.email } : {})
        }
      };
    },
    async signIn(request, email, password) {
      const { client, cookies } = context(request);
      const result = await client.auth.signInWithPassword({ email, password });
      providerError(result.error, "AUTH_REQUIRED");
      if (!result.data.user || !result.data.session) throw new AuthError("AUTH_REQUIRED");
      if (!result.data.user.email_confirmed_at && !result.data.user.confirmed_at) {
        throw new AuthError("EMAIL_VERIFICATION_REQUIRED", expiredCookies(request, cookies));
      }
      return { cookies, user: { id: result.data.user.id, ...(result.data.user.email ? { email: result.data.user.email } : {}) } };
    },
    async exchangeCode(request, code) {
      const { client, cookies } = context(request);
      const result = await client.auth.exchangeCodeForSession(code);
      providerError(result.error, "AUTH_CALLBACK_FAILED");
      if (!result.data.user || !result.data.session) throw new AuthError("AUTH_CALLBACK_FAILED");
      if (!result.data.user.email_confirmed_at && !result.data.user.confirmed_at) {
        throw new AuthError("EMAIL_VERIFICATION_REQUIRED", expiredCookies(request, cookies));
      }
      return { cookies, user: { id: result.data.user.id, ...(result.data.user.email ? { email: result.data.user.email } : {}) } };
    },
    async refresh(request) {
      const { client, cookies } = context(request);
      const result = await client.auth.refreshSession();
      if (result.error) {
        try { providerError(result.error, "SESSION_EXPIRED"); } catch (error) {
          if (error instanceof AuthError) throw new AuthError(error.code, expiredCookies(request, cookies));
          throw error;
        }
      }
      if (!result.data.user || !result.data.session) {
        throw new AuthError("SESSION_EXPIRED", expiredCookies(request, cookies));
      }
      return { cookies, user: { id: result.data.user.id, ...(result.data.user.email ? { email: result.data.user.email } : {}) } };
    },
    async refreshForProxy(request) {
      const { client, cookies } = context(request);
      const result = await client.auth.getClaims();
      if (result.error || !result.data.claims) {
        throw new AuthError("SESSION_REVOKED", expiredCookies(request, cookies));
      }
      return { cookies };
    },
    async requestPasswordRecovery(request, email, redirectTo) {
      const { client, cookies } = context(request);
      const result = await client.auth.resetPasswordForEmail(email, { redirectTo });
      providerError(result.error, "PASSWORD_RECOVERY_FAILED");
      return { cookies };
    },
    async updatePassword(request, password) {
      const { client, cookies } = context(request);
      const result = await client.auth.updateUser({ password });
      providerError(result.error, "PASSWORD_UPDATE_FAILED");
      if (!result.data.user) throw new AuthError("AUTH_REQUIRED");
      return { cookies };
    },
    async signOut(request, scope) {
      const { client, cookies } = context(request);
      const result = await client.auth.signOut({ scope });
      providerError(result.error, "SIGNOUT_FAILED");
      return { cookies };
    },
    clearSessionCookies: expiredCookies
  };
}

function parseCookies(request: Request): Array<{ name: string; value: string }> {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      return separator < 1
        ? { name: "", value: "" }
        : { name: part.slice(0, separator), value: safeDecode(part.slice(separator + 1)) };
    })
    .filter(({ name }) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name));
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function configuredValues(environment: Record<string, string | undefined> = process.env): {
  url: string;
  publishableKey: string;
} {
  const rawUrl = environment.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? environment.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? "";
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AuthError("SUPABASE_CONFIGURATION_REQUIRED"); }
  const permitsHttp = environment.PAGE2WEBMCP_TEST_MODE === "true";
  if ((url.protocol !== "https:" && !(permitsHttp && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || publishableKey.length < 20
    || unsafeSupabaseBrowserKey(publishableKey)) {
    throw new AuthError("SUPABASE_CONFIGURATION_REQUIRED");
  }
  return { url: url.origin, publishableKey };
}

export function createConfiguredSupabaseAuthService(
  environment: Record<string, string | undefined> = process.env
): AuthService {
  const config = configuredValues(environment);
  return createSupabaseAuthService({
    createClient(request, setCookies) {
      return createServerClient(config.url, config.publishableKey, {
        auth: { flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false, persistSession: true },
        cookies: {
          getAll: () => parseCookies(request),
          setAll: (cookies) => setCookies(cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            options: cookie.options as SupabaseCookieOptions
          })))
        }
      }) as unknown as SupabaseAuthClientLike;
    }
  });
}

/** Browser client for public Auth calls only. Session cookies remain HttpOnly and server-managed. */
export function createPublicSupabaseBrowserClient(
  environment: Record<string, string | undefined> = process.env
) {
  const config = configuredValues(environment);
  return createBrowserClient(config.url, config.publishableKey, {
    auth: { flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
  });
}

let testAuthService: AuthService | undefined;
let configuredAuthService: AuthService | undefined;

export function getAuthService(): AuthService {
  if (testAuthService) return testAuthService;
  configuredAuthService ??= createConfiguredSupabaseAuthService();
  return configuredAuthService;
}

export function setAuthServiceForTest(service: AuthService | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_AUTH_OVERRIDE_FORBIDDEN");
  testAuthService = service;
  configuredAuthService = undefined;
}

export function serializeSupabaseCookie(
  name: string,
  value: string,
  options: SupabaseCookieOptions,
  secure: boolean
): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u001f\u007f;]/.test(value)) {
    throw new AuthError("INVALID_AUTH_COOKIE");
  }
  const sameSite = options.sameSite === "none" ? "None"
    : options.sameSite === "strict" ? "Strict"
      : "Lax";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path?.startsWith("/") ? options.path : "/"}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    `SameSite=${sameSite}`
  ];
  if (options.maxAge !== undefined && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`);
  }
  if (options.expires instanceof Date && Number.isFinite(options.expires.getTime())) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.domain && /^[A-Za-z0-9.-]+$/.test(options.domain)) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
}
