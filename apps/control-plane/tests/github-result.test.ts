import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubDraftPullRequestRecord } from "../../../packages/database/src/control-plane.ts";
import { gitHubDraftPullRequestProjection } from "../src/github-result.ts";

test("GitHub draft PR projection exposes exact user identity without worker or installation internals", () => {
  const record: GitHubDraftPullRequestRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    workflowRunId: "44444444-4444-4444-8444-444444444444",
    taskId: "55555555-5555-4555-8555-555555555555",
    analysisRunId: "66666666-6666-4666-8666-666666666666",
    sourceSnapshotId: "77777777-7777-4777-8777-777777777777",
    projectSourceId: "88888888-8888-4888-8888-888888888888",
    phase: "install_verify",
    installationId: 41,
    repositoryId: 90210,
    owner: "bright-tools",
    repository: "widget-console",
    requestedRef: "refs/heads/main",
    baseCommitSha: "a".repeat(40),
    patchDigest: "b".repeat(64),
    branch: "page2webmcp/1234567890abcdef",
    number: 19,
    url: "https://github.com/bright-tools/widget-console/pull/19",
    headCommitSha: "c".repeat(40),
    draft: true,
    merged: false,
    check: { externalId: `wfx_${"d".repeat(64)}`, status: "completed", conclusion: "success" },
    sandboxReference: `urn:sha256:${"e".repeat(64)}`,
    previewReference: `urn:sha256:${"f".repeat(64)}`,
    sideEffectIdempotencyKey: `wfx_${"0".repeat(64)}`,
    sideEffectInputHash: "1".repeat(64),
    outputHash: "2".repeat(64),
    outputReference: `urn:sha256:${"2".repeat(64)}`,
    createdAt: "2026-09-01T12:00:00.000Z",
  };
  const projected = gitHubDraftPullRequestProjection(record);
  assert.deepEqual(projected.repository, { owner: "bright-tools", name: "widget-console" });
  assert.equal(projected.number, 19);
  assert.equal(projected.url, record.url);
  assert.equal(projected.headCommitSha, record.headCommitSha);
  assert.equal(projected.check.conclusion, "success");
  assert.doesNotMatch(JSON.stringify(projected), /installationId|repositoryId|taskId|sideEffect|outputHash|previewReference/);
});
