import assert from "node:assert/strict";
import test from "node:test";
import { getAuthService, setAuthServiceForTest } from "../src/auth.ts";
import { localFixtureRuntimeEnabled } from "../src/local-runtime.ts";

test("the hermetic demo runtime is enabled only by explicit local test controls", () => {
  const base = {
    NODE_ENV: "development",
    PAGE2WEBMCP_PROVIDER_MODE: "local",
    PAGE2WEBMCP_STORAGE_MODE: "memory",
    PAGE2WEBMCP_TEST_MODE: "true",
    PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE: "true",
  };
  assert.equal(localFixtureRuntimeEnabled(base), true);
  assert.equal(localFixtureRuntimeEnabled({ ...base, NODE_ENV: "production" }), false);
  assert.equal(localFixtureRuntimeEnabled({ ...base, PAGE2WEBMCP_TEST_MODE: "false" }), false);
  assert.equal(localFixtureRuntimeEnabled({ ...base, PAGE2WEBMCP_PROVIDER_MODE: "openapi" }), false);
});

test("the local demo auth service accepts the configured development password", async () => {
  const names = [
    "NODE_ENV",
    "PAGE2WEBMCP_PROVIDER_MODE",
    "PAGE2WEBMCP_STORAGE_MODE",
    "PAGE2WEBMCP_TEST_MODE",
    "PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE",
    "PAGE2WEBMCP_OWNER_PASSWORD",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    NODE_ENV: "development",
    PAGE2WEBMCP_PROVIDER_MODE: "local",
    PAGE2WEBMCP_STORAGE_MODE: "memory",
    PAGE2WEBMCP_TEST_MODE: "true",
    PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE: "true",
    PAGE2WEBMCP_OWNER_PASSWORD: "local-owner-password",
  });
  setAuthServiceForTest(undefined);
  try {
    const result = await getAuthService().signIn(
      new Request("http://127.0.0.1:3100/api/auth/login"),
      "owner@example.test",
      "local-owner-password",
    );
    assert.equal(result.user?.id, "11111111-1111-1111-1111-111111111111");
    assert.match(result.cookies[0] ?? "", /^page2webmcp_fixture_session=/);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else Object.assign(process.env, { [name]: value });
    }
    setAuthServiceForTest(undefined);
  }
});
