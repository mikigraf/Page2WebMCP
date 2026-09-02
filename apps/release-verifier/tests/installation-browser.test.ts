import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { chromiumUnavailableReason } from "../src/browser.ts";
import { loadVerifierConfig, type VerifierConfig } from "../src/config.ts";
import { verifyInstalledRelease } from "../src/installation.ts";
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
        input: { orderId: "ORD-4812", title: "TEST verifier {{marker}}" },
      },
      finalState: { toolName: "find_order", input: { query: "ORD-4812" } },
    }),
    ...overrides,
  });
}

function payloadFor(fixture: TargetFixture) {
  return {
    pageUrl: `${fixture.origin}/support`,
    artifactUrl: `${fixture.origin}/releases/${fixture.release.contentHash}.js`,
    downloadUrl: `${fixture.origin}/releases/${fixture.release.contentHash}.js`
      + `?download=page2webmcp-${fixture.release.contentHash}.js`,
    localOnly: true,
    contentHash: fixture.release.contentHash,
    integrity: fixture.release.integrity,
    manifest: fixture.release.manifest,
    targetOrigin: fixture.origin,
    expectedTools: ["create_support_ticket", "find_order"],
  };
}

test("a real Chromium load reports what the page actually served, executed, and registered", { skip }, async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans });
  try {
    const result = await verifyInstalledRelease({
      config: config(fixture),
      payload: payloadFor(fixture),
      deadline: Date.now() + 120_000,
    });
    assert.equal(result.ok, true, result.ok ? "" : `unexpected failure ${JSON.stringify(result)}`);
    if (!result.ok) return;
    const report = result.report;
    assert.equal(report.servedContentHash, fixture.release.contentHash);
    assert.equal(report.executedContentHash, fixture.release.contentHash);
    assert.equal(report.executedArtifactUrl, payloadFor(fixture).artifactUrl);
    assert.equal(report.observedArtifactUrl, payloadFor(fixture).artifactUrl);
    assert.equal(report.observedDownloadUrl, payloadFor(fixture).downloadUrl);
    assert.equal(report.observedIntegrity, fixture.release.integrity);
    assert.equal(report.observedTargetOrigin, fixture.origin);
    assert.equal(report.observedLocalOnly, true);
    assert.deepEqual([...report.registeredTools], ["create_support_ticket", "find_order"]);
    assert.equal(report.normalPageLoad, true);
    assert.equal(report.routeInterception, false);
    assert.equal(report.injectedRegistration, false);
    assert.equal(report.syntheticHarness, false);
    assert.equal(report.duplicateLoadHarmless, true);
    assert.equal(report.csp.hosted, "allowed");
    assert.equal(
      report.webMcpImplementation,
      "native",
      "Chromium exposes document.modelContext on Document.prototype to a secure context",
    );
    assert.equal(report.executionEvidence?.authenticatedRead.toolName, "find_order");
    assert.equal(report.executionEvidence?.confirmedReversibleMutation.effectCount, 1);
    assert.equal(report.executionEvidence?.confirmedReversibleMutation.confirmation, "explicit");
    assert.equal(report.executionEvidence?.authoritativeFinalState.verified, true);
    assert.equal(fixture.createdTickets.length, 1);
    assert.equal(fixture.mutationRequestCount, 1);
  } finally {
    await fixture.close();
  }
});

test("served bytes that do not match the expected hash are reported truthfully", { skip }, async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans, tamperServedBytes: true });
  try {
    const payload = payloadFor(fixture);
    const result = await verifyInstalledRelease({
      config: config(fixture),
      payload,
      deadline: Date.now() + 120_000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.report.servedContentHash, payload.contentHash);
    assert.equal(
      result.report.servedContentHash,
      createHash("sha256").update(fixture.servedBytes).digest("hex"),
    );
  } finally {
    await fixture.close();
  }
});

test("a page that installs its own WebMCP object is reported as a shim, never as native", { skip }, async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans, installCompatibilityShim: true });
  try {
    const result = await verifyInstalledRelease({
      config: config(fixture),
      payload: payloadFor(fixture),
      deadline: Date.now() + 120_000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      result.report.webMcpImplementation,
      "compatibility_shim",
      "an own property assigned by page script is not native, even when it works",
    );
  } finally {
    await fixture.close();
  }
});

test("a browser without the WebMCP feature exposes no surface, so nothing registers", { skip }, async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans });
  try {
    const result = await verifyInstalledRelease({
      config: config(fixture, { PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_BLINK_FEATURES: "" }),
      payload: payloadFor(fixture),
      deadline: Date.now() + 120_000,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.report.registeredTools], []);
    assert.equal(result.report.webMcpImplementation, "compatibility_shim");
    assert.equal(result.report.executionEvidence, null);
    assert.equal(result.report.executedContentHash, null);
  } finally {
    await fixture.close();
  }
});

test("a target origin outside the allowlist is never visited", { skip }, async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans });
  try {
    const result = await verifyInstalledRelease({
      config: config(fixture, {
        PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: "http://127.0.0.1:1",
      }),
      payload: payloadFor(fixture),
      deadline: Date.now() + 120_000,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "RELEASE_VERIFIER_TARGET_ORIGIN_FORBIDDEN");
    assert.equal(fixture.pageRequestCount, 0);
  } finally {
    await fixture.close();
  }
});

test("a non-loopback insecure origin cannot even be configured as a target", async () => {
  const fixture = await startTargetFixture({ plans: verifierFixturePlans, start: false });
  assert.throws(() => config(fixture, {
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: "http://target.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOW_LOOPBACK_TARGETS: "true",
  }), /RELEASE_VERIFIER_CONFIGURATION_INVALID: PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS/);
  const result = await verifyInstalledRelease({
    config: config(fixture),
    payload: { ...payloadFor(fixture), pageUrl: "http://target.example/support", targetOrigin: "http://target.example" },
    deadline: Date.now() + 120_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "RELEASE_VERIFIER_TARGET_ORIGIN_FORBIDDEN");
  await fixture.close();
});

test("the compiled fixture release is the exact bytes the fixture serves", async () => {
  const plans = verifierFixturePlans("http://127.0.0.1:65535");
  const release = compileWebMcpRelease(plans);
  assert.equal(createHash("sha256").update(release.code).digest("hex"), release.contentHash);
});
