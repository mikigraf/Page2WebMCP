import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeConfiguration, validateWorkerRuntimeConfiguration } from "../src/config.ts";

const production = {
  NODE_ENV: "production",
  PAGE2WEBMCP_SESSION_SECRET: "a-production-session-secret-with-32-bytes",
  NEXT_PUBLIC_SUPABASE_URL: "https://auth.example",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_safe-public-key-value",
  PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.example",
  PAGE2WEBMCP_STORAGE_MODE: "postgres",
  DATABASE_URL: "postgresql://database.example/page2webmcp"
};

test("production configuration requires a strong session secret and durable database", () => {
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_SESSION_SECRET: "short" }),
    /SESSION_SECRET_REQUIRED/
  );
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, DATABASE_URL: "" }),
    /DATABASE_URL_REQUIRED/
  );
  assert.doesNotThrow(() => validateRuntimeConfiguration(production));
});

test("production memory storage is restricted to an explicit ephemeral-test override", () => {
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_STORAGE_MODE: "memory", DATABASE_URL: "" }),
    /EPHEMERAL_STORAGE_FORBIDDEN/
  );
  assert.doesNotThrow(() => validateRuntimeConfiguration({
    ...production,
    PAGE2WEBMCP_STORAGE_MODE: "memory",
    PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE: "true",
    PAGE2WEBMCP_TEST_MODE: "true",
    DATABASE_URL: ""
  }));
  assert.throws(() => validateRuntimeConfiguration({
    ...production,
    PAGE2WEBMCP_STORAGE_MODE: "memory",
    PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE: "true",
    DATABASE_URL: ""
  }), /EPHEMERAL_STORAGE_FORBIDDEN/);
});

test("production requires public Supabase configuration and rejects browser-exposed secret keys", () => {
  const serviceRoleJwt = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ role: "service_role", ref: "project" })).toString("base64url"),
    "unsafe-signature-value"
  ].join(".");
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, NEXT_PUBLIC_SUPABASE_URL: "" }),
    /SUPABASE_CONFIGURATION_REQUIRED/
  );
  assert.throws(
    () => validateRuntimeConfiguration({
      ...production,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_this-must-never-enter-browser-code"
    }),
    /SUPABASE_CONFIGURATION_REQUIRED/
  );
  assert.throws(
    () => validateRuntimeConfiguration({
      ...production,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: serviceRoleJwt
    }),
    /SUPABASE_CONFIGURATION_REQUIRED/
  );
});

test("production requires an exact HTTPS public origin for CSRF validation", () => {
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "" }),
    /INVALID_CONTROL_PLANE_PUBLIC_ORIGIN/
  );
  assert.throws(
    () => validateRuntimeConfiguration({
      ...production,
      PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.example/path"
    }),
    /INVALID_CONTROL_PLANE_PUBLIC_ORIGIN/
  );
  assert.throws(
    () => validateRuntimeConfiguration({
      ...production,
      PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://control.example"
    }),
    /INVALID_CONTROL_PLANE_PUBLIC_ORIGIN/
  );
  assert.doesNotThrow(() => validateRuntimeConfiguration({
    ...production,
    PAGE2WEBMCP_TEST_MODE: "true",
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://127.0.0.1:3100"
  }));
});

test("live provider mode remains fail closed until explicit controls are configured", () => {
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_PROVIDER_MODE: "live" }),
    /LIVE_PROVIDER_UNSUPPORTED/
  );
});

test("the standalone worker fails before polling without durable storage", () => {
  assert.throws(
    () => validateWorkerRuntimeConfiguration({
      PAGE2WEBMCP_STORAGE_MODE: "memory",
      PAGE2WEBMCP_PROVIDER_MODE: "local"
    }),
    /WORKER_POSTGRES_REQUIRED/
  );
  assert.throws(
    () => validateWorkerRuntimeConfiguration({
      PAGE2WEBMCP_STORAGE_MODE: "postgres",
      PAGE2WEBMCP_PROVIDER_MODE: "live",
      DATABASE_URL: "postgresql:\/\/database.example\/page2webmcp"
    }),
    /LIVE_PROVIDER_UNSUPPORTED/
  );
  assert.doesNotThrow(() => validateWorkerRuntimeConfiguration({
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_PROVIDER_MODE: "local",
    DATABASE_URL: "postgresql://database.example/page2webmcp"
  }));
});
