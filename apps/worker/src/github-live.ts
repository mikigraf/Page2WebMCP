import { createPrivateKey, randomBytes, sign } from "node:crypto";
import {
  type GitHubDraftPullRequestPort,
  type GitHubPreviewPort,
  type GitHubRepositorySelection,
  type GitHubSnapshotPort,
  type GitHubTokenPort,
} from "../../../packages/providers/src/github.ts";
import type { GitHubSandboxPort } from "../../../packages/providers/src/github-sandbox.ts";
import { createGitHubAnalysisAdapter, type AnalysisAdapter } from "./workflow.ts";
import {
  createNodePinnedJsonTransport,
  type NodePinnedJsonResponse,
  type NodePinnedJsonTransport,
} from "./node-network.ts";
import type { SelectedProviderProbeContext } from "../../../packages/operations/src/readiness.ts";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_BINDINGS_BYTES = 32 * 1_024;
const MAX_BINDINGS = 100;
const REQUEST_DEADLINE_MS = 30_000;
const MAX_READINESS_BYTES = 64 * 1_024;
const HOSTED_PUBLIC_ORIGIN =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";

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
  probe(input: GitHubProviderProbeInput): Promise<void>;
}>;

export type ConfiguredGitHubWorkflow = ConfiguredGitHubAnalysis & Readonly<{
  sandbox: GitHubSandboxPort;
  preview: GitHubPreviewPort;
}>;

type GitHubLiveDependencies = Readonly<{
  fetch: Fetch;
  clock?: () => Date;
  controlTransport?: NodePinnedJsonTransport;
}>;

type GitHubProviderProbeInput = Readonly<{
  selectedReleaseHash: string;
  publicOrigin: string;
  context: SelectedProviderProbeContext;
  signal: AbortSignal;
}>;

const REQUIRED_GITHUB_PERMISSIONS = Object.freeze({
  checks: "write",
  contents: "write",
  deployments: "read",
  metadata: "read",
  pull_requests: "write",
} as const);

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

function boundedBearerToken(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum
    && value.trim() === value && /^[\u0021-\u007e]+$/.test(value);
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
  if (!boundedBearerToken(sandboxToken, 32, 512)) {
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

function hasRequiredGitHubPermissions(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  return Object.entries(REQUIRED_GITHUB_PERMISSIONS).every(([name, access]) => permissions[name] === access);
}

function pinnedJson(
  response: NodePinnedJsonResponse,
  expectedUrl: string,
  code: string,
  maximum = MAX_READINESS_BYTES,
): Record<string, unknown> {
  const declared = response.headers["content-length"];
  if (response.url !== expectedUrl || response.status !== 200
    || response.headers["set-cookie"] !== undefined
    || response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)
    || !(response.body instanceof Uint8Array) || response.body.byteLength === 0
    || response.body.byteLength > maximum) throw new Error(code);
  try { return asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)), code); }
  catch { throw new Error(code); }
}

function branchName(ref: string): string {
  return ref.slice("refs/heads/".length);
}

function linkedSignal(parent: AbortSignal): Readonly<{
  signal: AbortSignal;
  abort(reason?: unknown): void;
  close(): void;
}> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? new Error("GITHUB_REQUEST_CANCELLED"));
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("GITHUB_REQUEST_DEADLINE_EXCEEDED")), REQUEST_DEADLINE_MS);
  timer.unref?.();
  return {
    signal: controller.signal,
    abort: (reason = new Error("GITHUB_REQUEST_CANCELLED")) => controller.abort(reason),
    close: () => { clearTimeout(timer); parent.removeEventListener("abort", abort); },
  };
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
  const revokeInstallationToken = async (token: string): Promise<void> => {
    await request("/installation/token", {
      token,
      signal: new AbortController().signal,
      method: "DELETE",
      expected: [204],
    });
  };
  const probe = async (input: GitHubProviderProbeInput): Promise<void> => {
    if (!/^[0-9a-f]{64}$/.test(input?.selectedReleaseHash ?? "")
      || input.publicOrigin !== HOSTED_PUBLIC_ORIGIN || !(input.signal instanceof AbortSignal)
      || input.context?.sourceType !== "github" || !/^[0-9a-f]{64}$/.test(input.context.sourceIdentityHash)
      || Object.keys(input.context.sourceConfiguration).length !== 1
      || input.context.sourceConfiguration.kind !== "github") {
      throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
    }
    const selected = input.context.binding;
    const configured = bindings.find((binding) => binding.repositoryId === selected.repositoryId);
    if (!configured || configured.installationId !== selected.installationId
      || configured.owner !== selected.owner || configured.repository !== selected.repository
      || configured.ref !== selected.ref || configured.targetOrigin !== selected.targetOrigin
      || input.context.sourceUrl !== `https://github.com/${selected.owner}/${selected.repository}`
      || !/^[0-9a-f]{40}$/.test(selected.commitSha)) {
      throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
    }
    let installationToken: string | undefined;
    try {
      const app = asRecord(await request("/app", {
        appAuthentication: true,
        signal: input.signal,
      }));
      if (!Number.isSafeInteger(app.id) || String(app.id) !== appId
        || typeof app.slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,99})$/.test(app.slug)
        || !hasRequiredGitHubPermissions(app.permissions)) {
        throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
      }
      const installation = asRecord(await request(`${repositoryPath(configured)}/installation`, {
        appAuthentication: true,
        signal: input.signal,
      }));
      const account = asRecord(installation.account, "GITHUB_PROVIDER_PROBE_FAILED");
      if (installation.id !== selected.installationId || String(installation.app_id) !== appId
        || installation.repository_selection !== "selected" || account.login !== selected.owner
        || !hasRequiredGitHubPermissions(installation.permissions)) {
        throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
      }
      const tokenValue = asRecord(await request(`/app/installations/${selected.installationId}/access_tokens`, {
        appAuthentication: true,
        signal: input.signal,
        method: "POST",
        expected: [201],
        body: { repository_ids: [selected.repositoryId], permissions: REQUIRED_GITHUB_PERMISSIONS },
      }));
      const repositories = tokenValue.repositories;
      if (!boundedBearerToken(tokenValue.token, 20, 4_096)) {
        throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
      }
      installationToken = tokenValue.token;
      if (!Array.isArray(repositories) || repositories.length !== 1) {
        throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
      }
      const repository = asRecord(repositories[0], "GITHUB_PROVIDER_PROBE_FAILED");
      if (repository.id !== selected.repositoryId
        || repository.full_name !== `${selected.owner}/${selected.repository}`) {
        throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
      }
      const liveRepository = asRecord(await request(repositoryPath(selected), {
        token: installationToken,
        signal: input.signal,
      }));
      if (liveRepository.id !== selected.repositoryId
        || liveRepository.full_name !== `${selected.owner}/${selected.repository}`) {
        throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
      }
      const refPath = selected.ref.slice("refs/".length).split("/").map(encodeURIComponent).join("/");
      const ref = asRecord(await request(`${repositoryPath(selected)}/git/ref/${refPath}`, {
        token: installationToken,
        signal: input.signal,
      }));
      const object = asRecord(ref.object, "GITHUB_PROVIDER_PROBE_FAILED");
      if (ref.ref !== selected.ref || object.type !== "commit" || object.sha !== selected.commitSha) {
        throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
      }
    } catch {
      throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
    } finally {
      if (installationToken) {
        try { await revokeInstallationToken(installationToken); }
        catch { throw new Error("GITHUB_PROVIDER_PROBE_FAILED"); }
      }
    }
  };
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
          permissions: REQUIRED_GITHUB_PERMISSIONS,
        },
      }));
      if (!boundedBearerToken(value.token, 20, 4_096)) throw new Error("GITHUB_TOKEN_SCOPE_MISMATCH");
      const token = value.token;
      const repositories = value.repositories;
      try {
        if (!Array.isArray(repositories) || repositories.length !== 1) throw new Error("GITHUB_TOKEN_SCOPE_MISMATCH");
        const repository = asRecord(repositories[0], "GITHUB_TOKEN_SCOPE_MISMATCH");
        if (repository.id !== binding.repositoryId || repository.full_name !== `${binding.owner}/${binding.repository}`
          || typeof value.expires_at !== "string") {
          throw new Error("GITHUB_TOKEN_SCOPE_MISMATCH");
        }
        return { ...selection, token, expiresAt: value.expires_at };
      } catch {
        try { await revokeInstallationToken(token); }
        catch { throw new Error("GITHUB_TOKEN_REVOCATION_FAILED"); }
        throw new Error("GITHUB_TOKEN_SCOPE_MISMATCH");
      }
    },
    revoke: async (token) => {
      await revokeInstallationToken(token);
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
  return { analyze, bindings, tokens, snapshot, draftPullRequest, probe };
}

export function createConfiguredGitHubWorkflow(
  environment: RuntimeEnvironment,
  dependencies: GitHubLiveDependencies,
): ConfiguredGitHubWorkflow {
  const github = createConfiguredGitHubAnalysis(environment, dependencies);
  const originValue = environment.PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN;
  const token = environment.PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN;
  if (!exactTargetOrigin(originValue) || !boundedBearerToken(token, 32, 512)) {
    throw new Error("GITHUB_SANDBOX_CONFIGURATION_REQUIRED");
  }
  const sandboxTransport = dependencies.controlTransport ?? createNodePinnedJsonTransport();
  const sandbox: GitHubSandboxPort = {
    run: async (input) => {
      const url = `${originValue}/v1/github/verify`;
      const lifecycle = linkedSignal(input.signal);
      try {
        const body = JSON.stringify({ ...input, signal: undefined });
        const response = await sandboxTransport.request({
          url,
          method: "POST",
          signal: lifecycle.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
          maxResponseBytes: MAX_RESPONSE_BYTES,
        });
        return pinnedJson(response, url, "GITHUB_SANDBOX_RESPONSE_INVALID", MAX_RESPONSE_BYTES) as
          Awaited<ReturnType<GitHubSandboxPort["run"]>>;
      } finally {
        lifecycle.close();
      }
    },
  };
  const probe = async (input: GitHubProviderProbeInput): Promise<void> => {
    if (!/^[0-9a-f]{64}$/.test(input?.selectedReleaseHash ?? "")
      || input.publicOrigin !== HOSTED_PUBLIC_ORIGIN || !(input.signal instanceof AbortSignal)) {
      throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
    }
    const nonce = randomBytes(32).toString("hex");
    const url = `${originValue}/v1/readiness`;
    const lifecycle = linkedSignal(input.signal);
    const operations = [
      async () => github.probe({ ...input, signal: lifecycle.signal }),
      async () => {
          const response = await sandboxTransport.request({
            url,
            method: "GET",
            signal: lifecycle.signal,
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
              "x-page2webmcp-readiness-nonce": nonce,
              "x-page2webmcp-release-hash": input.selectedReleaseHash,
            },
          });
          const value = pinnedJson(response, url, "GITHUB_PROVIDER_PROBE_FAILED");
          const expected = {
            protocolVersion: 1,
            status: "ready",
            readOnly: true,
            provider: "github",
            selectedReleaseHash: input.selectedReleaseHash,
            nonce,
            isolation: "ephemeral",
            network: "deny-by-default",
          };
          if (Object.keys(value).sort().join("\0") !== Object.keys(expected).sort().join("\0")
            || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) {
            throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
          }
      },
    ].map(async (operation) => {
      try { await operation(); }
      catch (error) { lifecycle.abort(error); throw error; }
    });
    try {
      const settled = await Promise.allSettled(operations);
      if (settled.some((result) => result.status === "rejected")) throw new Error("GITHUB_PROVIDER_PROBE_FAILED");
    } catch { throw new Error("GITHUB_PROVIDER_PROBE_FAILED"); }
    finally {
      lifecycle.abort(new Error("GITHUB_REQUEST_CANCELLED"));
      lifecycle.close();
    }
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
  return { ...github, sandbox, preview, probe };
}

export function createConfiguredGitHubAnalysisAdapter(
  environment: RuntimeEnvironment,
  dependencies: GitHubLiveDependencies,
): AnalysisAdapter {
  return createConfiguredGitHubAnalysis(environment, dependencies).analyze;
}
