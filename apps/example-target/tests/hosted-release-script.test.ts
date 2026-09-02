import assert from "node:assert/strict";
import test from "node:test";
import { HOSTED_ARTIFACT_PREFIX, LOCAL_ARTIFACT_PREFIX, parseHostedReleaseScript } from "../app/hosted-release-script.tsx";

const hash = "b".repeat(64);
const integrity = `sha384-${Buffer.alloc(48, 9).toString("base64")}`;
const targetOrigin = "https://parts.beaconworks.dev";

function hostedEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL: `${HOSTED_ARTIFACT_PREFIX}/${hash}.js`,
    PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_CONTENT_HASH: hash,
    PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY: integrity,
    PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: targetOrigin,
    ...overrides,
  };
}

test("example target accepts exactly the hosted Supabase Storage object for the pinned content hash", () => {
  assert.deepEqual(parseHostedReleaseScript(hostedEnvironment()), {
    src: `${HOSTED_ARTIFACT_PREFIX}/${hash}.js`,
    integrity,
    contentHash: hash,
    targetOrigin,
    localOnly: false,
  });
});

test("example target accepts the loopback storage object only when the local stack is selected", () => {
  const local = hostedEnvironment({
    PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL: `${LOCAL_ARTIFACT_PREFIX}/${hash}.js`,
    PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: "http://127.0.0.1:3300",
  });
  assert.deepEqual(parseHostedReleaseScript({ ...local, PAGE2WEBMCP_LOCAL_STACK: "true" }), {
    src: `${LOCAL_ARTIFACT_PREFIX}/${hash}.js`,
    integrity,
    contentHash: hash,
    targetOrigin: "http://127.0.0.1:3300",
    localOnly: true,
  });
  assert.throws(() => parseHostedReleaseScript(local), /HOSTED_RELEASE_CONFIG_INVALID/);
  assert.throws(
    () => parseHostedReleaseScript({ ...hostedEnvironment(), PAGE2WEBMCP_LOCAL_STACK: "true" }),
    /HOSTED_RELEASE_CONFIG_INVALID/,
  );
});

test("example target rejects the control-plane artifact route in favour of the hosted object", () => {
  assert.throws(() => parseHostedReleaseScript(hostedEnvironment({
    PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL: `https://control.page2webmcp.dev/api/releases/${hash}.js`,
  })), /HOSTED_RELEASE_CONFIG_INVALID/);
});

test("example target release configuration fails closed for absent, mutable, corrupt, or cross-target metadata", () => {
  const cases: Array<Record<string, string | undefined>> = [
    {},
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL: undefined }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY: undefined }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: undefined }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL: `${HOSTED_ARTIFACT_PREFIX}/latest.js` }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL: `${HOSTED_ARTIFACT_PREFIX}/${hash}.js?token=secret` }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL: `${HOSTED_ARTIFACT_PREFIX}/${hash}.js#fragment` }),
    hostedEnvironment({
      PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL:
        `https://user:pass@bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${hash}.js`,
    }),
    hostedEnvironment({
      PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL:
        `https://releases.example.net/storage/v1/object/public/page2webmcp-releases/${hash}.js`,
    }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_CONTENT_HASH: "c".repeat(64) }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_CONTENT_HASH: "not-a-hash" }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY: "sha384-corrupt*" }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY: `sha384-${Buffer.alloc(32, 9).toString("base64")}` }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY: `sha256-${Buffer.alloc(48, 9).toString("base64")}` }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: "https://parts.beaconworks.dev/console" }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: "http://parts.beaconworks.dev" }),
    hostedEnvironment({ PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: "https://support.acme.dev" }),
  ];
  for (const environment of cases) {
    assert.throws(() => parseHostedReleaseScript(environment), /HOSTED_RELEASE_CONFIG_INVALID/);
  }
});

test("a re-encoded SHA-384 digest must round-trip to exactly 48 bytes", () => {
  const stray = `${integrity}=`;
  assert.equal(Buffer.from(stray.slice("sha384-".length), "base64").byteLength, 48);
  assert.throws(() => parseHostedReleaseScript(hostedEnvironment({
    PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY: stray,
  })), /HOSTED_RELEASE_CONFIG_INVALID/);
});
