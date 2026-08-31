import { createPrivateKey, sign } from "node:crypto";
import {
  type GitHubDraftPullRequestPort,
  type GitHubPreviewPort,
  type GitHubRepositorySelection,
  type GitHubSnapshotPort,
  type GitHubTokenPort,
} from "../../../packages/providers/src/github.ts";
import type { GitHubSandboxPort } from "../../../packages/providers/src/github-sandbox.ts";
import { createGitHubAnalysisAdapter, type AnalysisAdapter } from "./workflow.ts";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_BINDINGS_BYTES = 32 * 1_024;
const MAX_BINDINGS = 100;
const REQUEST_DEADLINE_MS = 30_000;

type RuntimeEnvironment = Record<string, string | undefined>;
type Fetch = typeof fetch;

export type ConfiguredGitHubRepository = GitHubRepositorySelection & Readonly<{
  targetOrigin: string;
}>;

export type ConfiguredGitHubAnalysis = Readonly<{
  analyze: AnalysisAdapter;
  bindings: readonly ConfiguredGitHubRepository[];
  tokens: GitHubTokenPort;
  snapshot: GitHubSnapshotPort;
  draftPullRequest: GitHubDraftPullRequestPort;
}>;

export type ConfiguredGitHubWorkflow = ConfiguredGitHubAnalysis & Readonly<{
  sandbox: GitHubSandboxPort;
  preview: GitHubPreviewPort;
}>;

type GitHubLiveDependencies = Readonly<{
  fetch: Fetch;
  clock?: () => Date;
}>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactTargetOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseBindings(value: string | undefined): ConfiguredGitHubRepository[] {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_BINDINGS_BYTES) {
    throw new Error("GITHUB_REPOSITORY_BINDINGS_REQUIRED");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("GITHUB_REPOSITORY_BINDINGS_REQUIRED"); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_BINDINGS) {
    throw new Error("GITHUB_REPOSITORY_BINDINGS_REQUIRED");
  }
  const allowedKeys = new Set(["installationId", "repositoryId", "owner", "repository", "ref", "targetOrigin"]);
  const bindings = parsed.map((item): ConfiguredGitHubRepository => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some((key) => !allowedKeys.has(key))) throw new Error("GITHUB_REPOSITORY_BINDINGS_INVALID");
    const binding = item as Record<string, unknown>;
    if (!Number.isSafeInteger(binding.installationId) || Number(binding.installationId) <= 0
      || !Number.isSafeInteger(binding.repositoryId) || Number(binding.repositoryId) <= 0
      || typeof binding.owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(binding.owner)
      || typeof binding.repository !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(binding.repository)
      || typeof binding.ref !== "string" || !/^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,252})$/.test(binding.ref)
      || binding.ref.split("/").some((part) => part === "" || part === "." || part === "..")
      || !exactTargetOrigin(binding.targetOrigin)) throw new Error("GITHUB_REPOSITORY_BINDINGS_INVALID");
    return {
      installationId: Number(binding.installationId),
      repositoryId: Number(binding.repositoryId),
      owner: binding.owner,
      repository: binding.repository,
      ref: binding.ref,
      targetOrigin: binding.targetOrigin,
    };
  }).sort((left, right) => compareStrings(`${left.owner}/${left.repository}`, `${right.owner}/${right.repository}`));
  if (new Set(bindings.map(({ owner, repository }) => `${owner}/${repository}`)).size !== bindings.length
    || new Set(bindings.map(({ repositoryId }) => repositoryId)).size !== bindings.length) {
    throw new Error("GITHUB_REPOSITORY_BINDINGS_INVALID");
  }
  return bindings;
}

export function githubConfigurationInvalidKeys(environment: RuntimeEnvironment): string[] {
  const invalid: string[] = [];
  if (!/^[1-9][0-9]{0,19}$/.test(environment.PAGE2WEBMCP_GITHUB_APP_ID ?? "")) {
    invalid.push("PAGE2WEBMCP_GITHUB_APP_ID");
  }
  const privateKeyValue = environment.PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64;
  try {
    if (!privateKeyValue || Buffer.byteLength(privateKeyValue, "utf8") > 32 * 1_024
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(privateKeyValue)) throw new Error("invalid");
    const decoded = Buffer.from(privateKeyValue, "base64");
    if (decoded.byteLength < 256 || decoded.byteLength > 16 * 1_024
      || decoded.toString("base64") !== privateKeyValue) throw new Error("invalid");
    const key = createPrivateKey(decoded);
    if (key.type !== "private" || !["rsa", "rsa-pss"].includes(key.asymmetricKeyType ?? "")) throw new Error("invalid");
  } catch { invalid.push("PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64"); }
  try { parseBindings(environment.PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS); }
  catch { invalid.push("PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS"); }
  if (!exactTargetOrigin(environment.PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN)) {
    invalid.push("PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN");
  }
  const sandboxToken = environment.PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN;
  if (!sandboxToken || sandboxToken.length < 32 || sandboxToken.length > 512) {
    invalid.push("PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN");
  }
  return invalid.sort(compareStrings);
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function appJwt(appId: string, privateKey: ReturnType<typeof createPrivateKey>, clock: () => Date): string {
  const issuedAt = Math.floor(clock().getTime() / 1_000) - 30;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

function repositoryPath(selection: GitHubRepositorySelection): string {
  return `/repos/${encodeURIComponent(selection.owner)}/${encodeURIComponent(selection.repository)}`;
}

function repositorySelection(binding: ConfiguredGitHubRepository): GitHubRepositorySelection {
  return {
    installationId: binding.installationId,
    repositoryId: binding.repositoryId,
    owner: binding.owner,
    repository: binding.repository,
    ref: binding.ref,
  };
}

function assertSelectionMatches(actual: GitHubRepositorySelection, expected: ConfiguredGitHubRepository): void {
  if (actual.installationId !== expected.installationId || actual.repositoryId !== expected.repositoryId
    || actual.owner !== expected.owner || actual.repository !== expected.repository || actual.ref !== expected.ref) {
    throw new Error("GITHUB_REPOSITORY_SELECTION_MISMATCH");
  }
}

function asRecord(value: unknown, code = "GITHUB_API_RESPONSE_INVALID"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function sha(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(code);
  return value;
}

function branchName(ref: string): string {
  return ref.slice("refs/heads/".length);
}

function linkedSignal(parent: AbortSignal): Readonly<{ signal: AbortSignal; close(): void }> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? new Error("GITHUB_REQUEST_CANCELLED"));
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("GITHUB_REQUEST_DEADLINE_EXCEEDED")), REQUEST_DEADLINE_MS);
  timer.unref?.();
  return { signal: controller.signal, close: () => { clearTimeout(timer); parent.removeEventListener("abort", abort); } };
}

function createGitHubRequest(fetcher: Fetch, appId: string, privateKey: ReturnType<typeof createPrivateKey>, clock: () => Date) {
  return async function request(
    path: string,
    input: Readonly<{
      signal: AbortSignal;
      token?: string;
      appAuthentication?: boolean;
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      expected?: readonly number[];
      allowNotFound?: boolean;
    }>,
  ): Promise<unknown | undefined> {
    if (!path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
      throw new Error("GITHUB_API_PATH_INVALID");
    }
    const url = `${GITHUB_API_ORIGIN}${path}`;
    const lifecycle = linkedSignal(input.signal);
    try {
      const authorization = input.appAuthentication ? appJwt(appId, privateKey, clock) : input.token;
      if (!authorization) throw new Error("GITHUB_API_AUTHENTICATION_REQUIRED");
      const encodedBody = input.body === undefined ? undefined : JSON.stringify(input.body);
      if (encodedBody !== undefined && Buffer.byteLength(encodedBody, "utf8") > 512 * 1_024) {
        throw new Error("GITHUB_API_REQUEST_TOO_LARGE");
      }
      const response = await fetcher(url, {
        method: input.method ?? "GET",
        redirect: "error",
        signal: lifecycle.signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${authorization}`,
          "user-agent": "page2webmcp-worker/1",
          "x-github-api-version": GITHUB_API_VERSION,
          ...(encodedBody === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
      });
      if (response.url !== url) throw new Error("GITHUB_API_ORIGIN_MISMATCH");
      if (input.allowNotFound && response.status === 404) return undefined;
      if (!(input.expected ?? [200]).includes(response.status)) throw new Error(`GITHUB_API_STATUS_${response.status}`);
      if (response.status === 204) return undefined;
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw new Error("GITHUB_API_CONTENT_TYPE_INVALID");
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new Error("GITHUB_API_RESPONSE_TOO_LARGE");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("GITHUB_API_RESPONSE_TOO_LARGE");
      try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("GITHUB_API_RESPONSE_INVALID"); }
    } finally {
      lifecycle.close();
    }
  };
}

export function createConfiguredGitHubAnalysis(
  environment: RuntimeEnvironment,
  dependencies: GitHubLiveDependencies,
): ConfiguredGitHubAnalysis {
  if (environment.PAGE2WEBMCP_PROVIDER_MODE === undefined) throw new Error("GITHUB_LIVE_CONFIGURATION_REQUIRED");
  if (environment.PAGE2WEBMCP_PROVIDER_MODE !== "github") throw new Error("GITHUB_PROVIDER_MODE_REQUIRED");
  if (!dependencies?.fetch || !/^[1-9][0-9]{0,19}$/.test(environment.PAGE2WEBMCP_GITHUB_APP_ID ?? "")
    || !environment.PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64
    || Buffer.byteLength(environment.PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64, "utf8") > 32 * 1_024) {
    throw new Error("GITHUB_LIVE_CONFIGURATION_REQUIRED");
  }
  const bindings = parseBindings(environment.PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS);
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    const decoded = Buffer.from(environment.PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64, "base64");
    if (decoded.byteLength < 256 || decoded.byteLength > 16 * 1_024
      || Buffer.from(decoded.toString("base64"), "base64").compare(decoded) !== 0) throw new Error("invalid");
    privateKey = createPrivateKey(decoded);
    if (privateKey.type !== "private" || !["rsa", "rsa-pss"].includes(privateKey.asymmetricKeyType ?? "")) throw new Error("invalid");
  } catch {
    throw new Error("GITHUB_LIVE_CONFIGURATION_REQUIRED");
  }
  const clock = dependencies.clock ?? (() => new Date());
  const appId = environment.PAGE2WEBMCP_GITHUB_APP_ID;
  if (!appId) throw new Error("GITHUB_LIVE_CONFIGURATION_REQUIRED");
  const request = createGitHubRequest(dependencies.fetch, appId, privateKey, clock);
  const byRepository = new Map(bindings.map((binding) => [`${binding.owner}/${binding.repository}`, binding]));
  const bound = (selection: GitHubRepositorySelection): ConfiguredGitHubRepository => {
    const binding = byRepository.get(`${selection.owner}/${selection.repository}`);
    if (!binding) throw new Error("GITHUB_REPOSITORY_NOT_CONFIGURED");
    assertSelectionMatches(selection, binding);
    return binding;
  };
  const tokens: GitHubTokenPort = {
    issue: async ({ selection, signal }) => {
      const binding = bound(selection);
      const value = asRecord(await request(`/app/installations/${binding.installationId}/access_tokens`, {
        appAuthentication: true,
        signal,
        method: "POST",
        expected: [201],
        body: {
          repository_ids: [binding.repositoryId],
          permissions: { checks: "write", contents: "write", deployments: "read", metadata: "read", pull_requests: "write" },
        },
      }));
      const repositories = value.repositories;
      if (!Array.isArray(repositories) || repositories.length !== 1) throw new Error("GITHUB_TOKEN_SCOPE_MISMATCH");
      const repository = asRecord(repositories[0], "GITHUB_TOKEN_SCOPE_MISMATCH");
      if (repository.id !== binding.repositoryId || repository.full_name !== `${binding.owner}/${binding.repository}`
        || typeof value.token !== "string" || typeof value.expires_at !== "string") {
        throw new Error("GITHUB_TOKEN_SCOPE_MISMATCH");
      }
      return { ...selection, token: value.token, expiresAt: value.expires_at };
    },
    revoke: async (token) => {
      await request("/installation/token", {
        token,
        signal: new AbortController().signal,
        method: "DELETE",
        expected: [204],
      });
    },
  };
  const snapshot: GitHubSnapshotPort = {
    resolveRef: async ({ token, selection, signal }) => {
      bound(selection);
      const refPath = selection.ref.slice("refs/".length).split("/").map(encodeURIComponent).join("/");
      const value = asRecord(await request(`${repositoryPath(selection)}/git/ref/${refPath}`, { token, signal }));
      const object = asRecord(value.object);
      if (value.ref !== selection.ref || object.type !== "commit" || typeof object.sha !== "string") {
        throw new Error("GITHUB_REF_RESPONSE_INVALID");
      }
      return { ...selection, requestedRef: selection.ref, commitSha: object.sha };
    },
    readTree: async ({ token, selection, commitSha, signal }) => {
      bound(selection);
      const value = asRecord(await request(`${repositoryPath(selection)}/git/trees/${commitSha}?recursive=1`, { token, signal }));
      if (value.sha !== commitSha || value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 512) {
        throw new Error("GITHUB_TREE_RESPONSE_INVALID");
      }
      const blobs: Array<Readonly<{ path: string; sha: string; size: number }>> = [];
      for (const entryValue of value.tree) {
        const entry = asRecord(entryValue, "GITHUB_TREE_RESPONSE_INVALID");
        if (entry.type === "tree") continue;
        if (entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode))
          || typeof entry.path !== "string" || !/^[a-f0-9]{40}$/.test(String(entry.sha))
          || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > 256 * 1_024) {
          throw new Error("GITHUB_TREE_RESPONSE_INVALID");
        }
        blobs.push({ path: entry.path, sha: String(entry.sha), size: Number(entry.size) });
      }
      if (blobs.length > 256) throw new Error("GITHUB_TREE_RESPONSE_INVALID");
      blobs.sort((left, right) => compareStrings(left.path, right.path));
      const files: Array<Readonly<{ path: string; kind: "blob"; content: string }>> = [];
      let totalBytes = 0;
      for (const blob of blobs) {
        totalBytes += blob.size;
        if (totalBytes > 1_000_000) throw new Error("GITHUB_TREE_RESPONSE_INVALID");
        const item = asRecord(await request(`${repositoryPath(selection)}/git/blobs/${blob.sha}`, { token, signal }));
        if (item.encoding !== "base64" || typeof item.content !== "string" || item.size !== blob.size) {
          throw new Error("GITHUB_BLOB_RESPONSE_INVALID");
        }
        const decoded = Buffer.from(item.content.replaceAll("\n", ""), "base64");
        const content = decoded.toString("utf8");
        if (decoded.byteLength !== blob.size || !Buffer.from(content, "utf8").equals(decoded)) {
          throw new Error("GITHUB_BLOB_RESPONSE_INVALID");
        }
        files.push({ path: blob.path, kind: "blob", content });
      }
      return { ...selection, requestedRef: selection.ref, commitSha, files };
    },
  };
  const draftPullRequest: GitHubDraftPullRequestPort = {
    lookupBranch: async (input) => {
      const binding = bound(input.selection);
      const path = input.branch.split("/").map(encodeURIComponent).join("/");
      const value = await request(`${repositoryPath(binding)}/git/ref/heads/${path}`, {
        token: input.token, signal: input.signal, allowNotFound: true,
      });
      if (value === undefined) return undefined;
      const ref = asRecord(value, "GITHUB_BRANCH_RESPONSE_INVALID");
      const object = asRecord(ref.object, "GITHUB_BRANCH_RESPONSE_INVALID");
      if (ref.ref !== `refs/heads/${input.branch}` || object.type !== "commit") throw new Error("GITHUB_BRANCH_RESPONSE_INVALID");
      sha(object.sha, "GITHUB_BRANCH_RESPONSE_INVALID");
      return { ...input.selection, baseCommitSha: input.baseCommitSha, branch: input.branch, idempotencyKey: input.idempotencyKey };
    },
    createBranch: async (input) => {
      const binding = bound(input.selection);
      const value = asRecord(await request(`${repositoryPath(binding)}/git/refs`, {
        token: input.token, signal: input.signal, method: "POST", expected: [201],
        body: { ref: `refs/heads/${input.branch}`, sha: input.baseCommitSha },
      }), "GITHUB_BRANCH_RESPONSE_INVALID");
      const object = asRecord(value.object, "GITHUB_BRANCH_RESPONSE_INVALID");
      if (value.ref !== `refs/heads/${input.branch}` || sha(object.sha, "GITHUB_BRANCH_RESPONSE_INVALID") !== input.baseCommitSha) {
        throw new Error("GITHUB_BRANCH_RESPONSE_INVALID");
      }
      return { ...input.selection, baseCommitSha: input.baseCommitSha, branch: input.branch, idempotencyKey: input.idempotencyKey };
    },
    lookupPatch: async (input) => {
      const binding = bound(input.selection);
      const path = input.branch.split("/").map(encodeURIComponent).join("/");
      const refValue = await request(`${repositoryPath(binding)}/git/ref/heads/${path}`, {
        token: input.token, signal: input.signal, allowNotFound: true,
      });
      if (refValue === undefined) return undefined;
      const ref = asRecord(refValue, "GITHUB_PATCH_RESPONSE_INVALID");
      const headCommitSha = sha(asRecord(ref.object, "GITHUB_PATCH_RESPONSE_INVALID").sha, "GITHUB_PATCH_RESPONSE_INVALID");
      if (headCommitSha === input.baseCommitSha) return undefined;
      const commit = asRecord(await request(`${repositoryPath(binding)}/git/commits/${headCommitSha}`, {
        token: input.token, signal: input.signal,
      }), "GITHUB_PATCH_RESPONSE_INVALID");
      const match = new RegExp(`^page2webmcp:${input.idempotencyKey}:([a-f0-9]{64})$`).exec(String(commit.message));
      const parents = commit.parents;
      if (!match || !Array.isArray(parents) || parents.length !== 1
        || asRecord(parents[0], "GITHUB_PATCH_RESPONSE_INVALID").sha !== input.baseCommitSha) return undefined;
      return { ...input.selection, baseCommitSha: input.baseCommitSha, branch: input.branch,
        idempotencyKey: input.idempotencyKey, patchDigest: match[1], headCommitSha };
    },
    applyPatch: async (input) => {
      const binding = bound(input.selection);
      const tree = [];
      for (const file of input.files) {
        const blob = asRecord(await request(`${repositoryPath(binding)}/git/blobs`, {
          token: input.token, signal: input.signal, method: "POST", expected: [201],
          body: { content: file.content, encoding: "utf-8" },
        }), "GITHUB_PATCH_RESPONSE_INVALID");
        tree.push({ path: file.path, mode: "100644", type: "blob", sha: sha(blob.sha, "GITHUB_PATCH_RESPONSE_INVALID") });
      }
      const createdTree = asRecord(await request(`${repositoryPath(binding)}/git/trees`, {
        token: input.token, signal: input.signal, method: "POST", expected: [201],
        body: { base_tree: input.baseCommitSha, tree },
      }), "GITHUB_PATCH_RESPONSE_INVALID");
      const treeSha = sha(createdTree.sha, "GITHUB_PATCH_RESPONSE_INVALID");
      const commit = asRecord(await request(`${repositoryPath(binding)}/git/commits`, {
        token: input.token, signal: input.signal, method: "POST", expected: [201],
        body: { message: `page2webmcp:${input.idempotencyKey}:${input.patchDigest}`, tree: treeSha, parents: [input.baseCommitSha] },
      }), "GITHUB_PATCH_RESPONSE_INVALID");
      const headCommitSha = sha(commit.sha, "GITHUB_PATCH_RESPONSE_INVALID");
      const updatedRef = asRecord(await request(`${repositoryPath(binding)}/git/refs/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`, {
        token: input.token, signal: input.signal, method: "PATCH",
        body: { sha: headCommitSha, force: false },
      }), "GITHUB_PATCH_RESPONSE_INVALID");
      if (updatedRef.ref !== `refs/heads/${input.branch}`
        || asRecord(updatedRef.object, "GITHUB_PATCH_RESPONSE_INVALID").sha !== headCommitSha) {
        throw new Error("GITHUB_PATCH_RESPONSE_INVALID");
      }
      return { ...input.selection, baseCommitSha: input.baseCommitSha, branch: input.branch,
        idempotencyKey: input.idempotencyKey, patchDigest: input.patchDigest, headCommitSha };
    },
    lookupDraftPullRequest: async (input) => {
      const binding = bound(input.selection);
      const query = new URLSearchParams({ state: "open", head: `${binding.owner}:${input.branch}`, base: branchName(binding.ref), per_page: "10" });
      const value = await request(`${repositoryPath(binding)}/pulls?${query}`, { token: input.token, signal: input.signal });
      if (!Array.isArray(value) || value.length > 10) throw new Error("GITHUB_DRAFT_PR_RESPONSE_INVALID");
      const matches = value.map((item) => asRecord(item, "GITHUB_DRAFT_PR_RESPONSE_INVALID")).filter((item) => {
        const head = asRecord(item.head, "GITHUB_DRAFT_PR_RESPONSE_INVALID");
        const base = asRecord(item.base, "GITHUB_DRAFT_PR_RESPONSE_INVALID");
        return head.sha === input.headCommitSha && head.ref === input.branch && base.ref === branchName(binding.ref);
      });
      if (matches.length === 0) return undefined;
      if (matches.length !== 1) throw new Error("GITHUB_DRAFT_PR_RESPONSE_INVALID");
      const item = matches[0]!;
      if (item.draft !== true || !Number.isSafeInteger(item.number) || Number(item.number) <= 0) throw new Error("GITHUB_DRAFT_PR_RESPONSE_INVALID");
      return { ...input.selection, baseCommitSha: input.baseCommitSha, branch: input.branch,
        idempotencyKey: input.idempotencyKey, headCommitSha: input.headCommitSha, number: item.number, draft: true };
    },
    createDraftPullRequest: async (input) => {
      const binding = bound(input.selection);
      const value = asRecord(await request(`${repositoryPath(binding)}/pulls`, {
        token: input.token, signal: input.signal, method: "POST", expected: [201],
        body: {
          title: "Page2WebMCP reviewed capability patch",
          head: input.branch,
          base: branchName(binding.ref),
          draft: true,
          body: `Content-addressed generated files: ${input.files.join(", ")}`,
        },
      }), "GITHUB_DRAFT_PR_RESPONSE_INVALID");
      const head = asRecord(value.head, "GITHUB_DRAFT_PR_RESPONSE_INVALID");
      const base = asRecord(value.base, "GITHUB_DRAFT_PR_RESPONSE_INVALID");
      if (value.draft !== true || head.sha !== input.headCommitSha || head.ref !== input.branch
        || base.ref !== branchName(binding.ref) || !Number.isSafeInteger(value.number) || Number(value.number) <= 0) {
        throw new Error("GITHUB_DRAFT_PR_RESPONSE_INVALID");
      }
      return { ...input.selection, baseCommitSha: input.baseCommitSha, branch: input.branch,
        idempotencyKey: input.idempotencyKey, headCommitSha: input.headCommitSha, number: value.number, draft: true };
    },
    lookupCheck: async (input) => {
      const binding = bound(input.selection);
      const value = asRecord(await request(`${repositoryPath(binding)}/commits/${input.headCommitSha}/check-runs?check_name=Page2WebMCP`, {
        token: input.token, signal: input.signal,
      }), "GITHUB_CHECK_RESPONSE_INVALID");
      if (!Array.isArray(value.check_runs) || value.check_runs.length > 100) throw new Error("GITHUB_CHECK_RESPONSE_INVALID");
      const matches = value.check_runs.map((item) => asRecord(item, "GITHUB_CHECK_RESPONSE_INVALID"))
        .filter((item) => item.external_id === input.idempotencyKey);
      if (matches.length === 0) return undefined;
      if (matches.length !== 1) throw new Error("GITHUB_CHECK_RESPONSE_INVALID");
      const check = matches[0]!;
      if (check.head_sha !== input.headCommitSha) throw new Error("GITHUB_CHECK_RESPONSE_INVALID");
      return { ...input.selection, baseCommitSha: input.baseCommitSha, headCommitSha: input.headCommitSha,
        externalId: input.idempotencyKey, status: check.status, ...(typeof check.conclusion === "string" ? { conclusion: check.conclusion } : {}) };
    },
    createCheck: async (input) => {
      const binding = bound(input.selection);
      const value = asRecord(await request(`${repositoryPath(binding)}/check-runs`, {
        token: input.token, signal: input.signal, method: "POST", expected: [201],
        body: { name: "Page2WebMCP", head_sha: input.headCommitSha, external_id: input.idempotencyKey,
          status: "completed", conclusion: "success", completed_at: clock().toISOString(),
          output: { title: "Page2WebMCP verification passed", summary: `Evidence: ${input.outputReference}` } },
      }), "GITHUB_CHECK_RESPONSE_INVALID");
      if (value.external_id !== input.idempotencyKey || value.head_sha !== input.headCommitSha
        || value.status !== "completed" || value.conclusion !== "success") {
        throw new Error("GITHUB_CHECK_RESPONSE_INVALID");
      }
      return { ...input.selection, baseCommitSha: input.baseCommitSha, headCommitSha: input.headCommitSha,
        externalId: input.idempotencyKey, status: "completed", conclusion: "success" };
    },
  };
  const installation = {
    resolve: async (input: Readonly<{ sourceUrl: string }>) => {
      let url: URL;
      try { url = new URL(input.sourceUrl); } catch { throw new Error("GITHUB_SOURCE_URL_INVALID"); }
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash || parts.length !== 2) {
        throw new Error("GITHUB_SOURCE_URL_INVALID");
      }
      const binding = byRepository.get(`${parts[0]}/${parts[1]}`);
      if (!binding) throw new Error("GITHUB_REPOSITORY_NOT_CONFIGURED");
      return repositorySelection(binding);
    },
  };
  const analyze: AnalysisAdapter = async (source, signal) => {
    if (source.sourceType !== "github") throw new Error("SOURCE_TYPE_NOT_CONFIGURED");
    const parts = new URL(source.sourceUrl).pathname.split("/").filter(Boolean);
    const binding = byRepository.get(`${parts[0]}/${parts[1]}`);
    if (!binding) throw new Error("GITHUB_REPOSITORY_NOT_CONFIGURED");
    return createGitHubAnalysisAdapter({ targetOrigin: binding.targetOrigin, clock, installation, tokens, snapshot })(source, signal);
  };
  return { analyze, bindings, tokens, snapshot, draftPullRequest };
}

export function createConfiguredGitHubWorkflow(
  environment: RuntimeEnvironment,
  dependencies: GitHubLiveDependencies,
): ConfiguredGitHubWorkflow {
  const github = createConfiguredGitHubAnalysis(environment, dependencies);
  const originValue = environment.PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN;
  const token = environment.PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN;
  if (!exactTargetOrigin(originValue) || !token || token.length < 32 || token.length > 512) {
    throw new Error("GITHUB_SANDBOX_CONFIGURATION_REQUIRED");
  }
  const sandbox: GitHubSandboxPort = {
    run: async (input) => {
      const url = `${originValue}/v1/github/verify`;
      const lifecycle = linkedSignal(input.signal);
      try {
        const response = await dependencies.fetch(url, {
          method: "POST", redirect: "error", signal: lifecycle.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ ...input, signal: undefined }),
        });
        if (response.url !== url || response.status !== 200
          || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          throw new Error("GITHUB_SANDBOX_RESPONSE_INVALID");
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("GITHUB_SANDBOX_RESPONSE_TOO_LARGE");
        try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("GITHUB_SANDBOX_RESPONSE_INVALID"); }
      } finally {
        lifecycle.close();
      }
    },
  };
  const api = (() => {
    const appId = environment.PAGE2WEBMCP_GITHUB_APP_ID;
    const privateKeyValue = environment.PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64;
    if (!appId || !privateKeyValue) throw new Error("GITHUB_LIVE_CONFIGURATION_REQUIRED");
    let key: ReturnType<typeof createPrivateKey>;
    try { key = createPrivateKey(Buffer.from(privateKeyValue, "base64")); } catch { throw new Error("GITHUB_LIVE_CONFIGURATION_REQUIRED"); }
    return createGitHubRequest(dependencies.fetch, appId, key, dependencies.clock ?? (() => new Date()));
  })();
  const preview: GitHubPreviewPort = {
    lookup: async ({ token: installationToken, selection, commitSha, signal }) => {
      const binding = github.bindings.find(({ repositoryId }) => repositoryId === selection.repositoryId);
      if (!binding || binding.owner !== selection.owner || binding.repository !== selection.repository) {
        throw new Error("GITHUB_REPOSITORY_NOT_CONFIGURED");
      }
      const deployments = await api(`${repositoryPath(binding)}/deployments?${new URLSearchParams({ sha: commitSha, per_page: "10" })}`, {
        token: installationToken, signal,
      });
      if (!Array.isArray(deployments) || deployments.length > 10) throw new Error("GITHUB_PREVIEW_RESPONSE_INVALID");
      for (const raw of deployments) {
        const deployment = asRecord(raw, "GITHUB_PREVIEW_RESPONSE_INVALID");
        if (deployment.sha !== commitSha || !Number.isSafeInteger(deployment.id)) continue;
        const statuses = await api(`${repositoryPath(binding)}/deployments/${deployment.id}/statuses?per_page=10`, {
          token: installationToken, signal,
        });
        if (!Array.isArray(statuses) || statuses.length > 10) throw new Error("GITHUB_PREVIEW_RESPONSE_INVALID");
        const ready = statuses.map((item) => asRecord(item, "GITHUB_PREVIEW_RESPONSE_INVALID"))
          .find(({ state, environment_url: url }) => state === "success" && typeof url === "string");
        if (!ready) continue;
        return { ...selection, commitSha, servedCommitSha: commitSha, status: "ready", url: ready.environment_url };
      }
      return undefined;
    },
  };
  return { ...github, sandbox, preview };
}

export function createConfiguredGitHubAnalysisAdapter(
  environment: RuntimeEnvironment,
  dependencies: GitHubLiveDependencies,
): AnalysisAdapter {
  return createConfiguredGitHubAnalysis(environment, dependencies).analyze;
}
