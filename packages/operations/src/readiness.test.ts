import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PINNED_RELEASE_VERSIONS,
  checkPackageVersionDrift,
  evaluateDeploymentReadiness,
  RECOVERY_SCENARIOS,
  runRecoveryCheck,
} from "./readiness.ts";

const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));

test("promotion versions are exact and any package or provider drift fails closed", () => {
  assert.deepEqual(checkPackageVersionDrift(packageJson), []);
  assert.deepEqual(PINNED_RELEASE_VERSIONS, {
    node: "24",
    pnpm: "10.14.0",
    typescript: "5.9.2",
    next: "16.3.3",
    react: "19.2.8",
    playwright: "1.62.1",
    supabaseJs: "2.112.4",
    supabaseSsr: "0.12.5",
    browserUseApi: "v4",
    browserUseModel: "browser-use-2.0",
    githubApi: "2026-03-10",
    redocly: "2.45.0",
    compilerManifest: "3",
  });
  const drifted = structuredClone(packageJson);
  drifted.dependencies.next = "16.4.0";
  assert.deepEqual(checkPackageVersionDrift(drifted), [{ component: "next", expected: "16.3.3", actual: "16.4.0" }]);
});

test("deployment readiness distinguishes passing hermetic checks, missing live controls, and failed promotion", () => {
  assert.deepEqual(evaluateDeploymentReadiness({
    mode: "hermetic",
    versionDrift: [],
    migrationsCurrent: true,
    rlsVerified: true,
    artifactIntegrityVerified: true,
  }), { status: "passed", code: "HERMETIC_READINESS_PASSED", liveSuccess: false });
  assert.deepEqual(evaluateDeploymentReadiness({
    mode: "live",
    versionDrift: [],
    migrationsCurrent: true,
    rlsVerified: true,
    artifactIntegrityVerified: true,
    liveControlsConfigured: false,
  }), { status: "skipped", code: "LIVE_CONTROLS_REQUIRED", liveSuccess: false });
  assert.deepEqual(evaluateDeploymentReadiness({
    mode: "live",
    versionDrift: [{ component: "next", expected: "16.3.3", actual: "16.4.0" }],
    migrationsCurrent: true,
    rlsVerified: true,
    artifactIntegrityVerified: true,
    liveControlsConfigured: true,
    persistedJourneyVerified: true,
  }), { status: "failed", code: "VERSION_DRIFT", liveSuccess: false });
});

const selectedHash = "a".repeat(64);
const verifierDigest = "b".repeat(64);
const toolDigest = "c".repeat(64);
const releaseIntegrity = "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function nativeProof(overrides: Record<string, unknown> = {}) {
  return {
    selectedReleaseHash: selectedHash,
    releaseContentHash: selectedHash,
    releaseIntegrity,
    candidateObservedIntegrity: releaseIntegrity,
    installationObservedIntegrity: releaseIntegrity,
    servedContentHash: selectedHash,
    executedContentHash: selectedHash,
    trustedLoaderContentHash: selectedHash,
    releaseVerificationRunId: "11111111-1111-4111-8111-111111111111",
    candidateVerificationRunId: "11111111-1111-4111-8111-111111111111",
    candidateMode: "live" as const,
    installationMode: "live" as const,
    candidateProtocolVersion: 1,
    installationProtocolVersion: 1,
    candidateVerifierOriginDigest: verifierDigest,
    installationVerifierOriginDigest: verifierDigest,
    candidateWebMcpImplementation: "native" as const,
    installationWebMcpImplementation: "native" as const,
    providerMode: "openapi" as const,
    providerAdapter: "bounded-openapi" as const,
    providerAdapterVersion: 1,
    sourceType: "openapi" as const,
    providerFixture: false,
    sourceFixture: false,
    localOnly: false,
    targetIdentityMatches: true,
    artifactIdentityMatches: true,
    capabilityDigestMatches: true,
    expectedToolsDigest: toolDigest,
    registeredToolsDigest: toolDigest,
    expectedToolCount: 2,
    registeredToolCount: 2,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    zeroControlPlaneCalls: true,
    zeroModelCalls: true,
    trustedLoaderEnforced: true,
    candidateChecksPassed: true,
    ...overrides,
  };
}

function liveReadiness(overrides: Record<string, unknown> = {}) {
  return {
    mode: "live" as const,
    versionDrift: [],
    migrationsCurrent: true,
    rlsVerified: true,
    artifactIntegrityVerified: true,
    liveControlsConfigured: true,
    persistedJourneyVerified: true,
    selectedReleaseHash: selectedHash,
    provider: {
      mode: "openapi" as const,
      adapter: "bounded-openapi" as const,
      adapterVersion: 1,
      fixture: false,
      constructed: true,
    } as const,
    storage: {
      contentHash: selectedHash,
      integrity: releaseIntegrity,
      localOnly: false,
      publicOrigin: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    },
    verifier: {
      protocolVersion: 1,
      mode: "live" as const,
      webMcpImplementation: "native" as const,
      verifierOriginDigest: verifierDigest,
    },
    installationProof: nativeProof(),
    ...overrides,
  };
}

test("only one exact selected-hash native installation proof constructs liveSuccess", () => {
  assert.deepEqual(evaluateDeploymentReadiness(liveReadiness()), {
    status: "passed", code: "LIVE_READINESS_PASSED", liveSuccess: true,
  });

  assert.deepEqual(evaluateDeploymentReadiness(liveReadiness({ liveControlsConfigured: undefined })), {
    status: "skipped", code: "LIVE_CONTROLS_REQUIRED", liveSuccess: false,
  });

  const mutations: Array<[string, Record<string, unknown>]> = [
    ["selected hash", { installationProof: nativeProof({ selectedReleaseHash: "d".repeat(64) }) }],
    ["release hash", { installationProof: nativeProof({ releaseContentHash: "d".repeat(64) }) }],
    ["served hash", { installationProof: nativeProof({ servedContentHash: "d".repeat(64) }) }],
    ["executed hash", { installationProof: nativeProof({ executedContentHash: "d".repeat(64) }) }],
    ["trusted hash", { installationProof: nativeProof({ trustedLoaderContentHash: "d".repeat(64) }) }],
    ["release SRI", { installationProof: nativeProof({ releaseIntegrity: "sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }) }],
    ["candidate SRI", { installationProof: nativeProof({ candidateObservedIntegrity: "sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }) }],
    ["installation SRI", { installationProof: nativeProof({ installationObservedIntegrity: "sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }) }],
    ["verification binding", { installationProof: nativeProof({ candidateVerificationRunId: "22222222-2222-4222-8222-222222222222" }) }],
    ["candidate mode", { installationProof: nativeProof({ candidateMode: "hermetic" }) }],
    ["installation mode", { installationProof: nativeProof({ installationMode: "local_live" }) }],
    ["candidate protocol", { installationProof: nativeProof({ candidateProtocolVersion: 2 }) }],
    ["protocol", { installationProof: nativeProof({ installationProtocolVersion: 2 }) }],
    ["candidate verifier digest", { installationProof: nativeProof({ candidateVerifierOriginDigest: "d".repeat(64) }) }],
    ["verifier digest", { installationProof: nativeProof({ installationVerifierOriginDigest: "d".repeat(64) }) }],
    ["candidate native implementation", { installationProof: nativeProof({ candidateWebMcpImplementation: "compatibility_shim" }) }],
    ["native implementation", { installationProof: nativeProof({ installationWebMcpImplementation: "compatibility_shim" }) }],
    ["provider mode", { installationProof: nativeProof({ providerMode: "website" }) }],
    ["provider adapter", { installationProof: nativeProof({ providerAdapter: "browser-use-v4" }) }],
    ["provider adapter version", { installationProof: nativeProof({ providerAdapterVersion: 2 }) }],
    ["source mode", { installationProof: nativeProof({ sourceType: "website" }) }],
    ["fixture provider", { installationProof: nativeProof({ providerFixture: true }) }],
    ["fixture source", { installationProof: nativeProof({ sourceFixture: true }) }],
    ["local artifact", { installationProof: nativeProof({ localOnly: true }) }],
    ["target identity", { installationProof: nativeProof({ targetIdentityMatches: false }) }],
    ["artifact identity", { installationProof: nativeProof({ artifactIdentityMatches: false }) }],
    ["capability digest", { installationProof: nativeProof({ capabilityDigestMatches: false }) }],
    ["tool digest", { installationProof: nativeProof({ registeredToolsDigest: "d".repeat(64) }) }],
    ["tool count", { installationProof: nativeProof({ registeredToolCount: 1 }) }],
    ["synthetic harness", { installationProof: nativeProof({ syntheticHarness: true }) }],
    ["abnormal page load", { installationProof: nativeProof({ normalPageLoad: false }) }],
    ["interception", { installationProof: nativeProof({ routeInterception: true }) }],
    ["injection", { installationProof: nativeProof({ injectedRegistration: true }) }],
    ["duplicate load", { installationProof: nativeProof({ duplicateLoadHarmless: false }) }],
    ["control-plane call", { installationProof: nativeProof({ zeroControlPlaneCalls: false }) }],
    ["model call", { installationProof: nativeProof({ zeroModelCalls: false }) }],
    ["loader", { installationProof: nativeProof({ trustedLoaderEnforced: false }) }],
    ["checks", { installationProof: nativeProof({ candidateChecksPassed: false }) }],
  ];
  for (const [name, override] of mutations) {
    assert.deepEqual(evaluateDeploymentReadiness(liveReadiness(override)), {
      status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false,
    }, name);
  }

  const outerMutations = [
    liveReadiness({ storage: { ...liveReadiness().storage, contentHash: "d".repeat(64) } }),
    liveReadiness({ storage: { ...liveReadiness().storage, integrity: "sha384-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" } }),
    liveReadiness({ storage: { ...liveReadiness().storage, localOnly: true } }),
    liveReadiness({ storage: { ...liveReadiness().storage, publicOrigin: "https://storage.attacker.example" } }),
    liveReadiness({ verifier: { ...liveReadiness().verifier, protocolVersion: 2 } }),
    liveReadiness({ verifier: { ...liveReadiness().verifier, verifierOriginDigest: "d".repeat(64) } }),
    liveReadiness({ verifier: { ...liveReadiness().verifier, webMcpImplementation: "compatibility_shim" } }),
    liveReadiness({ provider: {
      mode: "website", adapter: "browser-use-v4", adapterVersion: 4, fixture: false, constructed: true,
    } }),
    liveReadiness({ provider: {
      mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: true, constructed: true,
    } }),
    liveReadiness({ provider: {
      mode: "openapi", adapter: "browser-use-v4", adapterVersion: 4, fixture: false, constructed: true,
    } }),
    liveReadiness({ provider: {
      mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false, constructed: false,
    } }),
  ];
  for (const input of outerMutations) {
    assert.deepEqual(evaluateDeploymentReadiness(input), {
      status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false,
    });
  }
});

test("hermetic and local-live can pass diagnostics but can never claim live success", () => {
  const common = {
    versionDrift: [], migrationsCurrent: true, rlsVerified: true, artifactIntegrityVerified: true,
    persistedJourneyVerified: true,
  };
  assert.deepEqual(evaluateDeploymentReadiness({ mode: "local-live", ...common }), {
    status: "passed", code: "LOCAL_LIVE_READINESS_PASSED", liveSuccess: false,
  });
  assert.equal(evaluateDeploymentReadiness({ ...liveReadiness(), mode: "local-live" }).liveSuccess, false);
  assert.deepEqual(evaluateDeploymentReadiness({
    mode: "local-live", ...common, persistedJourneyVerified: false,
  }), { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false });
});

test("every required recovery scenario has an executable fail-closed check", () => {
  assert.deepEqual([...RECOVERY_SCENARIOS], [
    "provider_outage",
    "stuck_workflow",
    "leaked_browser_session",
    "bad_model_parser_compiler",
    "compromised_artifact",
    "github_revocation",
    "rollback",
    "restore",
  ]);
  const passing = {
    provider_outage: { providerUnavailable: true, retryScheduled: true, duplicateSideEffect: false },
    stuck_workflow: { expiredLease: true, reconciled: true, duplicateClaim: false },
    leaked_browser_session: { terminal: true, browserSessionActive: false, reconcileAttempted: true },
    bad_model_parser_compiler: { invalidCandidate: true, promotionBlocked: true },
    compromised_artifact: { hashMismatch: true, deliveryBlocked: true, previousReleaseImmutable: true },
    github_revocation: { revoked: true, workflowStopped: true, merged: false, installed: false },
    rollback: { previousReleaseImmutable: true, pointerChanged: true, artifactMutated: false },
    restore: { restored: true, migrationsCurrent: true, rlsVerified: true, integrityVerified: true },
  } as const;
  for (const scenario of RECOVERY_SCENARIOS) {
    assert.deepEqual(runRecoveryCheck(scenario, passing[scenario]), { scenario, status: "passed", failures: [] });
  }
  assert.deepEqual(runRecoveryCheck("compromised_artifact", {
    hashMismatch: true,
    deliveryBlocked: false,
    previousReleaseImmutable: false,
  }), {
    scenario: "compromised_artifact",
    status: "failed",
    failures: ["DELIVERY_NOT_BLOCKED", "PREVIOUS_RELEASE_MUTABLE"],
  });
});
