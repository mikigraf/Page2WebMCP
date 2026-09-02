import assert from "node:assert/strict";
import test from "node:test";
import { startGateway, testEnvironment, envelope, TEST_TOKENS } from "./harness.ts";

const token = TEST_TOKENS["browser-lease-store"];

function claimPayload(expiresAt: string, runId = "run-1"): Record<string, unknown> {
  return {
    organizationId: "org-1",
    projectId: "project-1",
    runId,
    targetOrigin: "https://widgets.example",
    expiresAt,
    policyDigest: "a".repeat(64),
  };
}

test("a browser lease claim round trips, echoes every input, and releases exactly once", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const expiresAt = new Date(current.getTime() + 9 * 60_000).toISOString();
    const payload = claimPayload(expiresAt);
    const claimed = await gateway.json("/v1/browser-leases/claim", envelope("lease-claim", payload), { token });
    assert.equal(claimed.status, 200);
    assert.match(String(claimed.body?.leaseId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    for (const [key, value] of Object.entries(payload)) assert.deepEqual(claimed.body?.[key], value, key);
    assert.equal(claimed.body?.gatewayProtocolVersion, 1);

    const leaseId = String(claimed.body?.leaseId);
    const conflicting = await gateway.json("/v1/browser-leases/claim",
      envelope("lease-claim-other", { ...payload, policyDigest: "b".repeat(64) }), { token });
    assert.equal(conflicting.status, 409);

    const released = await gateway.json("/v1/browser-leases/release", envelope("lease-release", { leaseId }), { token });
    assert.equal(released.status, 200);
    assert.equal(released.body?.released, true);
    assert.equal(released.body?.leaseId, leaseId);

    const reclaimed = await gateway.json("/v1/browser-leases/claim",
      envelope("lease-claim-again", { ...payload, policyDigest: "b".repeat(64) }), { token });
    assert.equal(reclaimed.status, 200);
  } finally { await gateway.close(); }
});

test("an expired lease stops blocking a new claim and cannot be released twice", async () => {
  let current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const expiresAt = new Date(current.getTime() + 60_000).toISOString();
    const first = await gateway.json("/v1/browser-leases/claim", envelope("a", claimPayload(expiresAt)), { token });
    assert.equal(first.status, 200);
    current = new Date(current.getTime() + 120_000);
    const later = new Date(current.getTime() + 60_000).toISOString();
    const second = await gateway.json("/v1/browser-leases/claim", envelope("b", claimPayload(later)), { token });
    assert.equal(second.status, 200);
    assert.notEqual(second.body?.leaseId, first.body?.leaseId);
    const stale = await gateway.json("/v1/browser-leases/release",
      envelope("release-stale", { leaseId: String(first.body?.leaseId) }), { token });
    assert.equal(stale.status, 409);
  } finally { await gateway.close(); }
});

test("a lease claim with an expired or over-long ttl is refused", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const past = new Date(current.getTime() - 1_000).toISOString();
    assert.equal((await gateway.json("/v1/browser-leases/claim", envelope("p", claimPayload(past)), { token })).status, 400);
    const far = new Date(current.getTime() + 60 * 60_000).toISOString();
    assert.equal((await gateway.json("/v1/browser-leases/claim", envelope("f", claimPayload(far)), { token })).status, 400);
  } finally { await gateway.close(); }
});
