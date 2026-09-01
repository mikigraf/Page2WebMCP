import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisCompletion,
  githubProjectRecovery,
  releaseInstallationState,
} from "../src/project-entry-state.ts";

test("analysis completion refuses to present diagnostics-only success as a candidate", () => {
  const completion = analysisCompletion("openapi", {
    capabilities: [],
    result: {
      diagnostics: [{
        code: "SERVER_ADAPTER_REQUIRED",
        operationKey: "GET /private",
        reason: "api_key_header",
      }],
    },
  });

  assert.equal(completion.candidateAvailable, false);
  assert.equal(completion.nextStepReady, false);
  assert.equal(completion.summary, "Analysis finished without a publishable OpenAPI candidate. Review the diagnostic below.");
  assert.deepEqual(completion.diagnostics, [{
    code: "SERVER_ADAPTER_REQUIRED",
    operationKey: "GET /private",
    reason: "api_key_header",
  }]);
});

test("analysis completion keeps a mixed safe candidate verifiable while surfacing skipped operations", () => {
  const completion = analysisCompletion("openapi", {
    capabilities: [{ riskTier: "R0", status: "proposed" }],
    result: {
      diagnostics: [{
        code: "SERVER_ADAPTER_REQUIRED",
        operationKey: "POST /admin",
        reason: "api_key_header",
      }],
      release: { contentHash: "a".repeat(64) },
    },
  });

  assert.equal(completion.nextStepReady, true);
  assert.equal(completion.summary, "OpenAPI analysis produced a candidate ready for verification. One operation was skipped; review the diagnostic below.");
});

test("analysis completion requires both a release and at least one capability", () => {
  assert.equal(analysisCompletion("website", {
    capabilities: [],
    result: { diagnostics: [], release: { contentHash: "b".repeat(64) } },
  }).candidateAvailable, false);

  assert.equal(analysisCompletion("github", {
    capabilities: [{ riskTier: "R0", status: "proposed" }],
    result: { diagnostics: [], release: { contentHash: "c".repeat(64) } },
  }).summary, "GitHub analysis produced a candidate ready for the tested draft-PR workflow.");
});

test("review readiness blocks blocked-only and unreviewed risky candidates", () => {
  const release = { contentHash: "d".repeat(64) };
  const blockedOnly = analysisCompletion("openapi", {
    capabilities: [{ riskTier: "R1", status: "blocked" }],
    result: { diagnostics: [], release },
  });
  assert.equal(blockedOnly.candidateAvailable, true);
  assert.equal(blockedOnly.nextStepReady, false);

  assert.equal(analysisCompletion("website", {
    capabilities: [
      { riskTier: "R0", status: "proposed" },
      { riskTier: "R3", status: "proposed" },
    ],
    result: { diagnostics: [], release },
  }).nextStepReady, false);

  const unreviewedGitHub = analysisCompletion("github", {
    capabilities: [{ riskTier: "R1", status: "proposed" }],
    result: { diagnostics: [], release },
  });
  assert.equal(unreviewedGitHub.nextStepReady, false);
  assert.equal(unreviewedGitHub.summary, "GitHub analysis produced a candidate. Approve every supported capability before creating a draft pull request.");

  assert.equal(analysisCompletion("github", {
    capabilities: [{ riskTier: "R1", status: "reviewed" }],
    result: { diagnostics: [], release },
  }).nextStepReady, true);
});

test("only exact live native installation evidence is presented as production verified", () => {
  assert.deepEqual(releaseInstallationState({ installed: false }), {
    productionVerified: false,
    label: "Awaiting installed-target verification",
  });
  assert.deepEqual(releaseInstallationState({
    installed: true,
    productionVerified: false,
    attestation: { status: "verified", verifierMode: "local_live", webMcpImplementation: "native" },
  }), {
    productionVerified: false,
    label: "Installation verified in local-live mode; production verification is still required",
  });
  assert.deepEqual(releaseInstallationState({
    installed: true,
    productionVerified: true,
    attestation: { status: "verified", verifierMode: "live", webMcpImplementation: "native" },
  }), {
    productionVerified: true,
    label: "Production verified",
  });
});

test("malformed or non-native installation projections fail closed", () => {
  assert.equal(releaseInstallationState({
    installed: true,
    productionVerified: true,
    attestation: { status: "verified", verifierMode: "live", webMcpImplementation: "compatibility" },
  }).productionVerified, false);
  assert.equal(releaseInstallationState({
    installed: true,
    productionVerified: true,
    attestation: { status: "failed", verifierMode: "live", webMcpImplementation: "native" },
  }).productionVerified, false);
  assert.equal(releaseInstallationState({
    installed: true,
    productionVerified: false,
    attestation: { status: "verified", verifierMode: "live", webMcpImplementation: "native" },
  }).productionVerified, false);
});

test("GitHub project recovery trusts only durable server workflow and PR state", () => {
  const active = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "running" as const,
    currentPhase: "publish" as const,
  };
  const publishPullRequest = {
    phase: "publish" as const,
    check: { status: "queued" as const },
  };
  const installedPullRequest = {
    phase: "install_verify" as const,
    check: { status: "completed" as const, conclusion: "success" },
  };
  assert.deepEqual(githubProjectRecovery(active, installedPullRequest), {
    workflowRunId: active.id,
    outcome: "tested_patch_draft_pull_request_pending",
    action: "resume",
  });
  assert.deepEqual(githubProjectRecovery(
    { ...active, status: "failed", errorCode: "SANDBOX_FAILED" },
    installedPullRequest,
  ), {
    outcome: "github_workflow_terminal_without_installation",
    action: "retry",
  });
  assert.deepEqual(githubProjectRecovery({ ...active, status: "succeeded" }, publishPullRequest), {
    outcome: "github_workflow_terminal_without_installation",
    action: "retry",
  });
  assert.deepEqual(githubProjectRecovery({ ...active, status: "succeeded" }, installedPullRequest), {
    outcome: "tested_patch_draft_pull_request_check_preview_reconciled",
    action: "complete",
  });
  assert.deepEqual(githubProjectRecovery(undefined, installedPullRequest), {
    outcome: "github_workflow_terminal_without_installation",
    action: "blocked",
  });
  assert.deepEqual(githubProjectRecovery(undefined, undefined), { action: "create" });
});
