import assert from "node:assert/strict";
import test from "node:test";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import {
  REQUIRED_CANDIDATE_CHECKS,
  attestReleaseCandidate,
  attestReleaseInstallation,
  configuredReleaseVerificationPort,
  type CandidateVerificationReport,
  type ReleaseVerificationPort,
} from "../src/release-verification.ts";

const release = compileWebMcpRelease(acmeCapabilityPlans("https://acme.example")
  .filter((plan) => plan.tool.name !== "get_order_status"));
const expectedTools = ["create_support_ticket", "find_order"];
const artifactUrl = `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${release.contentHash}.js`;
const downloadUrl = `${artifactUrl}?download=page2webmcp-${release.contentHash}.js`;

function installedInput(overrides: Record<string, unknown> = {}) {
  return {
    pageUrl: "https://acme.example/account",
    artifactUrl,
    downloadUrl,
    localOnly: false,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
    expectedTools,
    ...overrides,
  };
}

function report(overrides: Partial<CandidateVerificationReport> = {}): CandidateVerificationReport {
  return {
    observedContentHash: release.contentHash,
    observedIntegrity: release.integrity,
    observedReleaseId: release.manifest.releaseId,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: release.contentHash },
    controlPlaneRequestsDuringExecution: 0,
    modelRequestsDuringExecution: 0,
    checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, status: "passed" as const })),
    csp: { hosted: "allowed" },
    ...overrides,
  };
}

test("candidate verification sends and accepts only the exact reviewed bytes under a trusted loader", async () => {
  let observedCode = "";
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async (input) => {
      observedCode = input.code;
      return report();
    },
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  };
  const attestation = await attestReleaseCandidate({
    code: release.code,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
    expectedTools,
  }, port, new AbortController().signal);

  assert.equal(observedCode, release.code);
  assert.equal(attestation.browserExecution, true);
  assert.equal(attestation.noSecretLeakage, true);
  assert.equal(attestation.selectionScore, 20);
  assert.deepEqual(attestation.checks.map(({ name }) => name), [...REQUIRED_CANDIDATE_CHECKS]);
});

test("candidate verification rejects forged loader, byte, tool, request, and check-set attestations", async (context) => {
  const cases: Array<[string, Partial<CandidateVerificationReport>]> = [
    ["wrong bytes", { observedContentHash: "0".repeat(64) }],
    ["loader after evaluation", { trustedLoader: { enforcedBeforeEvaluation: false, evaluatedContentHash: release.contentHash } }],
    ["wrong tools", { registeredTools: ["find_order"] }],
    ["control-plane call", { controlPlaneRequestsDuringExecution: 1 }],
    ["missing check", { checks: report().checks.slice(1) }],
    ["duplicate check", { checks: [...report().checks, report().checks[0]!] }],
  ];
  for (const [name, overrides] of cases) {
    await context.test(name, async () => {
      const port: ReleaseVerificationPort = {
        mode: "hermetic",
        verifyCandidate: async () => report(overrides),
        verifyInstalled: async () => { throw new Error("UNUSED"); },
      };
      await assert.rejects(attestReleaseCandidate({
        code: release.code,
        contentHash: release.contentHash,
        integrity: release.integrity,
        manifest: release.manifest,
        targetOrigin: release.allowedOrigin,
        expectedTools,
      }, port, new AbortController().signal), /CANDIDATE_VERIFICATION_INVALID|WRONG_STATE/);
    });
  }
});

test("candidate verification preserves an exact typed failure while failing browser execution closed", async () => {
  const failed = report({ checks: report().checks.map((check) => check.name === "final_state"
    ? { ...check, status: "failed" as const, code: "WRONG_STATE" as const }
    : check) });
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => failed,
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  };
  const attestation = await attestReleaseCandidate({
    code: release.code,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
    expectedTools,
  }, port, new AbortController().signal);
  assert.equal(attestation.browserExecution, false);
  assert.deepEqual(attestation.checks.find(({ name }) => name === "final_state"), {
    name: "final_state", status: "failed", code: "WRONG_STATE",
  });
});

test("production verification is unavailable without exact live controls", () => {
  assert.throws(() => configuredReleaseVerificationPort({}), /RELEASE_VERIFIER_CONFIGURATION_REQUIRED/);
});

test("installed verification proves a normal unintercepted native WebMCP page loaded exact bytes", async () => {
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async (input) => ({
      observedArtifactUrl: input.artifactUrl,
      observedDownloadUrl: input.downloadUrl,
      observedLocalOnly: input.localOnly,
      observedIntegrity: input.integrity,
      executedArtifactUrl: input.artifactUrl,
      servedContentHash: input.contentHash,
      executedContentHash: input.contentHash,
      observedTargetOrigin: input.targetOrigin,
      registeredTools: [...input.expectedTools],
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: true,
      csp: { hosted: "allowed" },
    }),
  };
  const attestation = await attestReleaseInstallation(installedInput(), port, new AbortController().signal);
  assert.deepEqual(attestation, {
    status: "verified",
    delivery: "hosted",
    csp: { hosted: "allowed" },
    webMcpImplementation: "native",
    report: {
      observedArtifactUrl: artifactUrl,
      observedDownloadUrl: downloadUrl,
      observedLocalOnly: false,
      observedIntegrity: release.integrity,
      executedArtifactUrl: artifactUrl,
      servedContentHash: release.contentHash,
      executedContentHash: release.contentHash,
      observedTargetOrigin: release.allowedOrigin,
      registeredTools: expectedTools,
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: true,
      csp: { hosted: "allowed" },
    },
  });
});

test("installed verification rejects interception, injection, synthetic/shim success, wrong hashes, and harmful duplicates", async (context) => {
  const base = {
    observedArtifactUrl: artifactUrl,
    observedDownloadUrl: downloadUrl,
    observedLocalOnly: false,
    observedIntegrity: release.integrity,
    executedArtifactUrl: artifactUrl,
    servedContentHash: release.contentHash,
    executedContentHash: release.contentHash,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    webMcpImplementation: "native" as const,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    csp: { hosted: "allowed" as const },
  };
  const cases = [
    ["wrong served hash", { servedContentHash: "0".repeat(64) }],
    ["wrong executed hash", { executedContentHash: "0".repeat(64) }],
    ["wrong artifact URL", { observedArtifactUrl: `https://unrelated.example/${release.contentHash}.js` }],
    ["wrong download URL", { observedDownloadUrl: `${artifactUrl}?download=wrong.js` }],
    ["wrong locality", { observedLocalOnly: true }],
    ["wrong integrity", { observedIntegrity: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["wrong executed URL", { executedArtifactUrl: `https://unrelated.example/${release.contentHash}.js` }],
    ["route interception", { routeInterception: true }],
    ["registration injection", { injectedRegistration: true }],
    ["synthetic harness", { syntheticHarness: true }],
    ["compatibility shim", { webMcpImplementation: "compatibility_shim" as const }],
    ["harmful duplicate", { duplicateLoadHarmless: false }],
  ] as const;
  for (const [name, overrides] of cases) {
    await context.test(name, async () => {
      const port: ReleaseVerificationPort = {
        mode: name === "compatibility shim" ? "live" : "hermetic",
        verifyCandidate: async () => { throw new Error("UNUSED"); },
        verifyInstalled: async () => ({ ...base, ...overrides }),
      };
      await assert.rejects(attestReleaseInstallation(installedInput(), port, new AbortController().signal),
        /INSTALLED_VERIFICATION_INVALID|WEBMCP_NATIVE_REQUIRED/);
    });
  }
});

test("CSP blocked hosted delivery remains uninstalled and requires exact-hash self-host verification", async () => {
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async (input) => ({
      observedArtifactUrl: input.artifactUrl,
      observedDownloadUrl: input.downloadUrl,
      observedLocalOnly: input.localOnly,
      observedIntegrity: input.integrity,
      executedArtifactUrl: null,
      servedContentHash: input.contentHash,
      executedContentHash: null,
      observedTargetOrigin: input.targetOrigin,
      registeredTools: [],
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: null,
      csp: { hosted: "blocked", directive: "script-src 'self'" },
    }),
  };
  const attestation = await attestReleaseInstallation(installedInput(), port, new AbortController().signal);
  assert.deepEqual(attestation, {
    status: "pending_self_host",
    delivery: "hosted",
    csp: { hosted: "blocked", directive: "script-src 'self'" },
    webMcpImplementation: "native",
    report: {
      observedArtifactUrl: artifactUrl,
      observedDownloadUrl: downloadUrl,
      observedLocalOnly: false,
      observedIntegrity: release.integrity,
      executedArtifactUrl: null,
      servedContentHash: release.contentHash,
      executedContentHash: null,
      observedTargetOrigin: release.allowedOrigin,
      registeredTools: [],
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: null,
      csp: { hosted: "blocked", directive: "script-src 'self'" },
    },
  });

  const impossibleExecution: ReleaseVerificationPort = {
    ...port,
    verifyInstalled: async (input) => ({
      ...await port.verifyInstalled(input, new AbortController().signal),
      executedArtifactUrl: input.artifactUrl,
      executedContentHash: input.contentHash,
      registeredTools: [...input.expectedTools],
    }),
  };
  await assert.rejects(attestReleaseInstallation(installedInput(), impossibleExecution,
    new AbortController().signal), /INSTALLED_VERIFICATION_INVALID/);
});

test("local artifact verification is hermetic-only and bound to the canonical Docker identity", async () => {
  const localArtifactUrl = `http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/${release.contentHash}.js`;
  const localDownloadUrl = `${localArtifactUrl}?download=page2webmcp-${release.contentHash}.js`;
  const report = {
    observedArtifactUrl: localArtifactUrl,
    observedDownloadUrl: localDownloadUrl,
    observedLocalOnly: true,
    observedIntegrity: release.integrity,
    executedArtifactUrl: localArtifactUrl,
    servedContentHash: release.contentHash,
    executedContentHash: release.contentHash,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    webMcpImplementation: "native" as const,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    csp: { hosted: "allowed" as const },
  };
  const hermetic: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async () => report,
  };
  const localInput = installedInput({ artifactUrl: localArtifactUrl, downloadUrl: localDownloadUrl, localOnly: true });
  assert.equal((await attestReleaseInstallation(localInput, hermetic, new AbortController().signal)).status, "verified");

  const live: ReleaseVerificationPort = { ...hermetic, mode: "live" };
  await assert.rejects(attestReleaseInstallation(localInput, live, new AbortController().signal),
    /INSTALLED_VERIFICATION_INVALID/);
});

test("self-host verification preserves canonical Storage identity and separately proves the executed URL", async (context) => {
  const selfHostedUrl = `https://acme.example/assets/${release.contentHash}.js`;
  const baseReport = {
    observedArtifactUrl: artifactUrl,
    observedDownloadUrl: downloadUrl,
    observedLocalOnly: false,
    observedIntegrity: release.integrity,
    executedArtifactUrl: selfHostedUrl,
    servedContentHash: release.contentHash,
    executedContentHash: release.contentHash,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    webMcpImplementation: "native" as const,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    csp: { hosted: "blocked" as const, directive: "script-src 'self'" },
  };
  const input = installedInput({ selfHostedUrl });
  const port = (report: typeof baseReport): ReleaseVerificationPort => ({
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async () => report,
  });
  const attestation = await attestReleaseInstallation(input, port(baseReport), new AbortController().signal);
  assert.equal(attestation.delivery, "self_hosted");
  assert.equal(attestation.report.observedArtifactUrl, artifactUrl);
  assert.equal(attestation.report.executedArtifactUrl, selfHostedUrl);

  const cases = [
    ["canonical replaced by self-host", { observedArtifactUrl: selfHostedUrl }],
    ["canonical executed instead", { executedArtifactUrl: artifactUrl }],
    ["unrelated URL executed", { executedArtifactUrl: `https://acme.example/assets/${"0".repeat(64)}.js` }],
  ] as const;
  for (const [name, override] of cases) {
    await context.test(name, async () => {
      await assert.rejects(attestReleaseInstallation(input, port({ ...baseReport, ...override }),
        new AbortController().signal), /INSTALLED_VERIFICATION_INVALID/);
    });
  }
});
