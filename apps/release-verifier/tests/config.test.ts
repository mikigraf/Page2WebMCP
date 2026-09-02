import assert from "node:assert/strict";
import test from "node:test";
import { loadVerifierConfig, targetOriginAllowed } from "../src/config.ts";

const BASE: Record<string, string> = {
  PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS: "127.0.0.1",
  PAGE2WEBMCP_RELEASE_VERIFIER_PORT: "8443",
  PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "verifier-secret-token-value-1234567890",
  PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: "https://acme.example,https://second.example",
  PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN: "https://control.example",
  PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS: "true",
  PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH: "/tmp/page2webmcp-replay.log",
};

test("configuration loads exact bounded values from the environment", () => {
  const config = loadVerifierConfig(BASE);
  assert.equal(config.bindAddress, "127.0.0.1");
  assert.equal(config.port, 8443);
  assert.equal(config.token, BASE.PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN);
  assert.deepEqual([...config.allowedTargetOrigins], ["https://acme.example", "https://second.example"]);
  assert.equal(config.controlPlaneOrigin, "https://control.example");
  assert.equal(config.browser.headless, true);
  assert.equal(config.allowLoopbackTargets, false);
  assert.ok(config.timeouts.totalRequestMs > 0);
  assert.ok(config.limits.maxResponseBytes > 0);
});

test("configuration fails closed with the sorted list of missing names", () => {
  const environment = { ...BASE };
  delete environment.PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN;
  delete environment.PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS;
  assert.throws(() => loadVerifierConfig(environment), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message,
      "RELEASE_VERIFIER_CONFIGURATION_REQUIRED: "
      + "PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS, PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN");
    return true;
  });
});

test("configuration rejects invalid values without echoing secrets", () => {
  for (const [name, value] of [
    ["PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN", "short"],
    ["PAGE2WEBMCP_RELEASE_VERIFIER_PORT", "70000"],
    ["PAGE2WEBMCP_RELEASE_VERIFIER_PORT", "not-a-port"],
    ["PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS", "https://acme.example/path"],
    ["PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS", "http://acme.example"],
    ["PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN", "not-an-origin"],
    ["PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS", "yes"],
  ] as const) {
    assert.throws(() => loadVerifierConfig({ ...BASE, [name]: value }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^RELEASE_VERIFIER_CONFIGURATION_INVALID: [A-Z0-9_]+$/);
      assert.ok(!error.message.includes(value));
      return true;
    }, `${name}=${value}`);
  }
});

test("loopback targets are allowed only when explicitly enabled", () => {
  const strict = loadVerifierConfig({
    ...BASE,
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: "https://acme.example",
  });
  assert.equal(targetOriginAllowed(strict, "https://acme.example"), true);
  assert.equal(targetOriginAllowed(strict, "https://other.example"), false);
  assert.equal(targetOriginAllowed(strict, "http://127.0.0.1:3200"), false);

  const loopback = loadVerifierConfig({
    ...BASE,
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOW_LOOPBACK_TARGETS: "true",
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: "http://127.0.0.1:3200",
  });
  assert.equal(loopback.allowLoopbackTargets, true);
  assert.equal(targetOriginAllowed(loopback, "http://127.0.0.1:3200"), true);
  assert.equal(targetOriginAllowed(loopback, "http://10.0.0.1:3200"), false);
});
