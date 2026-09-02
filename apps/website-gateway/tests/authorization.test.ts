import assert from "node:assert/strict";
import test from "node:test";
import { startGateway, testEnvironment, envelope, TEST_TOKENS, TEST_BROWSER_USE_KEY } from "./harness.ts";

test("a token for one control is refused on another control's route", async () => {
  const gateway = await startGateway();
  try {
    const leaseClaim = { targetOrigin: "https://widgets.example", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      organizationId: "org-1", projectId: "project-1", runId: "run-1", policyDigest: "0".repeat(64) };
    const rejected = await gateway.json("/v1/browser-leases/claim", envelope("lease-claim", leaseClaim), {
      token: TEST_TOKENS["evidence-store"],
    });
    assert.equal(rejected.status, 403);
    assert.doesNotMatch(rejected.raw, /evidence_store_control_token/);

    const crossed = await gateway.json("/v1/website-evidence/put", envelope("evidence-put", { record: {} }), {
      token: TEST_TOKENS["browser-lease-store"],
    });
    assert.equal(crossed.status, 403);
  } finally { await gateway.close(); }
});

test("the Browser Use api key never authorizes a bearer-scoped route and vice versa", async () => {
  const gateway = await startGateway();
  try {
    const withApiKey = await gateway.json("/v1/ttl-secrets/revoke", envelope("secret-revoke", { reference: "secretref:x" }), {
      apiKey: TEST_BROWSER_USE_KEY,
    });
    assert.equal(withApiKey.status, 401);
    const withBearer = await gateway.json("/v1/browser-use-v4/sessions/stop",
      envelope("browser-stop", { providerSessionId: "session-1", reason: "failed" }),
      { token: TEST_TOKENS["authentication-handoff"] });
    assert.equal(withBearer.status, 401);
  } finally { await gateway.close(); }
});

test("missing credentials, wrong method, unknown path and oversized bodies fail closed", async () => {
  const gateway = await startGateway();
  try {
    assert.equal((await gateway.json("/v1/browser-leases/release", envelope("lease-release", { leaseId: "l" }))).status, 401);
    assert.equal((await gateway.json("/v1/nope", {}, { token: TEST_TOKENS["evidence-store"] })).status, 404);
    assert.equal((await gateway.get("/v1/browser-leases/claim")).status, 405);
    const oversized = await gateway.json("/v1/website-evidence/put",
      envelope("evidence-put", { record: { padding: "x".repeat(70_000) } }), { token: TEST_TOKENS["evidence-store"] });
    assert.equal(oversized.status, 413);
  } finally { await gateway.close(); }
});

test("a control this process does not serve answers 404 rather than authenticating", async () => {
  const gateway = await startGateway(testEnvironment({ PAGE2WEBMCP_GATEWAY_CONTROLS: "evidence-store" }));
  try {
    assert.equal((await gateway.json("/v1/browser-leases/claim", envelope("lease-claim", {}), {
      token: TEST_TOKENS["browser-lease-store"],
    })).status, 404);
  } finally { await gateway.close(); }
});
