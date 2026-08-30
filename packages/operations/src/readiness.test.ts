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
  }), { status: "failed", code: "VERSION_DRIFT", liveSuccess: false });
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
