import assert from "node:assert/strict";
import test from "node:test";
import { runGitHubSandboxVerification } from "./github-sandbox.ts";

const limits = {
  cpuCount: 2,
  memoryBytes: 1_073_741_824,
  timeoutMs: 120_000,
  maxLogBytes: 16_384,
  network: { mode: "deny" as const, packageCacheReferences: ["cache:pnpm-lock-abc"] },
};

test("sandbox receives exact limits, no credentials, deny-by-default network, fixed steps, and bounded sanitized logs", async () => {
  const result = await runGitHubSandboxVerification({
    snapshotReference: `urn:sha256:${"a".repeat(64)}`,
    patchDigest: "b".repeat(64),
    baseCommitSha: "c".repeat(40),
    limits,
  }, {
    run: async (request) => {
      assert.deepEqual(request.environment, {});
      assert.deepEqual(request.steps, ["build", "typecheck", "test"]);
      assert.deepEqual(request.limits, limits);
      return {
        snapshotReference: request.snapshotReference,
        patchDigest: request.patchDigest,
        baseCommitSha: request.baseCommitSha,
        appliedLimits: request.limits,
        environmentKeys: [],
        networkAttempts: [],
        steps: request.steps.map((step) => ({
          step,
          exitCode: 0,
          log: `${step}: ok ghp_hidden-token-12345678901234567890 sk-live-secret-value DATABASE_URL=postgres://db-user:db-pass@db.invalid/app`,
        })),
      };
    },
  }, new AbortController().signal);
  assert.equal(result.passed, true);
  assert.match(result.reference, /^urn:sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.steps.map(({ step, exitCode }) => [step, exitCode]), [["build", 0], ["typecheck", 0], ["test", 0]]);
  assert.doesNotMatch(JSON.stringify(result), /ghp_|hidden-token|sk-live|postgres:\/\/|db-pass/i);
});

test("sandbox fails closed on credentials, weaker attestation, network, excessive output, cancellation, and failed tests", async () => {
  const input = { snapshotReference: `urn:sha256:${"a".repeat(64)}`, patchDigest: "b".repeat(64), baseCommitSha: "c".repeat(40), limits };
  const valid = {
    snapshotReference: input.snapshotReference,
    patchDigest: input.patchDigest,
    baseCommitSha: input.baseCommitSha,
    appliedLimits: limits,
    environmentKeys: [],
    networkAttempts: [],
    steps: ["build", "typecheck", "test"].map((step) => ({ step, exitCode: 0, log: "ok" })),
  };
  await assert.rejects(runGitHubSandboxVerification(input, { run: async () => ({ ...valid, environmentKeys: ["DATABASE_URL"] }) }), /GITHUB_SANDBOX_CREDENTIALS_PRESENT/);
  await assert.rejects(runGitHubSandboxVerification(input, { run: async () => ({ ...valid, appliedLimits: { ...limits, timeoutMs: limits.timeoutMs + 1 } }) }), /GITHUB_SANDBOX_ATTESTATION_MISMATCH/);
  await assert.rejects(runGitHubSandboxVerification(input, { run: async () => ({ ...valid, networkAttempts: ["https://registry.example/package"] }) }), /GITHUB_SANDBOX_NETWORK_VIOLATION/);
  await assert.rejects(runGitHubSandboxVerification(input, { run: async () => ({ ...valid, steps: [{ step: "build", exitCode: 0, log: "x".repeat(limits.maxLogBytes + 1) }] }) }), /GITHUB_SANDBOX_LOG_LIMIT_EXCEEDED/);
  const failed = await runGitHubSandboxVerification(input, { run: async () => ({ ...valid, steps: valid.steps.map((item) => item.step === "test" ? { ...item, exitCode: 1 } : item) }) });
  assert.equal(failed.passed, false);

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(runGitHubSandboxVerification(input, { run: async () => valid }, controller.signal), /GITHUB_SANDBOX_CANCELLED/);
});

test("sandbox configuration rejects unbounded or allow-network policies before provider execution", async () => {
  let called = false;
  const provider = { run: async () => { called = true; throw new Error("unexpected"); } };
  await assert.rejects(runGitHubSandboxVerification({
    snapshotReference: `urn:sha256:${"a".repeat(64)}`,
    patchDigest: "b".repeat(64),
    baseCommitSha: "c".repeat(40),
    limits: { ...limits, network: { mode: "allow" as "deny", packageCacheReferences: [] } },
  }, provider), /GITHUB_SANDBOX_POLICY_INVALID/);
  assert.equal(called, false);
});
