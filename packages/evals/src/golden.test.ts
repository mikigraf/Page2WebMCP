import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseGoldenCases, runGoldenEvaluations } from "./golden.ts";

const fixtureUrl = new URL("../fixtures/golden-cases.json", import.meta.url);

test("golden matrix executes every required production and safety-negative scenario", async () => {
  const cases = parseGoldenCases(JSON.parse(await readFile(fixtureUrl, "utf8")));
  const required = [
    "website_authenticated_read", "website_confirmed_reversible_mutation", "unsupported_operation",
    "high_risk_mutation", "prompt_injection", "poisoned_output", "oas_3_0_cookie_auth",
    "oas_3_1_public_auth", "oas_3_2_oauth", "oas_server_api_key", "github_draft_pr",
    "ownership_failure", "browser_auth_failure", "crash_resume", "cancel_propagation",
    "exact_hosted_install", "exact_self_host_install", "native_webmcp",
    "hermetic_compatibility_webmcp", "live_compatibility_rejected",
  ];
  assert.equal(required.every((id) => cases.some((candidate) => candidate.id === id)), true);

  const results = runGoldenEvaluations(cases);
  assert.equal(results.length, cases.length);
  for (const [index, result] of results.entries()) {
    assert.deepEqual(
      { passed: result.passed, failures: result.failures },
      cases[index]?.expected,
      `golden case ${result.id}`,
    );
  }
  assert.equal(results.every(({ deterministic }) => deterministic), true);
});

test("model judges remain diagnostic and cannot override deterministic eligibility", async () => {
  const cases = parseGoldenCases(JSON.parse(await readFile(fixtureUrl, "utf8")));
  const candidate = cases.find(({ id }) => id === "model_judge_diagnostic_only");
  assert.ok(candidate);

  const [rejectedByJudge] = runGoldenEvaluations([candidate]);
  const [approvedByJudge] = runGoldenEvaluations([{
    ...candidate,
    facts: { ...candidate.facts, modelJudge: { verdict: "approve", score: 1 } },
  }]);
  assert.deepEqual(
    { passed: rejectedByJudge?.passed, failures: rejectedByJudge?.failures },
    { passed: approvedByJudge?.passed, failures: approvedByJudge?.failures },
  );
  assert.notDeepEqual(rejectedByJudge?.diagnostic, approvedByJudge?.diagnostic);
});

test("golden fixtures reject duplicates, unknown fields, and unbounded attacker-controlled values", () => {
  const base = {
    id: "bounded_case",
    scenario: "website",
    facts: { effect: "read" },
    expected: { passed: true, failures: [] },
  };
  assert.throws(() => parseGoldenCases([base, base]), /GOLDEN_FIXTURE_INVALID/);
  assert.throws(() => parseGoldenCases([{ ...base, unexpected: true }]), /GOLDEN_FIXTURE_INVALID/);
  assert.throws(() => parseGoldenCases([{ ...base, facts: { diagnostics: ["X".repeat(1_000)] } }]), /GOLDEN_FIXTURE_INVALID/);
});
