import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWebsiteGatewayConfiguration,
  websiteGatewayMissingConfiguration,
} from "../src/config.ts";
import { testEnvironment } from "./harness.ts";

test("a complete environment reports nothing missing", () => {
  assert.deepEqual(websiteGatewayMissingConfiguration(testEnvironment()), []);
});

test("missing and malformed names are reported sorted, without any secret value", () => {
  const environment = testEnvironment({
    PAGE2WEBMCP_GATEWAY_EVIDENCE_STORE_TOKEN: "too-short",
    PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_ORIGIN: "http://api.browser-use.com",
  });
  delete (environment as Record<string, string | undefined>).PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_TOKEN;
  const missing = websiteGatewayMissingConfiguration(environment);
  assert.deepEqual(missing, [
    "PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_TOKEN",
    "PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_ORIGIN",
    "PAGE2WEBMCP_GATEWAY_EVIDENCE_STORE_TOKEN",
  ]);
  assert.deepEqual(missing, [...missing].sort());
  assert.doesNotMatch(JSON.stringify(missing), /too-short/);
  assert.throws(() => loadWebsiteGatewayConfiguration(environment), (error: Error) => {
    assert.equal(error.message, "WEBSITE_GATEWAY_CONFIGURATION_REQUIRED");
    assert.doesNotMatch(JSON.stringify(error), /too-short/);
    return true;
  });
});

test("only the controls this process serves require their credentials", () => {
  const environment: Record<string, string | undefined> = testEnvironment({
    PAGE2WEBMCP_GATEWAY_CONTROLS: "browser-use-v4",
  });
  delete environment.PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_TOKEN;
  delete environment.PAGE2WEBMCP_GATEWAY_EVIDENCE_STORE_TOKEN;
  delete environment.PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_ROOT_KEY;
  assert.deepEqual(websiteGatewayMissingConfiguration(environment as Record<string, string>), []);
  const configuration = loadWebsiteGatewayConfiguration(environment as Record<string, string>);
  assert.deepEqual([...configuration.controls], ["browser-use-v4"]);
});

test("an unknown or empty control list is refused", () => {
  assert.deepEqual(websiteGatewayMissingConfiguration(testEnvironment({ PAGE2WEBMCP_GATEWAY_CONTROLS: "" })),
    ["PAGE2WEBMCP_GATEWAY_CONTROLS"]);
  assert.deepEqual(websiteGatewayMissingConfiguration(testEnvironment({ PAGE2WEBMCP_GATEWAY_CONTROLS: "nope" })),
    ["PAGE2WEBMCP_GATEWAY_CONTROLS"]);
});

test("the kms root key must be a real 32 byte key", () => {
  assert.deepEqual(websiteGatewayMissingConfiguration(testEnvironment({
    PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_ROOT_KEY: "c2hvcnQ=",
  })), ["PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_ROOT_KEY"]);
});

test("controls that resolve stored secrets must be colocated with the secret store", () => {
  // The portal reads the checkpoint's CDP reference from the secret store in
  // its own process, so splitting them across services can never verify.
  for (const control of ["authentication-handoff", "cdp-observer"] as const) {
    const environment = testEnvironment({ PAGE2WEBMCP_GATEWAY_CONTROLS: control });
    assert.throws(
      () => loadWebsiteGatewayConfiguration(environment),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "WEBSITE_GATEWAY_CONTROL_COLOCATION_REQUIRED");
        return true;
      },
      control,
    );
    const colocated = testEnvironment({ PAGE2WEBMCP_GATEWAY_CONTROLS: `${control},ttl-secret-store` });
    assert.ok(loadWebsiteGatewayConfiguration(colocated).controls.has(control));
  }
});

test("a control list without either resolving control needs no secret store", () => {
  const environment = testEnvironment({ PAGE2WEBMCP_GATEWAY_CONTROLS: "browser-lease-store" });
  assert.ok(loadWebsiteGatewayConfiguration(environment).controls.has("browser-lease-store"));
});
