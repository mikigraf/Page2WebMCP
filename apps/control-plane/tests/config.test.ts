import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeConfiguration, validateWorkerRuntimeConfiguration } from "../src/config.ts";

const production = {
  NODE_ENV: "production",
  PAGE2WEBMCP_SESSION_SECRET: "a-production-session-secret-with-32-bytes",
  PAGE2WEBMCP_OWNER_PASSWORD: "a-production-owner-password-with-32-bytes",
  PAGE2WEBMCP_EDITOR_PASSWORD: "a-production-editor-password-with-32-bytes",
  PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.example",
  PAGE2WEBMCP_STORAGE_MODE: "postgres",
  DATABASE_URL: "postgresql://database.example/page2webmcp",
  PAGE2WEBMCP_FIXTURE_APP_URL: "https://acme.example",
  PAGE2WEBMCP_FIXTURE_GITHUB_URL: "https://github.com/acme/support"
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

test("production never accepts the committed fixture passwords or one shared credential", () => {
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_OWNER_PASSWORD: "" }),
    /AUTH_CREDENTIALS_REQUIRED/
  );
  assert.throws(
    () => validateRuntimeConfiguration({
      ...production,
      PAGE2WEBMCP_EDITOR_PASSWORD: production.PAGE2WEBMCP_OWNER_PASSWORD
    }),
    /AUTH_CREDENTIALS_MUST_DIFFER/
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

test("fixture source configuration remains exact and HTTPS", () => {
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_PROVIDER_MODE: "live" }),
    /LIVE_PROVIDER_UNSUPPORTED/
  );
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_FIXTURE_APP_URL: "http://localhost:3200" }),
    /INVALID_FIXTURE_APP_URL/
  );
  assert.throws(
    () => validateRuntimeConfiguration({ ...production, PAGE2WEBMCP_FIXTURE_GITHUB_URL: "https://gitlab.example/acme/support" }),
    /INVALID_FIXTURE_GITHUB_URL/
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
    DATABASE_URL: "postgresql://database.example/page2webmcp",
    PAGE2WEBMCP_FIXTURE_APP_URL: "https://acme.example",
    PAGE2WEBMCP_FIXTURE_GITHUB_URL: "https://github.com/acme/support"
  }));
});
