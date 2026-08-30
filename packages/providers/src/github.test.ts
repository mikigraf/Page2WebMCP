import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  captureGitHubSourceSnapshot,
  reconcileGitHubDraftPullRequest,
  verifyGitHubPreview,
  verifyGitHubCheckWebhook,
  withGitHubAppSession,
  type GitHubAppSession,
  type GitHubRepositorySelection,
} from "./github.ts";

const now = new Date("2026-08-30T12:00:00.000Z");
const token = "ghs_ephemeral_installation_token_abcdefghijklmnopqrstuvwxyz";
const selection: GitHubRepositorySelection = {
  installationId: 41,
  repositoryId: 90210,
  owner: "bright-tools",
  repository: "widget-console",
  ref: "refs/heads/main",
};

function sessionControls(events: string[], overrides: Record<string, unknown> = {}) {
  return {
    clock: () => now,
    tokens: {
      issue: async () => ({
        token,
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        installationId: selection.installationId,
        repositoryId: selection.repositoryId,
        owner: selection.owner,
        repository: selection.repository,
      }),
      revoke: async (_token: string, reason: string) => { events.push(`revoke:${reason}`); },
    },
    ...overrides,
  };
}

test("GitHub App token is one-hour, repository-scoped, callback-only, locally expired, and always revoked", async () => {
  const events: string[] = [];
  let capturedSession!: GitHubAppSession;
  const result = await withGitHubAppSession(selection, sessionControls(events), async (session) => {
    capturedSession = session;
    assert.deepEqual(session.selection, selection);
    assert.equal(session.expiresAt, "2026-08-30T13:00:00.000Z");
    return session.authorize(async (secret, scoped, signal) => {
      assert.equal(secret, token);
      assert.deepEqual(scoped, selection);
      assert.equal(signal.aborted, false);
      return { commit: "a".repeat(40) };
    });
  });
  assert.deepEqual(result, { commit: "a".repeat(40) });
  assert.deepEqual(events, ["revoke:completed"]);
  await assert.rejects(capturedSession.authorize(async () => true), /GITHUB_SESSION_CLOSED/);
  assert.equal(JSON.stringify(result).includes(token), false);

  await assert.rejects(withGitHubAppSession(selection, sessionControls([], {
    tokens: { issue: async () => ({ token, expiresAt: new Date(now.getTime() + 3_600_001).toISOString(), ...selection }), revoke: async () => undefined },
  }), async () => true), /GITHUB_TOKEN_TTL_INVALID/);
  await assert.rejects(withGitHubAppSession(selection, sessionControls([], {
    tokens: { issue: async () => ({ token, expiresAt: new Date(now.getTime() + 3_600_000).toISOString(), ...selection, repositoryId: 8 }), revoke: async () => undefined },
  }), async () => true), /GITHUB_TOKEN_SCOPE_MISMATCH/);
  await assert.rejects(withGitHubAppSession(selection, sessionControls([]), async () => ({ token })), /GITHUB_TOKEN_PERSISTENCE_BLOCKED/);

  let movingNow = new Date(now);
  const expiryEvents: string[] = [];
  await assert.rejects(withGitHubAppSession(selection, {
    ...sessionControls(expiryEvents),
    clock: () => movingNow,
  }, async (session) => {
    movingNow = new Date(now.getTime() + 3_600_000);
    return session.authorize(async () => true);
  }), /GITHUB_TOKEN_EXPIRED/);
  assert.deepEqual(expiryEvents, ["revoke:expired"]);
});

test("immutable snapshot validates identity at ref and tree operations and canonicalizes bounded files", async () => {
  const events: string[] = [];
  const result = await withGitHubAppSession(selection, sessionControls(events), async (session) => captureGitHubSourceSnapshot(session, {
    resolveRef: async ({ token: received, ...identity }) => {
      assert.equal(received, token);
      assert.deepEqual(identity.selection, selection);
      return { ...selection, requestedRef: selection.ref, commitSha: "a".repeat(40) };
    },
    readTree: async ({ commitSha, ...identity }) => {
      assert.equal(commitSha, "a".repeat(40));
      assert.deepEqual(identity.selection, selection);
      return {
        ...selection,
        requestedRef: selection.ref,
        commitSha,
        files: [
          { path: "lib/widget.ts", kind: "blob" as const, content: "export const widget = true;" },
          { path: "app/api/widgets/route.ts", kind: "blob" as const, content: "export function GET() {}" },
        ],
      };
    },
  }));
  assert.deepEqual(result.files.map(({ path }) => path), ["app/api/widgets/route.ts", "lib/widget.ts"]);
  assert.equal(result.commitSha, "a".repeat(40));
  assert.equal(result.files[0]?.contentHash, createHash("sha256").update("export function GET() {}").digest("hex"));
  assert.match(result.reference, /^urn:sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(events, ["revoke:completed"]);

  await assert.rejects(withGitHubAppSession(selection, sessionControls([]), async (session) => captureGitHubSourceSnapshot(session, {
    resolveRef: async () => ({ ...selection, requestedRef: selection.ref, commitSha: "a".repeat(40) }),
    readTree: async ({ commitSha }) => ({ ...selection, requestedRef: selection.ref, commitSha, files: [
      { path: "../escape.ts", kind: "blob" as const, content: "x" },
    ] }),
  })), /GITHUB_SNAPSHOT_PATH_INVALID/);
});

test("snapshot fails closed on branch drift, repository mismatch, symlinks, depth, count, and byte bounds", async () => {
  async function rejectedTree(response: object, code: RegExp) {
    await assert.rejects(withGitHubAppSession(selection, sessionControls([]), async (session) => captureGitHubSourceSnapshot(session, {
      resolveRef: async () => ({ ...selection, requestedRef: selection.ref, commitSha: "a".repeat(40) }),
      readTree: async ({ commitSha }) => ({ ...selection, requestedRef: selection.ref, commitSha, files: [], ...response }),
    })), code);
  }
  await rejectedTree({ commitSha: "b".repeat(40) }, /GITHUB_COMMIT_IDENTITY_MISMATCH/);
  await rejectedTree({ repositoryId: 7 }, /GITHUB_REPOSITORY_IDENTITY_MISMATCH/);
  await rejectedTree({ files: [{ path: "link.ts", kind: "symlink", content: "target" }] }, /GITHUB_SNAPSHOT_FILE_KIND_INVALID/);
  await rejectedTree({ files: [{ path: `${"deep/".repeat(21)}file.ts`, kind: "blob", content: "x" }] }, /GITHUB_SNAPSHOT_DEPTH_EXCEEDED/);
  await rejectedTree({ files: Array.from({ length: 257 }, (_, index) => ({ path: `src/f${index}.ts`, kind: "blob", content: "x" })) }, /GITHUB_SNAPSHOT_FILE_LIMIT_EXCEEDED/);
  await rejectedTree({ files: [{ path: "src/large.ts", kind: "blob", content: "x".repeat(262_145) }] }, /GITHUB_SNAPSHOT_FILE_BYTES_EXCEEDED/);
});

test("draft branch, pull request, and check reconcile idempotently at the immutable commit without any merge surface", async () => {
  const state = new Map<string, unknown>();
  const calls: string[] = [];
  const port = {
    lookupBranch: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`branch:${idempotencyKey}`),
    createBranch: async (input: Record<string, unknown>) => {
      calls.push("branch");
      const result = { ...selection, baseCommitSha: "a".repeat(40), branch: input.branch, idempotencyKey: input.idempotencyKey };
      state.set(`branch:${input.idempotencyKey}`, result);
      return result;
    },
    lookupPatch: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`patch:${idempotencyKey}`),
    applyPatch: async (input: Record<string, unknown>) => {
      calls.push("patch");
      const files = input.files as Array<{ path: string; content: string; contentHash: string }>;
      assert.equal(files[0]?.content, "export const installed = true;\n");
      assert.equal(files[0]?.contentHash, createHash("sha256").update(files[0]!.content).digest("hex"));
      const result = { ...selection, baseCommitSha: "a".repeat(40), headCommitSha: "e".repeat(40), branch: input.branch, patchDigest: "b".repeat(64), idempotencyKey: input.idempotencyKey };
      state.set(`patch:${input.idempotencyKey}`, result);
      return result;
    },
    lookupDraftPullRequest: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`pr:${idempotencyKey}`),
    createDraftPullRequest: async (input: Record<string, unknown>) => {
      calls.push("pr");
      assert.equal(input.headCommitSha, "e".repeat(40));
      const result = { ...selection, baseCommitSha: "a".repeat(40), headCommitSha: "e".repeat(40), branch: input.branch, number: 17, draft: true, idempotencyKey: input.idempotencyKey };
      state.set(`pr:${input.idempotencyKey}`, result);
      return result;
    },
    lookupCheck: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`check:${idempotencyKey}`),
    createCheck: async (input: Record<string, unknown>) => {
      calls.push("check");
      assert.equal(input.headCommitSha, "e".repeat(40));
      const result = { ...selection, baseCommitSha: "a".repeat(40), headCommitSha: "e".repeat(40), externalId: input.idempotencyKey, status: "completed", conclusion: "success" };
      state.set(`check:${input.idempotencyKey}`, result);
      return result;
    },
  };
  const input = {
    selection,
    baseCommitSha: "a".repeat(40),
    patchDigest: "b".repeat(64),
    files: [{
      path: "app/_page2webmcp/register.generated.mjs",
      content: "export const installed = true;\n",
      contentHash: createHash("sha256").update("export const installed = true;\n").digest("hex"),
    }],
    checkOutputReference: `urn:sha256:${"c".repeat(64)}`,
  };
  const first = await withGitHubAppSession(selection, sessionControls([]), (session) => reconcileGitHubDraftPullRequest(session, port, input));
  const second = await withGitHubAppSession(selection, sessionControls([]), (session) => reconcileGitHubDraftPullRequest(session, port, input));
  assert.deepEqual(second, first);
  assert.deepEqual(calls, ["branch", "patch", "pr", "check"]);
  assert.equal(first.baseCommitSha, "a".repeat(40));
  assert.equal(first.headCommitSha, "e".repeat(40));
  assert.equal(first.draft, true);
  assert.equal(first.merged, false);
  assert.equal(first.installed, false);
  assert.match(first.branch, /^page2webmcp\/[a-f0-9]{16}$/);
  assert.equal("merge" in port, false);
});

test("preview verification is optional, fail-closed, exact-origin, and immutable-commit bound", async () => {
  const verified = await withGitHubAppSession(selection, sessionControls([]), (session) => verifyGitHubPreview(session, {
    lookup: async () => ({
      ...selection,
      commitSha: "a".repeat(40),
      servedCommitSha: "a".repeat(40),
      status: "ready",
      url: "https://preview.widgets.example/build-a",
    }),
  }, {
    commitSha: "a".repeat(40),
    allowedOrigin: "https://preview.widgets.example",
  }));
  assert.deepEqual(verified.status, "verified");
  assert.equal(verified.commitSha, "a".repeat(40));
  assert.match(verified.reference, /^urn:sha256:[a-f0-9]{64}$/);
  assert.equal("url" in verified, false);

  await assert.rejects(withGitHubAppSession(selection, sessionControls([]), (session) => verifyGitHubPreview(session, {
    lookup: async () => undefined,
  }, { commitSha: "a".repeat(40), allowedOrigin: "https://preview.widgets.example" })), /GITHUB_PREVIEW_UNAVAILABLE/);
  await assert.rejects(withGitHubAppSession(selection, sessionControls([]), (session) => verifyGitHubPreview(session, {
    lookup: async () => ({ ...selection, commitSha: "a".repeat(40), servedCommitSha: "b".repeat(40), status: "ready", url: "https://preview.widgets.example/build-a" }),
  }, { commitSha: "a".repeat(40), allowedOrigin: "https://preview.widgets.example" })), /GITHUB_PREVIEW_COMMIT_MISMATCH/);
  await assert.rejects(withGitHubAppSession(selection, sessionControls([]), (session) => verifyGitHubPreview(session, {
    lookup: async () => ({ ...selection, commitSha: "a".repeat(40), servedCommitSha: "a".repeat(40), status: "ready", url: "https://attacker.example/build-a" }),
  }, { commitSha: "a".repeat(40), allowedOrigin: "https://preview.widgets.example" })), /GITHUB_PREVIEW_ORIGIN_MISMATCH/);
});

test("official signed check webhook is fresh, delivery-deduplicated, and bound to installation/repository/commit/check", async () => {
  const secret = "webhook-secret-never-returned";
  const body = JSON.stringify({
    installation: { id: selection.installationId },
    repository: { id: selection.repositoryId, full_name: `${selection.owner}/${selection.repository}` },
    check_run: { head_sha: "a".repeat(40), external_id: "wfx_" + "d".repeat(64), status: "completed", conclusion: "success", updated_at: now.toISOString() },
  });
  const headers = {
    event: "check_run",
    deliveryId: "11111111-1111-4111-8111-111111111111",
    signature256: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
  const deliveries = new Set<string>();
  const replayStore = { consume: async (id: string) => {
    if (deliveries.has(id)) return false;
    deliveries.add(id);
    return true;
  } };
  const expected = {
    installationId: selection.installationId,
    repositoryId: selection.repositoryId,
    repositoryFullName: `${selection.owner}/${selection.repository}`,
    commitSha: "a".repeat(40),
    externalId: "wfx_" + "d".repeat(64),
  };
  const verified = await verifyGitHubCheckWebhook({ body, headers }, { secret, clock: () => now, replayStore, expected });
  assert.deepEqual(verified, { deliveryId: headers.deliveryId, status: "completed", conclusion: "success", commitSha: "a".repeat(40), externalId: expected.externalId });
  assert.equal(JSON.stringify(verified).includes(secret), false);
  await assert.rejects(verifyGitHubCheckWebhook({ body, headers }, { secret, clock: () => now, replayStore, expected }), /GITHUB_WEBHOOK_REPLAYED/);
  await assert.rejects(verifyGitHubCheckWebhook({ body, headers: { ...headers, deliveryId: "22222222-2222-4222-8222-222222222222", signature256: "sha256=" + "0".repeat(64) } }, { secret, clock: () => now, replayStore, expected }), /GITHUB_WEBHOOK_SIGNATURE_INVALID/);

  const stale = body.replace(now.toISOString(), "2026-08-30T11:54:59.999Z");
  await assert.rejects(verifyGitHubCheckWebhook({ body: stale, headers: { ...headers, deliveryId: "33333333-3333-4333-8333-333333333333", signature256: `sha256=${createHmac("sha256", secret).update(stale).digest("hex")}` } }, { secret, clock: () => now, replayStore, expected }), /GITHUB_WEBHOOK_TIMESTAMP_INVALID/);
  const mismatch = body.replace(`"id":${selection.repositoryId}`, '"id":7');
  await assert.rejects(verifyGitHubCheckWebhook({ body: mismatch, headers: { ...headers, deliveryId: "44444444-4444-4444-8444-444444444444", signature256: `sha256=${createHmac("sha256", secret).update(mismatch).digest("hex")}` } }, { secret, clock: () => now, replayStore, expected }), /GITHUB_WEBHOOK_REPOSITORY_MISMATCH/);
});

test("local providers expose no source-control fallback", async () => {
  const local = await import("./local.ts");
  assert.equal("LocalSourceControlProvider" in local, false);
});
