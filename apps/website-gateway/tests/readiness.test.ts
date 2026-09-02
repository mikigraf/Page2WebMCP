import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { startGateway, testEnvironment, sha256Hex, TEST_KMS_KEY_ID, TEST_TOKENS } from "./harness.ts";

const CONTROLS = [
  "authentication-handoff", "browser-lease-store", "browser-use-v4", "cdp-observer",
  "egress-policy-store", "egress-proxy", "evidence-store", "ownership-store", "ttl-secret-store",
] as const;

const upstream = {
  verifyCredentials: async () => ({ apiVersion: "v4" as const, authenticated: true as const, model: "browser-use-2.0" as const }),
  startSession: async () => { throw new Error("UNUSED"); },
  stopSession: async () => { throw new Error("UNUSED"); },
  reconcileSession: async () => { throw new Error("UNUSED"); },
};

test("readiness echoes the requesting control with the exact contract the worker validates", async () => {
  const gateway = await startGateway(testEnvironment(), { browserUseUpstream: upstream });
  try {
    for (const control of CONTROLS) {
      const releaseHash = "a".repeat(64);
      const nonce = "c".repeat(64);
      const { status, body } = await gateway.readiness(control, { releaseHash, nonce });
      assert.equal(status, 200, control);
      const expected: Record<string, unknown> = {
        gatewayProtocolVersion: 1,
        status: "ready",
        readOnly: true,
        control,
        selectedReleaseHash: releaseHash,
        nonce,
      };
      if (control === "authentication-handoff") {
        expected.authenticationCheckpointProtocolVersion = 1;
        expected.authenticationUserHandoffProtocolVersion = 1;
      }
      if (control === "ownership-store") expected.sourceAttestationProtocolVersion = 1;
      if (control === "browser-use-v4") {
        expected.gateway = "page2webmcp-browser-use-v4";
        expected.upstream = { apiVersion: "v4", authenticated: true, model: "browser-use-2.0" };
      }
      if (control === "ttl-secret-store") {
        expected.kmsKeyIdDigest = createHash("sha256").update(TEST_KMS_KEY_ID, "utf8").digest("hex");
      }
      assert.deepEqual(body, expected, control);
    }
  } finally { await gateway.close(); }
});

test("readiness rejects an unknown control, a control this process does not serve, and a mismatched credential", async () => {
  const gateway = await startGateway(testEnvironment(), { browserUseUpstream: upstream });
  try {
    assert.equal((await gateway.readiness("not-a-control")).status, 400);
    assert.equal((await gateway.readiness("evidence-store", { token: TEST_TOKENS["cdp-observer"] })).status, 403);
    assert.equal((await gateway.readiness("browser-use-v4", { apiKey: "bu_wrong_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).status, 403);
  } finally { await gateway.close(); }
});

test("readiness on a split deployment refuses controls served by the other origin", async () => {
  const environment = testEnvironment({ PAGE2WEBMCP_GATEWAY_CONTROLS: "browser-use-v4" });
  const gateway = await startGateway(environment, { browserUseUpstream: upstream });
  try {
    assert.equal((await gateway.readiness("browser-use-v4")).status, 200);
    assert.equal((await gateway.readiness("authentication-handoff")).status, 404);
  } finally { await gateway.close(); }
});

test("readiness fails closed on a malformed release hash, nonce, or kms digest mismatch", async () => {
  const gateway = await startGateway(testEnvironment(), { browserUseUpstream: upstream });
  try {
    assert.equal((await gateway.readiness("evidence-store", { releaseHash: "short" })).status, 400);
    assert.equal((await gateway.readiness("evidence-store", { nonce: "zz" })).status, 400);
    assert.equal((await gateway.readiness("ttl-secret-store", { kmsKeyIdDigest: sha256Hex("other") })).status, 403);
  } finally { await gateway.close(); }
});

test("readiness never attests an unauthenticated Browser Use upstream", async () => {
  const gateway = await startGateway(testEnvironment(), {
    browserUseUpstream: { ...upstream, verifyCredentials: async () => { throw new Error("BROWSER_USE_UPSTREAM_UNAUTHORIZED"); } },
  });
  try {
    const { status, body } = await gateway.readiness("browser-use-v4");
    assert.equal(status, 503);
    assert.equal(body?.status, undefined);
  } finally { await gateway.close(); }
});
