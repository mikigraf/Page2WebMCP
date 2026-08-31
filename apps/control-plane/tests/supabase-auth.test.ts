import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthError,
  createSupabaseAuthService,
  serializeSupabaseCookie,
  type SupabaseAuthClientLike
} from "../src/auth.ts";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const now = new Date("2026-08-30T12:00:00.000Z");

function client(overrides: Partial<SupabaseAuthClientLike["auth"]> = {}): SupabaseAuthClientLike {
  return {
    auth: {
      getUser: async () => ({ data: { user: {
        id: USER_ID,
        email: "person@example.test",
        email_confirmed_at: "2026-08-30T11:00:00.000Z",
        user_metadata: { role: "owner", organization_id: "attacker-controlled" }
      } }, error: null }),
      getClaims: async () => ({ data: { claims: {
        sub: USER_ID,
        session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        exp: Math.floor(now.getTime() / 1_000) + 3_600
      } }, error: null }),
      signUp: async () => ({ data: { user: null, session: null }, error: null }),
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: null }),
      exchangeCodeForSession: async () => ({ data: { user: null, session: null }, error: null }),
      refreshSession: async () => ({ data: { user: null, session: null }, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: { user: null }, error: null }),
      signOut: async () => ({ error: null }),
      ...overrides
    }
  };
}

test("protected identity is fetched freshly and ignores user-editable authorization metadata", async () => {
  let clientCreations = 0;
  let userLookups = 0;
  let claimsLookups = 0;
  const fake = client({
    getUser: async () => {
      userLookups += 1;
      return (await client().auth.getUser()) as never;
    },
    getClaims: async () => {
      claimsLookups += 1;
      return (await client().auth.getClaims()) as never;
    }
  });
  const service = createSupabaseAuthService({
    createClient: () => {
      clientCreations += 1;
      return fake;
    },
    now: () => now
  });

  const request = new Request("https://control.example/api/projects?access_token=forged", {
    headers: { authorization: "Bearer forged", cookie: "sb-session=server-cookie" }
  });
  const first = await service.identity(request);
  const second = await service.identity(request);

  assert.deepEqual(first, {
    id: USER_ID,
    email: "person@example.test",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expiresAt: "2026-08-30T13:00:00.000Z"
  });
  assert.deepEqual(second, first);
  assert.equal("role" in first!, false);
  assert.equal("organizationId" in first!, false);
  assert.equal(clientCreations, 2);
  assert.equal(userLookups, 2);
  assert.equal(claimsLookups, 2);
});

test("unverified, expired, and revoked sessions fail with precise diagnostics", async () => {
  const request = new Request("https://control.example/api/projects", {
    headers: { cookie: "sb-control-auth=x" }
  });
  const unverified = createSupabaseAuthService({
    createClient: () => client({
      getUser: async () => ({ data: { user: { id: USER_ID, email: "new@example.test", email_confirmed_at: null } }, error: null })
    }),
    now: () => now
  });
  await assert.rejects(unverified.identity(request), (error: unknown) =>
    error instanceof AuthError && error.code === "EMAIL_VERIFICATION_REQUIRED");

  const expired = createSupabaseAuthService({
    createClient: () => client({
      getClaims: async () => ({ data: { claims: {
        sub: USER_ID,
        session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        exp: Math.floor(now.getTime() / 1_000) - 1
      } }, error: null })
    }),
    now: () => now
  });
  await assert.rejects(expired.identity(request), (error: unknown) =>
    error instanceof AuthError && error.code === "SESSION_EXPIRED"
      && error.cookies.some((cookie) => /^sb-[^=]*=.*Max-Age=0/.test(cookie)));

  const revoked = createSupabaseAuthService({
    createClient: () => client({
      getClaims: async () => ({ data: { claims: null }, error: { message: "invalid JWT" } })
    }),
    now: () => now
  });
  await assert.rejects(revoked.identity(request), (error: unknown) =>
    error instanceof AuthError && error.code === "SESSION_REVOKED");
});

test("unverified provider results cannot provision through login or callback", async () => {
  const service = createSupabaseAuthService({
    createClient: () => client({
      signInWithPassword: async () => ({
        data: { user: { id: USER_ID, email: "new@example.test", email_confirmed_at: null }, session: {} },
        error: null
      }),
      exchangeCodeForSession: async () => ({
        data: { user: { id: USER_ID, email: "new@example.test", email_confirmed_at: null }, session: {} },
        error: null
      })
    }),
    now: () => now
  });
  const request = new Request("https://control.example/api/auth/test", { method: "POST" });
  await assert.rejects(service.signIn(request, "new@example.test", "strong password"),
    (error: unknown) => error instanceof AuthError && error.code === "EMAIL_VERIFICATION_REQUIRED");
  await assert.rejects(service.exchangeCode(request, "one-time-pkce-code"),
    (error: unknown) => error instanceof AuthError && error.code === "EMAIL_VERIFICATION_REQUIRED");
});

test("an auto-confirmed signup returns only its verified identity for convergent provisioning", async () => {
  const service = createSupabaseAuthService({
    createClient: () => client({
      signUp: async () => ({
        data: {
          user: { id: USER_ID, email: "new@example.test", email_confirmed_at: now.toISOString() },
          session: { access_token: "not-returned" }
        },
        error: null
      })
    }),
    now: () => now
  });
  const result = await service.signUp(
    new Request("https://control.example/api/auth/signup", { method: "POST" }),
    "new@example.test",
    "strong password",
    "https://control.example/api/auth/callback"
  );
  assert.deepEqual(result.user, { id: USER_ID, email: "new@example.test" });
  assert.equal(result.emailVerificationRequired, false);
  assert.doesNotMatch(JSON.stringify(result), /access_token/);
});

test("signup, PKCE callback, refresh, recovery, password update, and global revocation use the SSR auth port", async () => {
  const calls: Array<[string, unknown]> = [];
  const fake = client({
    signUp: async (input) => {
      calls.push(["signup", input]);
      return { data: { user: { id: USER_ID, email: input.email, email_confirmed_at: null }, session: null }, error: null } as never;
    },
    signInWithPassword: async (input) => {
      calls.push(["login", input]);
      return { data: { user: { id: USER_ID, email_confirmed_at: now.toISOString() }, session: { access_token: "not-returned" } }, error: null } as never;
    },
    exchangeCodeForSession: async (code) => {
      calls.push(["callback", code]);
      return { data: { user: { id: USER_ID, email_confirmed_at: now.toISOString() }, session: {} }, error: null } as never;
    },
    refreshSession: async () => {
      calls.push(["refresh", undefined]);
      return { data: { user: { id: USER_ID }, session: {} }, error: null } as never;
    },
    resetPasswordForEmail: async (email, options) => {
      calls.push(["recovery", { email, options }]);
      return { data: {}, error: null };
    },
    updateUser: async (attributes) => {
      calls.push(["password", attributes]);
      return { data: { user: { id: USER_ID } }, error: null } as never;
    },
    signOut: async (options) => {
      calls.push(["signout", options]);
      return { error: null };
    }
  });
  const service = createSupabaseAuthService({ createClient: () => fake, now: () => now });
  const request = new Request("https://control.example/api/auth/test", { method: "POST" });

  assert.deepEqual(await service.signUp(request, "new@example.test", "strong password", "https://control.example/api/auth/callback"), {
    emailVerificationRequired: true,
    cookies: []
  });
  await service.signIn(request, "new@example.test", "strong password");
  await service.exchangeCode(request, "one-time-pkce-code");
  await service.refresh(request);
  await service.requestPasswordRecovery(request, "new@example.test", "https://control.example/api/auth/callback?flow=recovery");
  await service.updatePassword(request, "a different strong password");
  await service.signOut(request, "global");

  assert.deepEqual(calls, [
    ["signup", { email: "new@example.test", password: "strong password", options: { emailRedirectTo: "https://control.example/api/auth/callback" } }],
    ["login", { email: "new@example.test", password: "strong password" }],
    ["callback", "one-time-pkce-code"],
    ["refresh", undefined],
    ["recovery", { email: "new@example.test", options: { redirectTo: "https://control.example/api/auth/callback?flow=recovery" } }],
    ["password", { password: "a different strong password" }],
    ["signout", { scope: "global" }]
  ]);
  assert.doesNotMatch(JSON.stringify(await service.signIn(request, "new@example.test", "strong password")), /access_token/);
});

test("Supabase cookies are server-only and securely scoped", () => {
  const serialized = serializeSupabaseCookie("sb-control-auth", "opaque-value", {
    maxAge: 3_600,
    sameSite: "lax"
  }, true);
  assert.equal(serialized,
    "sb-control-auth=opaque-value; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600");
  assert.throws(() => serializeSupabaseCookie("bad cookie", "x", {}, true), /INVALID_AUTH_COOKIE/);
});

test("production cookies drop Secure only for requests to the configured local-stack control origin", async () => {
  const service = createSupabaseAuthService({
    environment: {
      NODE_ENV: "production",
      PAGE2WEBMCP_LOCAL_STACK: "true",
      PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://127.0.0.1:3100"
    },
    createClient(_request, setCookies) {
      setCookies([{ name: "sb-control-auth", value: "opaque", options: { sameSite: "lax" } }]);
      return client({
        signInWithPassword: async () => ({
          data: {
            user: { id: USER_ID, email_confirmed_at: now.toISOString() },
            session: { access_token: "not-returned" }
          },
          error: null
        })
      });
    }
  });

  const local = await service.signIn(
    new Request("http://127.0.0.1:3100/api/auth/login", { method: "POST" }),
    "person@example.test",
    "strong password"
  );
  const wrongLoopbackPort = await service.signIn(
    new Request("http://127.0.0.1:3101/api/auth/login", { method: "POST" }),
    "person@example.test",
    "strong password"
  );
  const remote = await service.signIn(
    new Request("http://control.example/api/auth/login", { method: "POST" }),
    "person@example.test",
    "strong password"
  );

  assert.equal(local.cookies.length, 1);
  assert.doesNotMatch(local.cookies[0]!, /; Secure(?:;|$)/);
  assert.match(wrongLoopbackPort.cookies[0]!, /; Secure(?:;|$)/);
  assert.match(remote.cookies[0]!, /; Secure(?:;|$)/);
});
