import assert from "node:assert/strict";
import test from "node:test";
import { startGateway, testEnvironment, envelope, canonicalJson, TEST_TOKENS } from "./harness.ts";

const policyToken = TEST_TOKENS["egress-policy-store"];
const proxyToken = TEST_TOKENS["egress-proxy"];
const targetOrigin = "https://widgets.example";
const routes = [{ methods: ["GET", "HEAD"], origin: targetOrigin, pathPrefix: "/" }];

test("an egress policy issues, applies, enforces, and revokes on both stores", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const issueRequest = envelope("policy-issue", { denyByDefault: true, ttlSeconds: 540, routes, targetOrigin });
    const issued = await gateway.json("/v1/website-egress-policies/issue", issueRequest, { token: policyToken });
    assert.equal(issued.status, 200);
    const reference = String(issued.body?.reference);
    const expiresAt = String(issued.body?.expiresAt);
    assert.match(reference, /^secretref:[A-Za-z0-9._:-]{1,200}$/);
    assert.equal(canonicalJson(issued.body), canonicalJson({ ...issueRequest, reference, expiresAt }));
    assert.ok(Date.parse(expiresAt) - current.getTime() <= 540_000);

    const applyRequest = envelope("policy-apply", { denyByDefault: true, expiresAt, routes, targetOrigin, reference });
    const applied = await gateway.json("/v1/website-egress-policies/apply", applyRequest, { token: proxyToken });
    assert.equal(applied.status, 200);
    assert.equal(canonicalJson(applied.body), canonicalJson({ ...applyRequest, enforced: true }));

    const proxyRevoke = await gateway.json("/v1/website-egress-policies/revoke",
      envelope("policy-proxy-revoke", { reference }), { token: proxyToken });
    assert.equal(proxyRevoke.status, 200);
    assert.equal(proxyRevoke.body?.revoked, true);
    const storeRevoke = await gateway.json("/v1/website-egress-policies/revoke",
      envelope("policy-store-revoke", { reference }), { token: policyToken });
    assert.equal(storeRevoke.status, 200);
    assert.equal(storeRevoke.body?.revoked, true);

    const reapplied = await gateway.json("/v1/website-egress-policies/apply", applyRequest, { token: proxyToken });
    assert.equal(reapplied.status, 409);
  } finally { await gateway.close(); }
});

test("apply refuses a policy the store never issued, a mutated policy, and an expired one", async () => {
  let current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), { clock: () => current });
  try {
    const forged = envelope("policy-apply", {
      denyByDefault: true, expiresAt: new Date(current.getTime() + 60_000).toISOString(),
      routes, targetOrigin, reference: "secretref:forged-policy",
    });
    assert.equal((await gateway.json("/v1/website-egress-policies/apply", forged, { token: proxyToken })).status, 409);

    const issued = await gateway.json("/v1/website-egress-policies/issue",
      envelope("policy-issue", { denyByDefault: true, ttlSeconds: 540, routes, targetOrigin }), { token: policyToken });
    const reference = String(issued.body?.reference);
    const expiresAt = String(issued.body?.expiresAt);
    const mutated = envelope("policy-apply", {
      denyByDefault: true, expiresAt, reference, targetOrigin: "https://other.example",
      routes: [{ methods: ["GET", "HEAD"], origin: "https://other.example", pathPrefix: "/" }],
    });
    assert.equal((await gateway.json("/v1/website-egress-policies/apply", mutated, { token: proxyToken })).status, 409);

    current = new Date(current.getTime() + 600_000);
    const late = envelope("policy-apply", { denyByDefault: true, expiresAt, routes, targetOrigin, reference });
    assert.equal((await gateway.json("/v1/website-egress-policies/apply", late, { token: proxyToken })).status, 409);
  } finally { await gateway.close(); }
});

test("a failure inside apply never attests enforcement and never leaks the policy reference", async () => {
  const current = new Date("2026-08-31T12:00:00.000Z");
  const gateway = await startGateway(testEnvironment(), {
    clock: () => current,
    egressEnforcer: { install: () => { throw new Error("proxy dataplane token=must-not-leak"); }, revoke: () => false, check: () => false },
  });
  try {
    const issued = await gateway.json("/v1/website-egress-policies/issue",
      envelope("policy-issue", { denyByDefault: true, ttlSeconds: 540, routes, targetOrigin }), { token: policyToken });
    const reference = String(issued.body?.reference);
    const expiresAt = String(issued.body?.expiresAt);
    const applied = await gateway.json("/v1/website-egress-policies/apply",
      envelope("policy-apply", { denyByDefault: true, expiresAt, routes, targetOrigin, reference }), { token: proxyToken });
    assert.equal(applied.status, 503);
    assert.equal(applied.body?.enforced, undefined);
    assert.doesNotMatch(applied.raw, /must-not-leak/);
  } finally { await gateway.close(); }
});

test("issue refuses a policy that is not deny-by-default or that routes off the target origin", async () => {
  const gateway = await startGateway();
  try {
    assert.equal((await gateway.json("/v1/website-egress-policies/issue",
      envelope("policy-issue", { denyByDefault: false, ttlSeconds: 540, routes, targetOrigin }),
      { token: policyToken })).status, 400);
    assert.equal((await gateway.json("/v1/website-egress-policies/issue",
      envelope("policy-issue", {
        denyByDefault: true, ttlSeconds: 540, targetOrigin,
        routes: [{ methods: ["GET", "POST"], origin: targetOrigin, pathPrefix: "/" }],
      }), { token: policyToken })).status, 400);
    assert.equal((await gateway.json("/v1/website-egress-policies/issue",
      envelope("policy-issue", {
        denyByDefault: true, ttlSeconds: 540, targetOrigin,
        routes: [{ methods: ["GET", "HEAD"], origin: "https://elsewhere.example", pathPrefix: "/" }],
      }), { token: policyToken })).status, 400);
  } finally { await gateway.close(); }
});
