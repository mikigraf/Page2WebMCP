import assert from "node:assert/strict";
import test from "node:test";
import { startGateway, testEnvironment, envelope, sha256Hex, TEST_KMS_KEY_ID, TEST_TOKENS } from "./harness.ts";
import { readGatewaySecret } from "../src/stores/secrets.ts";

const token = TEST_TOKENS["ttl-secret-store"];
const value = "wss://browser-cdp.example/session/1?token=super-secret";

test("a ttl secret put never returns the value and stores only sealed material", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const expiresAt = new Date(current.getTime() + 9 * 60_000).toISOString();
    const payload = { value, purpose: "browser_cdp_url", expiresAt, valueDigest: sha256Hex(value), kmsKeyId: TEST_KMS_KEY_ID };
    const stored = await gateway.json("/v1/ttl-secrets/put", envelope("secret-put-browser_cdp_url", payload), { token });
    assert.equal(stored.status, 200);
    assert.equal("value" in (stored.body ?? {}), false);
    assert.doesNotMatch(stored.raw, /super-secret/);
    assert.match(String(stored.body?.reference), /^secretref:[A-Za-z0-9._:-]{1,200}$/);
    assert.equal(stored.body?.valueDigest, sha256Hex(value));
    assert.equal(stored.body?.purpose, "browser_cdp_url");
    assert.equal(stored.body?.expiresAt, expiresAt);
    assert.equal(stored.body?.kmsKeyId, TEST_KMS_KEY_ID);
  } finally { await gateway.close(); }
});

test("a ttl secret is readable in process, is unreadable after revoke, and is unreadable after expiry", async () => {
  let current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const expiresAt = new Date(current.getTime() + 60_000).toISOString();
    const put = (purpose: string) => gateway.json("/v1/ttl-secrets/put",
      envelope(`secret-put-${purpose}`, { value, purpose, expiresAt, valueDigest: sha256Hex(value), kmsKeyId: TEST_KMS_KEY_ID }),
      { token });

    const first = await put("browser_cdp_url");
    const reference = String(first.body?.reference);
    assert.equal(readGatewaySecret(reference, current), value);

    const revoked = await gateway.json("/v1/ttl-secrets/revoke", envelope("secret-revoke", { reference }), { token });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body?.revoked, true);
    assert.equal(readGatewaySecret(reference, current), undefined);

    const second = await put("browser_live_url");
    const liveReference = String(second.body?.reference);
    assert.equal(readGatewaySecret(liveReference, current), value);
    current = new Date(current.getTime() + 120_000);
    assert.equal(readGatewaySecret(liveReference, current), undefined);
  } finally { await gateway.close(); }
});

test("a ttl secret put fails closed on a wrong digest, a wrong kms key, an expired ttl and an unknown purpose", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const expiresAt = new Date(current.getTime() + 60_000).toISOString();
    const base = { value, purpose: "browser_cdp_url", expiresAt, valueDigest: sha256Hex(value), kmsKeyId: TEST_KMS_KEY_ID };
    const cases: Array<Record<string, unknown>> = [
      { ...base, valueDigest: "0".repeat(64) },
      { ...base, kmsKeyId: "kms://other" },
      { ...base, expiresAt: new Date(current.getTime() - 1_000).toISOString() },
      { ...base, purpose: "arbitrary" },
      { ...base, expiresAt: new Date(current.getTime() + 60 * 60_000).toISOString() },
    ];
    for (const payload of cases) {
      const response = await gateway.json("/v1/ttl-secrets/put", envelope("secret-put-x", payload), { token });
      assert.equal(response.status, 400, JSON.stringify(payload.purpose ?? payload.kmsKeyId));
      assert.doesNotMatch(response.raw, /super-secret/);
    }
  } finally { await gateway.close(); }
});

test("revoking an unknown secret reference is refused rather than silently attested", async () => {
  const gateway = await startGateway();
  try {
    const response = await gateway.json("/v1/ttl-secrets/revoke",
      envelope("secret-revoke", { reference: "secretref:unknown-value" }), { token });
    assert.equal(response.status, 409);
    assert.equal(response.body?.revoked, undefined);
  } finally { await gateway.close(); }
});
