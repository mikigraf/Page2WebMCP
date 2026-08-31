import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeConfiguration, validateWorkerRuntimeConfiguration } from "../src/config.ts";

const production = {
  NODE_ENV: "production",
  PAGE2WEBMCP_SESSION_SECRET: "a-production-session-secret-with-32-bytes",
  NEXT_PUBLIC_SUPABASE_URL: "https://auth.example",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_safe-public-key-value",
  PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.example",
  PAGE2WEBMCP_SUPABASE_URL: "https://bimqgiedckdurqiywctl.supabase.co",
  PAGE2WEBMCP_SUPABASE_SECRET_KEY: "sb_secret_test-only-artifact-storage-key",
  PAGE2WEBMCP_PUBLIC_ORIGIN: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
  PAGE2WEBMCP_STORAGE_MODE: "postgres",
  DATABASE_URL: "postgresql://database.example/page2webmcp"
};

const localProduction = {
  ...production,
  PAGE2WEBMCP_LOCAL_STACK: "true",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://127.0.0.1:3100",
  PAGE2WEBMCP_SUPABASE_URL: "http://127.0.0.1:54321",
  PAGE2WEBMCP_PUBLIC_ORIGIN: "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases"
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

test("production permits HTTP Auth and control origins only for the explicit IP-literal local stack", () => {
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
  assert.throws(() => validateRuntimeConfiguration({
    ...production,
    PAGE2WEBMCP_TEST_MODE: "true",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://127.0.0.1:3100"
  }), /SUPABASE_CONFIGURATION_REQUIRED|INVALID_CONTROL_PLANE_PUBLIC_ORIGIN/);
  assert.doesNotThrow(() => validateRuntimeConfiguration(localProduction));
  assert.doesNotThrow(() => validateRuntimeConfiguration({
    ...localProduction,
    NEXT_PUBLIC_SUPABASE_URL: "http://[::1]:54321",
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://[::1]:3100"
  }));
  for (const overrides of [
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://localhost:3100" },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://127.0.0.2:3100" },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://127.0.0.1:3101" },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://[::1]:3101" },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://127.0.0.1:3100/path" },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://user@127.0.0.1:3100" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.2:54321" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54322" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://[::1]:54322" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321/auth/v1" },
    { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321?unsafe=true" }
  ]) assert.throws(
    () => validateRuntimeConfiguration({ ...localProduction, ...overrides }),
    /SUPABASE_CONFIGURATION_REQUIRED|INVALID_CONTROL_PLANE_PUBLIC_ORIGIN/
  );
});

test("production requires this app's exact hosted Supabase Storage artifact topology", () => {
  for (const overrides of [
    { PAGE2WEBMCP_SUPABASE_URL: "" },
    { PAGE2WEBMCP_SUPABASE_SECRET_KEY: "" },
    { PAGE2WEBMCP_PUBLIC_ORIGIN: "" },
    { PAGE2WEBMCP_SUPABASE_URL: "https://different-project.supabase.co" },
    { PAGE2WEBMCP_SUPABASE_URL: "https://bimqgiedckdurqiywctl.supabase.co/" },
    { PAGE2WEBMCP_PUBLIC_ORIGIN: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/other" },
    { PAGE2WEBMCP_PUBLIC_ORIGIN: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/" },
  ]) {
    assert.throws(
      () => validateRuntimeConfiguration({ ...production, ...overrides }),
      /^Error: RELEASE_ARTIFACT_CONFIGURATION_REQUIRED$/,
    );
  }
});

test("production rejects artifact Storage secret aliases without rejecting browser Auth configuration", () => {
  for (const overrides of [
    { NEXT_PUBLIC_PAGE2WEBMCP_SUPABASE_URL: production.PAGE2WEBMCP_SUPABASE_URL },
    { NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: production.PAGE2WEBMCP_SUPABASE_SECRET_KEY },
    { PAGE2WEBMCP_SUPABASE_SERVICE_ROLE_KEY: production.PAGE2WEBMCP_SUPABASE_SECRET_KEY },
    { SUPABASE_SECRET_KEY: production.PAGE2WEBMCP_SUPABASE_SECRET_KEY },
  ]) {
    assert.throws(
      () => validateRuntimeConfiguration({ ...production, ...overrides }),
      /^Error: RELEASE_ARTIFACT_SECRET_EXPOSURE_BLOCKED$/,
    );
  }
  assert.doesNotThrow(() => validateRuntimeConfiguration(production));
});

test("shared configuration recognizes only exact untrimmed provider mode spellings", () => {
  for (const mode of ["local", "openapi", "website", "github"]) {
    assert.doesNotThrow(() => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_PROVIDER_MODE: mode }));
  }
  for (const mode of ["", "live", "OpenAPI", " openapi", "openapi "]) {
    assert.throws(
      () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_PROVIDER_MODE: mode }),
      /^Error: INVALID_PROVIDER_MODE$/,
    );
  }
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
    /INVALID_PROVIDER_MODE/
  );
  assert.throws(() => validateWorkerRuntimeConfiguration({
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_PROVIDER_MODE: "local",
    DATABASE_URL: "postgresql://database.example/page2webmcp"
  }), /^Error: WORKER_PROVIDER_MODE_REQUIRED$/);
  assert.throws(() => validateWorkerRuntimeConfiguration({
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    DATABASE_URL: "postgresql://database.example/page2webmcp"
  }), /^Error: WORKER_PROVIDER_MODE_REQUIRED$/);
  assert.doesNotThrow(() => validateWorkerRuntimeConfiguration({
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_PROVIDER_MODE: "openapi",
    DATABASE_URL: "postgresql://database.example/page2webmcp"
  }));
  assert.doesNotThrow(() => validateWorkerRuntimeConfiguration({
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_PROVIDER_MODE: "website",
    DATABASE_URL: "postgresql://database.example/page2webmcp"
  }));
  assert.doesNotThrow(() => validateWorkerRuntimeConfiguration({
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_PROVIDER_MODE: "github",
    DATABASE_URL: "postgresql://database.example/page2webmcp"
  }));
});
