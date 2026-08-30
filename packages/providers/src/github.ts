import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const GITHUB_TOKEN_MAX_TTL_MS = 60 * 60 * 1_000;
const GITHUB_SNAPSHOT_MAX_FILES = 256;
const GITHUB_SNAPSHOT_MAX_FILE_BYTES = 256 * 1_024;
const GITHUB_SNAPSHOT_MAX_BYTES = 1_000_000;
const GITHUB_SNAPSHOT_MAX_DEPTH = 20;
const GITHUB_WEBHOOK_MAX_BYTES = 256 * 1_024;
const GITHUB_WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1_000;

export type GitHubRepositorySelection = Readonly<{
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  ref: string;
}>;

export type GitHubInstallationToken = Readonly<{
  token: string;
  expiresAt: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
}>;

export type GitHubTokenPort = Readonly<{
  issue(input: Readonly<{ selection: GitHubRepositorySelection; signal: AbortSignal }>): Promise<GitHubInstallationToken>;
  revoke(token: string, reason: "completed" | "failed" | "cancelled" | "expired"): Promise<void>;
}>;

export type GitHubSessionControls = Readonly<{
  clock: () => Date;
  tokens: GitHubTokenPort;
  signal?: AbortSignal;
}>;

export type GitHubAppSession = Readonly<{
  selection: GitHubRepositorySelection;
  expiresAt: string;
  authorize<T>(operation: (
    token: string,
    selection: GitHubRepositorySelection,
    signal: AbortSignal,
  ) => Promise<T>): Promise<T>;
}>;

export type GitHubSnapshotFile = Readonly<{
  path: string;
  content: string;
  byteLength: number;
  contentHash: string;
}>;

export type GitHubSourceSnapshot = Readonly<{
  version: 1;
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
  files: readonly GitHubSnapshotFile[];
  totalBytes: number;
  reference: string;
}>;

export function gitHubSourceSnapshotReference(
  snapshot: Omit<GitHubSourceSnapshot, "reference"> | GitHubSourceSnapshot,
): string {
  const identity = {
    version: snapshot.version,
    installationId: snapshot.installationId,
    repositoryId: snapshot.repositoryId,
    owner: snapshot.owner,
    repository: snapshot.repository,
    requestedRef: snapshot.requestedRef,
    commitSha: snapshot.commitSha,
    files: [...snapshot.files]
      .map(({ path, byteLength, contentHash }) => ({ path, byteLength, contentHash }))
      .sort((left, right) => compareStrings(left.path, right.path)),
    totalBytes: snapshot.totalBytes,
  };
  return `urn:sha256:${sha256(canonicalJson(identity))}`;
}

type ResolvedGitHubIdentity = Readonly<{
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
}>;

export type GitHubSnapshotPort = Readonly<{
  resolveRef(input: Readonly<{
    token: string;
    selection: GitHubRepositorySelection;
    signal: AbortSignal;
  }>): Promise<ResolvedGitHubIdentity>;
  readTree(input: Readonly<{
    token: string;
    selection: GitHubRepositorySelection;
    commitSha: string;
    signal: AbortSignal;
  }>): Promise<ResolvedGitHubIdentity & Readonly<{
    files: ReadonlyArray<Readonly<{ path: string; kind: string; content: string }>>;
  }>>;
}>;

type GitHubReconciliationIdentity = Readonly<{
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  baseCommitSha: string;
}>;

type GitHubReconciliationRequest = GitHubReconciliationIdentity & Readonly<{
  token: string;
  selection: GitHubRepositorySelection;
  branch: string;
  idempotencyKey: string;
  signal: AbortSignal;
}>;

type GitHubHeadRequest = GitHubReconciliationRequest & Readonly<{ headCommitSha: string }>;

export type GitHubDraftPullRequestPort = Readonly<{
  lookupBranch(input: GitHubReconciliationRequest): Promise<unknown | undefined>;
  createBranch(input: GitHubReconciliationRequest): Promise<unknown>;
  lookupPatch(input: GitHubReconciliationRequest): Promise<unknown | undefined>;
  applyPatch(input: GitHubReconciliationRequest & Readonly<{
    patchDigest: string;
    files: ReadonlyArray<Readonly<{ path: string; content: string; contentHash: string }>>;
  }>): Promise<unknown>;
  lookupDraftPullRequest(input: GitHubHeadRequest): Promise<unknown | undefined>;
  createDraftPullRequest(input: GitHubHeadRequest & Readonly<{ files: readonly string[] }>): Promise<unknown>;
  lookupCheck(input: GitHubHeadRequest): Promise<unknown | undefined>;
  createCheck(input: GitHubHeadRequest & Readonly<{ outputReference: string }>): Promise<unknown>;
}>;

export type GitHubDraftPullRequestInput = Readonly<{
  selection: GitHubRepositorySelection;
  baseCommitSha: string;
  patchDigest: string;
  files: ReadonlyArray<Readonly<{ path: string; content: string; contentHash: string }>>;
  checkOutputReference: string;
}>;

export type GitHubDraftPullRequestResult = Readonly<{
  branch: string;
  number: number;
  draft: true;
  merged: false;
  installed: false;
  baseCommitSha: string;
  headCommitSha: string;
  check: Readonly<{ externalId: string; status: string; conclusion?: string }>;
}>;

export type GitHubPreviewPort = Readonly<{
  lookup(input: Readonly<{
    token: string;
    selection: GitHubRepositorySelection;
    commitSha: string;
    signal: AbortSignal;
  }>): Promise<unknown | undefined>;
}>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function assertSelection(selection: GitHubRepositorySelection): void {
  if (!Number.isSafeInteger(selection.installationId) || selection.installationId <= 0
    || !Number.isSafeInteger(selection.repositoryId) || selection.repositoryId <= 0
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(selection.owner)
    || !/^[A-Za-z0-9._-]{1,100}$/.test(selection.repository)
    || !/^refs\/(?:heads|tags)\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,252})$/.test(selection.ref)
    || selection.ref.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("GITHUB_REPOSITORY_SELECTION_INVALID");
  }
}

function sameRepository(
  actual: Readonly<{ installationId: unknown; repositoryId: unknown; owner: unknown; repository: unknown }>,
  expected: GitHubRepositorySelection,
): boolean {
  return actual.installationId === expected.installationId
    && actual.repositoryId === expected.repositoryId
    && actual.owner === expected.owner
    && actual.repository === expected.repository;
}

function containsSecret(value: unknown, secret: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secret, seen));
  return Object.entries(value).some(([key, item]) => key.includes(secret) || containsSecret(item, secret, seen));
}

function abortError(signal: AbortSignal, expired: () => boolean): Error {
  if (expired()) return new Error("GITHUB_TOKEN_EXPIRED");
  const reason = signal.reason;
  return reason instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason.message)
    ? reason
    : new Error("GITHUB_SESSION_CANCELLED");
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal, expired: () => boolean): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw abortError(signal, expired);
  }
  let rejectAbort!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(abortError(signal, expired));
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function withGitHubAppSession<T>(
  selection: GitHubRepositorySelection,
  controls: GitHubSessionControls,
  action: (session: GitHubAppSession, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertSelection(selection);
  if (!controls?.tokens || typeof controls.clock !== "function") throw new Error("GITHUB_APP_CONTROLS_REQUIRED");
  const lifecycle = new AbortController();
  const abortFromParent = () => lifecycle.abort(controls.signal?.reason ?? new Error("GITHUB_SESSION_CANCELLED"));
  if (controls.signal?.aborted) abortFromParent();
  else controls.signal?.addEventListener("abort", abortFromParent, { once: true });
  let issued: GitHubInstallationToken | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let outcome: "completed" | "failed" | "cancelled" | "expired" = "failed";
  try {
    issued = await raceAbort(controls.tokens.issue({ selection, signal: lifecycle.signal }), lifecycle.signal, () => false);
    const now = controls.clock().getTime();
    const expires = new Date(issued.expiresAt).getTime();
    const ttl = expires - now;
    if (!Number.isFinite(expires) || ttl <= 0 || ttl > GITHUB_TOKEN_MAX_TTL_MS) throw new Error("GITHUB_TOKEN_TTL_INVALID");
    if (!sameRepository(issued, selection)) throw new Error("GITHUB_TOKEN_SCOPE_MISMATCH");
    if (typeof issued.token !== "string" || issued.token.length < 20 || issued.token.length > 1_024 || /\s/.test(issued.token)) {
      throw new Error("GITHUB_TOKEN_INVALID");
    }
    const expired = () => controls.clock().getTime() >= expires;
    timer = setTimeout(() => lifecycle.abort(new Error("GITHUB_TOKEN_EXPIRED")), ttl);
    timer.unref?.();
    const session: GitHubAppSession = Object.freeze({
      selection: Object.freeze({ ...selection }),
      expiresAt: issued.expiresAt,
      authorize: async <R>(operation: (token: string, selected: GitHubRepositorySelection, signal: AbortSignal) => Promise<R>) => {
        if (!active) throw new Error("GITHUB_SESSION_CLOSED");
        if (expired()) {
          lifecycle.abort(new Error("GITHUB_TOKEN_EXPIRED"));
          throw new Error("GITHUB_TOKEN_EXPIRED");
        }
        return raceAbort(operation(issued!.token, selection, lifecycle.signal), lifecycle.signal, expired);
      },
    });
    const result = await raceAbort(action(session, lifecycle.signal), lifecycle.signal, expired);
    if (containsSecret(result, issued.token)) throw new Error("GITHUB_TOKEN_PERSISTENCE_BLOCKED");
    outcome = "completed";
    return result;
  } catch (error) {
    outcome = lifecycle.signal.aborted
      ? controls.clock().getTime() >= new Date(issued?.expiresAt ?? 0).getTime() ? "expired" : "cancelled"
      : "failed";
    throw error;
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    lifecycle.abort(new Error("GITHUB_SESSION_CLOSED"));
    controls.signal?.removeEventListener("abort", abortFromParent);
    if (issued?.token) await controls.tokens.revoke(issued.token, outcome);
  }
}

function assertResolvedIdentity(
  identity: ResolvedGitHubIdentity,
  selection: GitHubRepositorySelection,
  commitSha?: string,
): void {
  if (!sameRepository(identity, selection)) throw new Error("GITHUB_REPOSITORY_IDENTITY_MISMATCH");
  if (identity.requestedRef !== selection.ref) throw new Error("GITHUB_REF_IDENTITY_MISMATCH");
  if (!/^[a-f0-9]{40}$/.test(identity.commitSha)) throw new Error("GITHUB_COMMIT_IDENTITY_INVALID");
  if (commitSha !== undefined && identity.commitSha !== commitSha) throw new Error("GITHUB_COMMIT_IDENTITY_MISMATCH");
}

function assertSnapshotPath(path: string): void {
  const parts = path.split("/");
  if (path.length === 0 || Buffer.byteLength(path, "utf8") > 512 || path.startsWith("/")
    || path.includes("\\") || /[\0-\x1f\x7f]/.test(path)
    || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("GITHUB_SNAPSHOT_PATH_INVALID");
  }
  if (parts.length > GITHUB_SNAPSHOT_MAX_DEPTH) throw new Error("GITHUB_SNAPSHOT_DEPTH_EXCEEDED");
}

export async function captureGitHubSourceSnapshot(
  session: GitHubAppSession,
  port: GitHubSnapshotPort,
): Promise<GitHubSourceSnapshot> {
  if (!port?.resolveRef || !port.readTree) throw new Error("GITHUB_SNAPSHOT_CONTROLS_REQUIRED");
  const resolved = await session.authorize((token, selection, signal) => port.resolveRef({ token, selection, signal }));
  assertResolvedIdentity(resolved, session.selection);
  const tree = await session.authorize((token, selection, signal) => port.readTree({
    token,
    selection,
    commitSha: resolved.commitSha,
    signal,
  }));
  assertResolvedIdentity(tree, session.selection, resolved.commitSha);
  if (!Array.isArray(tree.files) || tree.files.length > GITHUB_SNAPSHOT_MAX_FILES) {
    throw new Error("GITHUB_SNAPSHOT_FILE_LIMIT_EXCEEDED");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files: GitHubSnapshotFile[] = [];
  for (const file of tree.files) {
    if (!file || file.kind !== "blob" || typeof file.content !== "string") throw new Error("GITHUB_SNAPSHOT_FILE_KIND_INVALID");
    assertSnapshotPath(file.path);
    if (seen.has(file.path)) throw new Error("GITHUB_SNAPSHOT_PATH_DUPLICATE");
    seen.add(file.path);
    const byteLength = Buffer.byteLength(file.content, "utf8");
    if (byteLength > GITHUB_SNAPSHOT_MAX_FILE_BYTES) throw new Error("GITHUB_SNAPSHOT_FILE_BYTES_EXCEEDED");
    totalBytes += byteLength;
    if (totalBytes > GITHUB_SNAPSHOT_MAX_BYTES) throw new Error("GITHUB_SNAPSHOT_BYTES_EXCEEDED");
    files.push({ path: file.path, content: file.content, byteLength, contentHash: sha256(file.content) });
  }
  files.sort((left, right) => compareStrings(left.path, right.path));
  const identity = {
    version: 1 as const,
    installationId: session.selection.installationId,
    repositoryId: session.selection.repositoryId,
    owner: session.selection.owner,
    repository: session.selection.repository,
    requestedRef: session.selection.ref,
    commitSha: resolved.commitSha,
    files: files.map(({ path, byteLength, contentHash }) => ({ path, byteLength, contentHash })),
    totalBytes,
  };
  const snapshot = { ...identity, files };
  return { ...snapshot, reference: gitHubSourceSnapshotReference(snapshot) };
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function assertReconciliationIdentity(
  value: unknown,
  selection: GitHubRepositorySelection,
  baseCommitSha: string,
): Record<string, unknown> {
  const record = asRecord(value, "GITHUB_RECONCILIATION_RESPONSE_INVALID");
  if (!sameRepository(record as { installationId: unknown; repositoryId: unknown; owner: unknown; repository: unknown }, selection)) {
    throw new Error("GITHUB_REPOSITORY_IDENTITY_MISMATCH");
  }
  if (record.baseCommitSha !== baseCommitSha) throw new Error("GITHUB_COMMIT_IDENTITY_MISMATCH");
  return record;
}

function assertGeneratedPath(path: string): void {
  assertSnapshotPath(path);
  if (!/^(?:app|docs|tests)\//.test(path)) throw new Error("GITHUB_PATCH_PATH_INVALID");
}

export async function reconcileGitHubDraftPullRequest(
  session: GitHubAppSession,
  port: GitHubDraftPullRequestPort,
  input: GitHubDraftPullRequestInput,
): Promise<GitHubDraftPullRequestResult> {
  assertSelection(input.selection);
  if (canonicalJson(input.selection) !== canonicalJson(session.selection)) throw new Error("GITHUB_REPOSITORY_IDENTITY_MISMATCH");
  if (!/^[a-f0-9]{40}$/.test(input.baseCommitSha) || !/^[a-f0-9]{64}$/.test(input.patchDigest)
    || !/^urn:sha256:[a-f0-9]{64}$/.test(input.checkOutputReference)
    || input.files.length === 0 || input.files.length > 32) throw new Error("GITHUB_RECONCILIATION_INPUT_INVALID");
  if (!port?.lookupBranch || !port.createBranch || !port.lookupPatch || !port.applyPatch
    || !port.lookupDraftPullRequest || !port.createDraftPullRequest || !port.lookupCheck || !port.createCheck) {
    throw new Error("GITHUB_RECONCILIATION_CONTROLS_REQUIRED");
  }
  let generatedBytes = 0;
  for (const file of input.files) {
    assertGeneratedPath(file.path);
    if (typeof file.content !== "string" || file.contentHash !== sha256(file.content)) throw new Error("GITHUB_PATCH_CONTENT_INVALID");
    generatedBytes += Buffer.byteLength(file.content, "utf8");
    if (generatedBytes > 256 * 1_024) throw new Error("GITHUB_PATCH_BYTES_EXCEEDED");
  }
  if (new Set(input.files.map(({ path }) => path)).size !== input.files.length) throw new Error("GITHUB_PATCH_PATH_DUPLICATE");
  const rootDigest = sha256(canonicalJson({
    selection: input.selection,
    commitSha: input.baseCommitSha,
    patchDigest: input.patchDigest,
    files: input.files.map(({ path, contentHash }) => ({ path, contentHash }))
      .sort((left, right) => compareStrings(left.path, right.path)),
  }));
  const branch = `page2webmcp/${rootDigest.slice(0, 16)}`;
  const base = {
    ...input.selection,
    baseCommitSha: input.baseCommitSha,
    branch,
  };
  const reconcile = async (
    lookup: (request: GitHubReconciliationRequest) => Promise<unknown | undefined>,
    create: (request: GitHubReconciliationRequest) => Promise<unknown>,
    idempotencyKey: string,
  ) => session.authorize(async (token, selection, signal) => {
    const request = { token, selection, ...base, idempotencyKey, signal };
    return await lookup(request) ?? create(request);
  });
  const branchKey = `ghbranch_${rootDigest}`;
  const branchResult = assertReconciliationIdentity(
    await reconcile(port.lookupBranch, port.createBranch, branchKey),
    input.selection,
    input.baseCommitSha,
  );
  if (branchResult.branch !== branch || branchResult.idempotencyKey !== branchKey) throw new Error("GITHUB_BRANCH_RECONCILIATION_MISMATCH");

  const patchKey = `ghpatch_${rootDigest}`;
  const patchResult = await session.authorize(async (token, selection, signal) => {
    const request = { token, selection, ...base, idempotencyKey: patchKey, signal };
    return await port.lookupPatch(request) ?? port.applyPatch({
      ...request,
      patchDigest: input.patchDigest,
      files: [...input.files].sort((left, right) => compareStrings(left.path, right.path)),
    });
  });
  const appliedPatch = assertReconciliationIdentity(patchResult, input.selection, input.baseCommitSha);
  if (appliedPatch.branch !== branch || appliedPatch.idempotencyKey !== patchKey || appliedPatch.patchDigest !== input.patchDigest) {
    throw new Error("GITHUB_PATCH_RECONCILIATION_MISMATCH");
  }
  const headCommitSha = String(appliedPatch.headCommitSha);
  if (!/^[a-f0-9]{40}$/.test(headCommitSha) || headCommitSha === input.baseCommitSha) {
    throw new Error("GITHUB_PATCH_HEAD_INVALID");
  }

  const prKey = `ghpr_${rootDigest}`;
  const prResult = await session.authorize(async (token, selection, signal) => {
    const request = { token, selection, ...base, headCommitSha, idempotencyKey: prKey, signal };
    return await port.lookupDraftPullRequest(request) ?? port.createDraftPullRequest({
      ...request,
      files: input.files.map(({ path }) => path).sort(compareStrings),
    });
  });
  const pr = assertReconciliationIdentity(prResult, input.selection, input.baseCommitSha);
  if (pr.branch !== branch || pr.idempotencyKey !== prKey || pr.draft !== true
    || pr.headCommitSha !== headCommitSha
    || !Number.isSafeInteger(pr.number) || Number(pr.number) <= 0) throw new Error("GITHUB_DRAFT_PR_RECONCILIATION_MISMATCH");

  const checkKey = `wfx_${sha256(`${rootDigest}\0${input.checkOutputReference}`)}`;
  const checkResult = await session.authorize(async (token, selection, signal) => {
    const request = { token, selection, ...base, headCommitSha, idempotencyKey: checkKey, signal };
    return await port.lookupCheck(request) ?? port.createCheck({ ...request, outputReference: input.checkOutputReference });
  });
  const check = assertReconciliationIdentity(checkResult, input.selection, input.baseCommitSha);
  if (check.headCommitSha !== headCommitSha || check.externalId !== checkKey
    || !["queued", "in_progress", "completed"].includes(String(check.status))) {
    throw new Error("GITHUB_CHECK_RECONCILIATION_MISMATCH");
  }
  return {
    branch,
    number: Number(pr.number),
    draft: true,
    merged: false,
    installed: false,
    baseCommitSha: input.baseCommitSha,
    headCommitSha,
    check: {
      externalId: checkKey,
      status: String(check.status),
      ...(typeof check.conclusion === "string" ? { conclusion: check.conclusion } : {}),
    },
  };
}

export async function verifyGitHubPreview(
  session: GitHubAppSession,
  port: GitHubPreviewPort,
  input: Readonly<{ commitSha: string; allowedOrigin: string }>,
): Promise<Readonly<{ status: "verified"; commitSha: string; reference: string }>> {
  let allowed: URL;
  try { allowed = new URL(input.allowedOrigin); } catch { throw new Error("GITHUB_PREVIEW_ORIGIN_INVALID"); }
  if (allowed.protocol !== "https:" || allowed.origin !== input.allowedOrigin || allowed.username || allowed.password
    || !/^[a-f0-9]{40}$/.test(input.commitSha) || !port?.lookup) throw new Error("GITHUB_PREVIEW_ORIGIN_INVALID");
  const value = await session.authorize((token, selection, signal) => port.lookup({
    token,
    selection,
    commitSha: input.commitSha,
    signal,
  }));
  if (value === undefined) throw new Error("GITHUB_PREVIEW_UNAVAILABLE");
  const preview = asRecord(value, "GITHUB_PREVIEW_RESPONSE_INVALID");
  if (!sameRepository(preview as { installationId: unknown; repositoryId: unknown; owner: unknown; repository: unknown }, session.selection)
    || preview.commitSha !== input.commitSha) throw new Error("GITHUB_PREVIEW_COMMIT_MISMATCH");
  if (preview.status !== "ready" || preview.servedCommitSha !== input.commitSha) throw new Error("GITHUB_PREVIEW_COMMIT_MISMATCH");
  let url: URL;
  try { url = new URL(String(preview.url)); } catch { throw new Error("GITHUB_PREVIEW_ORIGIN_MISMATCH"); }
  if (url.protocol !== "https:" || url.origin !== allowed.origin || url.username || url.password || url.hash) {
    throw new Error("GITHUB_PREVIEW_ORIGIN_MISMATCH");
  }
  const evidence = canonicalJson({
    adapter: "github-preview-verification",
    adapterVersion: 1,
    installationId: session.selection.installationId,
    repositoryId: session.selection.repositoryId,
    commitSha: input.commitSha,
    origin: allowed.origin,
    status: "verified",
  });
  return { status: "verified", commitSha: input.commitSha, reference: `urn:sha256:${sha256(evidence)}` };
}

type GitHubWebhookExpected = Readonly<{
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  commitSha: string;
  externalId: string;
}>;

export type GitHubWebhookReplayStore = Readonly<{
  consume(deliveryId: string, expiresAt: string): Promise<boolean>;
}>;

function getRecord(value: unknown, key: string, code: string): Record<string, unknown> {
  const record = asRecord(value, code);
  return asRecord(record[key], code);
}

export async function verifyGitHubCheckWebhook(
  input: Readonly<{
    body: string;
    headers: Readonly<{ event: string; deliveryId: string; signature256: string }>;
  }>,
  controls: Readonly<{
    secret: string;
    clock: () => Date;
    replayStore: GitHubWebhookReplayStore;
    expected: GitHubWebhookExpected;
  }>,
): Promise<Readonly<{
  deliveryId: string;
  status: string;
  conclusion?: string;
  commitSha: string;
  externalId: string;
}>> {
  if (!controls?.replayStore || typeof controls.secret !== "string" || controls.secret.length < 16) {
    throw new Error("GITHUB_WEBHOOK_CONTROLS_REQUIRED");
  }
  if (Buffer.byteLength(input.body, "utf8") > GITHUB_WEBHOOK_MAX_BYTES || input.headers.event !== "check_run"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.headers.deliveryId)) {
    throw new Error("GITHUB_WEBHOOK_HEADERS_INVALID");
  }
  const supplied = /^sha256=([a-f0-9]{64})$/.exec(input.headers.signature256)?.[1];
  const expectedSignature = createHmac("sha256", controls.secret).update(input.body, "utf8").digest("hex");
  if (!supplied || !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expectedSignature, "hex"))) {
    throw new Error("GITHUB_WEBHOOK_SIGNATURE_INVALID");
  }
  let payload: unknown;
  try { payload = JSON.parse(input.body); } catch { throw new Error("GITHUB_WEBHOOK_PAYLOAD_INVALID"); }
  const installation = getRecord(payload, "installation", "GITHUB_WEBHOOK_PAYLOAD_INVALID");
  const repository = getRecord(payload, "repository", "GITHUB_WEBHOOK_PAYLOAD_INVALID");
  const check = getRecord(payload, "check_run", "GITHUB_WEBHOOK_PAYLOAD_INVALID");
  if (installation.id !== controls.expected.installationId) throw new Error("GITHUB_WEBHOOK_INSTALLATION_MISMATCH");
  if (repository.id !== controls.expected.repositoryId || repository.full_name !== controls.expected.repositoryFullName) {
    throw new Error("GITHUB_WEBHOOK_REPOSITORY_MISMATCH");
  }
  if (check.head_sha !== controls.expected.commitSha) throw new Error("GITHUB_WEBHOOK_COMMIT_MISMATCH");
  if (check.external_id !== controls.expected.externalId) throw new Error("GITHUB_WEBHOOK_CHECK_MISMATCH");
  const updatedAt = typeof check.updated_at === "string" ? new Date(check.updated_at).getTime() : Number.NaN;
  const now = controls.clock().getTime();
  if (!Number.isFinite(updatedAt) || Math.abs(now - updatedAt) > GITHUB_WEBHOOK_MAX_SKEW_MS) {
    throw new Error("GITHUB_WEBHOOK_TIMESTAMP_INVALID");
  }
  const status = String(check.status);
  if (!["queued", "in_progress", "completed"].includes(status)) throw new Error("GITHUB_WEBHOOK_CHECK_STATUS_INVALID");
  const conclusion = check.conclusion;
  if (conclusion !== null && conclusion !== undefined && !["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"].includes(String(conclusion))) {
    throw new Error("GITHUB_WEBHOOK_CHECK_STATUS_INVALID");
  }
  const replayExpiresAt = new Date(now + 24 * 60 * 60 * 1_000).toISOString();
  if (!await controls.replayStore.consume(input.headers.deliveryId, replayExpiresAt)) throw new Error("GITHUB_WEBHOOK_REPLAYED");
  return {
    deliveryId: input.headers.deliveryId,
    status,
    ...(typeof conclusion === "string" ? { conclusion } : {}),
    commitSha: controls.expected.commitSha,
    externalId: controls.expected.externalId,
  };
}
