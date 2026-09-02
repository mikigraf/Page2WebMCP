import assert from "node:assert/strict";
import test from "node:test";
import { chromiumUnavailableReason } from "../src/browser.ts";
import { verifyCandidateRelease } from "../src/candidate.ts";
import { loadVerifierConfig, type VerifierConfig } from "../src/config.ts";
import { verifierFixturePlans } from "./fixtures/plans.ts";
import { startTargetFixture, type TargetFixture } from "./fixtures/target-fixture.ts";

const skip = chromiumUnavailableReason();

function config(fixture: TargetFixture, overrides: Record<string, string> = {}): VerifierConfig {
  return loadVerifierConfig({
    PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS: "127.0.0.1",
    PAGE2WEBMCP_RELEASE_VERIFIER_PORT: "0",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "verifier-secret-token-value-1234567890",
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: fixture.origin,
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOW_LOOPBACK_TARGETS: "true",
    PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN: "https://control.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS: "true",
    PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH: "",
    PAGE2WEBMCP_RELEASE_VERIFIER_TARGET_SESSION_COOKIES: JSON.stringify([{
      name: "fixture_session",
      value: "fixture-session-value",
      domain: "127.0.0.1",
      path: "/",
    }]),
    PAGE2WEBMCP_RELEASE_VERIFIER_EXECUTION_PLAN: JSON.stringify({
      read: { toolName: "find_order", input: { query: "ORD-4812" } },
      mutation: {
        toolName: "create_support_ticket",
        input: { orderId: "ORD-4812", title: "TEST candidate {{marker}}" },
      },
      finalState: { toolName: "find_order", input: { query: "ORD-4812" } },
    }),
    ...overrides,
  });
}

function candidatePayload(fixture: TargetFixture) {
  return {
    code: fixture.release.code,
    contentHash: fixture.release.contentHash,
    integrity: fixture.release.integrity,
    manifest: fixture.release.manifest,
    targetOrigin: fixture.origin,
    expectedTools: ["create_support_ticket", "find_order"],
  };
}

test("candidate bytes are hashed before evaluation and every check reflects a real run", { skip }, async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans });
  try {
    const result = await verifyCandidateRelease({
      config: config(fixture),
      payload: candidatePayload(fixture),
      deadline: Date.now() + 120_000,
      scope: { targetOrigin: fixture.origin, contentHash: fixture.release.contentHash },
    });
    assert.equal(result.ok, true, result.ok ? "" : `unexpected failure ${JSON.stringify(result)}`);
    if (!result.ok) return;
    const report = result.report;
    assert.equal(report.trustedLoader.enforcedBeforeEvaluation, true);
    assert.equal(report.trustedLoader.evaluatedContentHash, fixture.release.contentHash);
    assert.equal(report.observedContentHash, fixture.release.contentHash);
    assert.deepEqual([...report.registeredTools], ["create_support_ticket", "find_order"]);
    assert.equal(report.controlPlaneRequestsDuringExecution, 0);
    assert.equal(report.modelRequestsDuringExecution, 0);
    const failed = report.checks.filter((check) => check.status !== "passed");
    assert.deepEqual(failed, [], `unexpected failed checks: ${JSON.stringify(failed)}`);
    assert.equal(report.checks.length, 13);
    assert.equal(fixture.createdTickets.length, 1, "only the confirmed mutation reaches the target");
  } finally {
    await fixture.close();
  }
});

test("candidate bytes whose hash does not match are never evaluated", { skip }, async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans });
  try {
    const result = await verifyCandidateRelease({
      config: config(fixture),
      payload: { ...candidatePayload(fixture), code: `${fixture.release.code}\n// tampered\n` },
      deadline: Date.now() + 120_000,
      scope: { targetOrigin: fixture.origin, contentHash: fixture.release.contentHash },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.report.trustedLoader.evaluatedContentHash, fixture.release.contentHash);
    assert.equal(result.report.checks.every((check) => check.status === "failed"), true);
    assert.equal(result.report.checks.every((check) => check.code === "TRUSTED_LOADER_REQUIRED"), true);
    assert.equal(fixture.createdTickets.length, 0);
  } finally {
    await fixture.close();
  }
});

test("candidate verification fails closed without execution controls", async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans, start: false });
  const result = await verifyCandidateRelease({
    config: loadVerifierConfig({
      PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS: "127.0.0.1",
      PAGE2WEBMCP_RELEASE_VERIFIER_PORT: "0",
      PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "verifier-secret-token-value-1234567890",
      PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: fixture.origin,
      PAGE2WEBMCP_RELEASE_VERIFIER_ALLOW_LOOPBACK_TARGETS: "true",
      PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN: "https://control.example",
      PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS: "true",
      PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH: "",
    }),
    payload: candidatePayload(fixture),
    deadline: Date.now() + 10_000,
    scope: { targetOrigin: fixture.origin, contentHash: fixture.release.contentHash },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "RELEASE_VERIFIER_CANDIDATE_EXECUTION_CONTROLS_REQUIRED");
  await fixture.close();
});
