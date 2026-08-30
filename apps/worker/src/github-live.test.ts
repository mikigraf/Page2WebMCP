import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createConfiguredGitHubAnalysisAdapter, createConfiguredGitHubWorkflow } from "./github-live.ts";
import { reconcileGitHubDraftPullRequest, withGitHubAppSession } from "../../../packages/providers/src/github.ts";

const now = new Date("2026-08-30T12:00:00.000Z");
const commitSha = "a".repeat(40);
const repositoryId = 90210;
const sourceFiles = [
  { path: "app/api/widgets/route.ts", content: `
    import { z } from "zod";
    import { requireAccount } from "@/lib/auth";
    import { createWidget } from "@/lib/widgets";
    const inputSchema = z.object({ title: z.string().min(3).max(120) });
    const outputSchema = z.object({ id: z.string().max(64) });
    export async function POST(request: Request) {
      const account = await requireAccount(request);
      const input = inputSchema.parse(await request.json());
      return Response.json(outputSchema.parse(await createWidget(account.id, input)), { status: 201 });
    }
  ` },
  { path: "lib/auth.ts", content: "export function requireAccount(request: Request) { if (!request.headers.get('cookie')) throw new Error('AUTHENTICATION_REQUIRED'); return { id: 'account' }; }" },
  { path: "lib/widgets.ts", content: "export async function createWidget() { return { id: 'widget' }; }" },
];

function environment() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    PAGE2WEBMCP_PROVIDER_MODE: "github",
    PAGE2WEBMCP_GITHUB_APP_ID: "12345",
    PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"),
    PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS: JSON.stringify([{
      owner: "bright-tools",
      repository: "widget-console",
      repositoryId,
      installationId: 41,
      ref: "refs/heads/main",
      targetOrigin: "https://widgets.example",
    }]),
  };
}

function response(url: string, status: number, value?: unknown): Response {
  const result = new Response(value === undefined ? undefined : JSON.stringify(value), {
    status,
    headers: value === undefined ? undefined : { "content-type": "application/json" },
  });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

test("configured GitHub analysis factory fails startup closed before any claim when controls are absent", () => {
  assert.throws(() => createConfiguredGitHubAnalysisAdapter({}, { fetch }), /GITHUB_LIVE_CONFIGURATION_REQUIRED/);
  assert.throws(() => createConfiguredGitHubAnalysisAdapter({ PAGE2WEBMCP_PROVIDER_MODE: "local" }, { fetch }), /GITHUB_PROVIDER_MODE_REQUIRED/);
  assert.throws(() => createConfiguredGitHubAnalysisAdapter({
    ...environment(),
    PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS: "[]",
  }, { fetch }), /GITHUB_REPOSITORY_BINDINGS_REQUIRED/);
});

test("configured GitHub workflow requires a bounded isolated sandbox adapter", () => {
  assert.throws(() => createConfiguredGitHubWorkflow(environment(), { fetch }), /GITHUB_SANDBOX_CONFIGURATION_REQUIRED/);
  const workflow = createConfiguredGitHubWorkflow({
    ...environment(),
    PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN: "https://sandbox.example",
    PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN: "sandbox_ephemeral_control_token_abcdefghijklmnopqrstuvwxyz",
  }, { fetch });
  assert.equal(typeof workflow.sandbox.run, "function");
  assert.equal(typeof workflow.draftPullRequest.createDraftPullRequest, "function");
});

test("configured production adapter uses pinned repository-scoped GitHub REST ports and returns canonical analysis without a PR claim", async () => {
  const calls: Array<{ url: string; method: string; authorization: string; body?: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, authorization, body });
    assert.equal(init?.redirect, "error");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    if (url.endsWith("/app/installations/41/access_tokens")) {
      assert.equal(method, "POST");
      assert.match(authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      assert.deepEqual(body, {
        repository_ids: [repositoryId],
        permissions: { checks: "write", contents: "write", deployments: "read", metadata: "read", pull_requests: "write" },
      });
      return response(url, 201, {
        token: "ghs_ephemeral_live_token_abcdefghijklmnopqrstuvwxyz",
        expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
        repositories: [{ id: repositoryId, full_name: "bright-tools/widget-console" }],
      });
    }
    if (url.endsWith("/git/ref/heads/main")) {
      assert.match(authorization, /^Bearer ghs_ephemeral_live_token_/);
      return response(url, 200, { ref: "refs/heads/main", object: { type: "commit", sha: commitSha } });
    }
    if (url.endsWith(`/git/trees/${commitSha}?recursive=1`)) {
      return response(url, 200, {
        sha: commitSha,
        truncated: false,
        tree: sourceFiles.map((file, index) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: String(index + 1).repeat(40),
          size: Buffer.byteLength(file.content),
        })),
      });
    }
    const blob = /\/git\/blobs\/([1-3])\1{39}$/.exec(url);
    if (blob) {
      const content = sourceFiles[Number(blob[1]) - 1]!.content;
      return response(url, 200, { encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });
    }
    if (url.endsWith("/installation/token")) return response(url, 204);
    throw new Error(`UNEXPECTED_GITHUB_REQUEST:${method}:${url}`);
  };
  const adapter = createConfiguredGitHubAnalysisAdapter(environment(), { fetch: fakeFetch, clock: () => now });
  const result = await adapter({
    sourceType: "github",
    sourceUrl: "https://github.com/bright-tools/widget-console",
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectId: "22222222-2222-4222-8222-222222222222",
  }, new AbortController().signal);
  assert.deepEqual(result.capabilities.map(({ plan }) => plan.tool.name), ["post_api_widgets"]);
  assert.equal(result.release?.allowedOrigin, "https://widgets.example");
  assert.equal(result.draftPullRequest, undefined);
  assert.deepEqual(result.evidence.map(({ source }) => source), ["github", "source"]);
  assert.equal(calls.at(-1)?.url, "https://api.github.com/installation/token");
  assert.equal(calls.at(-1)?.method, "DELETE");
  assert.doesNotMatch(JSON.stringify(result), /ghs_|PRIVATE KEY|api\.github\.com/);
});

test("configured production GitHub ports reconcile an exact draft PR and queued check without merge or install", async () => {
  const baseCommitSha = "a".repeat(40);
  const headCommitSha = "e".repeat(40);
  const branchState = { sha: "" };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/app/installations/41/access_tokens")) return response(url, 201, {
      token: "ghs_ephemeral_live_token_abcdefghijklmnopqrstuvwxyz",
      expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
      repositories: [{ id: repositoryId, full_name: "bright-tools/widget-console" }],
    });
    if (/\/git\/ref\/heads\/page2webmcp\//.test(url) && method === "GET") {
      return branchState.sha
        ? response(url, 200, { ref: url.includes("%2F") ? "invalid" : `refs/heads/${decodeURIComponent(url.split("/heads/")[1]!)}`, object: { type: "commit", sha: branchState.sha } })
        : response(url, 404, { message: "not found" });
    }
    if (url.endsWith("/git/refs") && method === "POST") {
      branchState.sha = body.sha;
      return response(url, 201, { ref: body.ref, object: { type: "commit", sha: body.sha } });
    }
    if (url.endsWith("/git/blobs") && method === "POST") return response(url, 201, { sha: "b".repeat(40) });
    if (url.endsWith("/git/trees") && method === "POST") return response(url, 201, { sha: "c".repeat(40) });
    if (url.endsWith("/git/commits") && method === "POST") return response(url, 201, { sha: headCommitSha });
    if (/\/git\/refs\/heads\/page2webmcp\//.test(url) && method === "PATCH") {
      branchState.sha = body.sha;
      return response(url, 200, { ref: `refs/heads/${decodeURIComponent(url.split("/heads/")[1]!)}`, object: { type: "commit", sha: body.sha } });
    }
    if (url.includes("/pulls?") && method === "GET") return response(url, 200, []);
    if (url.endsWith("/pulls") && method === "POST") return response(url, 201, {
      number: 23, draft: true, head: { sha: headCommitSha, ref: body.head }, base: { ref: body.base },
    });
    if (url.includes(`/commits/${headCommitSha}/check-runs?`) && method === "GET") return response(url, 200, { check_runs: [] });
    if (url.endsWith("/check-runs") && method === "POST") return response(url, 201, {
      external_id: body.external_id, head_sha: headCommitSha, status: "completed", conclusion: "success",
    });
    if (url.endsWith("/installation/token") && method === "DELETE") return response(url, 204);
    throw new Error(`UNEXPECTED_GITHUB_REQUEST:${method}:${url}`);
  };
  const github = createConfiguredGitHubWorkflow({
    ...environment(),
    PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN: "https://sandbox.example",
    PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN: "sandbox_ephemeral_control_token_abcdefghijklmnopqrstuvwxyz",
  }, { fetch: fakeFetch, clock: () => now });
  const binding = github.bindings[0]!;
  const selection = {
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    owner: binding.owner,
    repository: binding.repository,
    ref: binding.ref,
  };
  const content = "export const registered = true;\n";
  const result = await withGitHubAppSession(selection, { clock: () => now, tokens: github.tokens }, (session) =>
    reconcileGitHubDraftPullRequest(session, github.draftPullRequest, {
      selection,
      baseCommitSha,
      patchDigest: "d".repeat(64),
      files: [{ path: "app/_page2webmcp/register.generated.mjs", content,
        contentHash: createHash("sha256").update(content).digest("hex") }],
      checkOutputReference: `urn:sha256:${"f".repeat(64)}`,
    }));
  assert.equal(result.draft, true);
  assert.equal(result.merged, false);
  assert.equal(result.installed, false);
  assert.equal(result.check.status, "completed");
  assert.equal(result.check.conclusion, "success");
});
