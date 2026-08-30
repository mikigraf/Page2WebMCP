import { createHash } from "node:crypto";
import type {
  ClaimedWorkflowTaskRecord,
  WorkflowPhase,
  WorkflowPhaseHandler,
  WorkflowSideEffectPort,
  WorkflowSideEffectRequest,
  WorkflowSideEffectResult,
} from "../../../packages/database/src/workflow.ts";
import {
  reconcileGitHubDraftPullRequest,
  withGitHubAppSession,
  type GitHubDraftPullRequestInput,
  type GitHubDraftPullRequestPort,
  type GitHubRepositorySelection,
  type GitHubSessionControls,
} from "../../../packages/providers/src/github.ts";

const effectKinds = Object.freeze({
  preflight: "github.installation.resolve",
  explore: "github.snapshot.capture",
  propose: "github.source.analyze",
  controlled_mutation_verification: "github.patch.generate",
  compile: "github.release.compile",
  candidate_verify: "github.sandbox.verify",
  publish: "github.draft_pull_request.reconcile",
  install_verify: "github.check.reconcile",
} as const satisfies Partial<Record<WorkflowPhase, string>>);

export type GitHubWorkerPhase = keyof typeof effectKinds;

export type GitHubWorkflowOutputStore = Readonly<{
  get(input: Readonly<{
    idempotencyKey: string;
    inputHash: string;
    kind: string;
  }>): Promise<WorkflowSideEffectResult | undefined>;
  put(input: Readonly<{
    idempotencyKey: string;
    inputHash: string;
    kind: string;
    content: string;
    result: WorkflowSideEffectResult;
  }>): Promise<WorkflowSideEffectResult>;
}>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function gitHubDraftPullRequestEffectInputHash(input: GitHubDraftPullRequestInput): string {
  return sha256(canonicalJson({
    selection: input.selection,
    baseCommitSha: input.baseCommitSha,
    patchDigest: input.patchDigest,
    files: input.files.map(({ path, contentHash }) => ({ path, contentHash }))
      .sort((left, right) => compareStrings(left.path, right.path)),
    checkOutputReference: input.checkOutputReference,
  }));
}

function assertDraftEffectRequest(request: WorkflowSideEffectRequest, inputHash: string): void {
  if (request.kind !== "github.draft_pull_request.reconcile" || request.inputHash !== inputHash
    || !/^wfx_[a-f0-9]{64}$/.test(request.idempotencyKey) || request.signal.aborted) {
    throw new Error("GITHUB_WORKFLOW_EFFECT_REQUEST_INVALID");
  }
}

export function createGitHubDraftPullRequestSideEffect(configuration: Readonly<{
  selection: GitHubRepositorySelection;
  session: Omit<GitHubSessionControls, "signal">;
  provider: GitHubDraftPullRequestPort;
  input: GitHubDraftPullRequestInput;
  outputs: GitHubWorkflowOutputStore;
}>): WorkflowSideEffectPort {
  if (!configuration?.provider || !configuration.outputs || !configuration.session?.tokens
    || canonicalJson(configuration.selection) !== canonicalJson(configuration.input?.selection)) {
    throw new Error("GITHUB_WORKFLOW_EFFECT_CONTROLS_REQUIRED");
  }
  const inputHash = gitHubDraftPullRequestEffectInputHash(configuration.input);
  const lookup = async (request: WorkflowSideEffectRequest): Promise<WorkflowSideEffectResult | undefined> => {
    assertDraftEffectRequest(request, inputHash);
    return configuration.outputs.get({
      idempotencyKey: request.idempotencyKey,
      inputHash: request.inputHash,
      kind: request.kind,
    });
  };
  return {
    lookup,
    execute: async (request) => {
      assertDraftEffectRequest(request, inputHash);
      const existing = await lookup(request);
      if (existing) return existing;
      const pullRequest = await withGitHubAppSession(configuration.selection, {
        ...configuration.session,
        signal: request.signal,
      }, (session) => reconcileGitHubDraftPullRequest(session, configuration.provider, configuration.input));
      const content = canonicalJson({
        adapter: "github-draft-pull-request",
        adapterVersion: 1,
        baseCommitSha: pullRequest.baseCommitSha,
        branch: pullRequest.branch,
        check: pullRequest.check,
        draft: pullRequest.draft,
        headCommitSha: pullRequest.headCommitSha,
        installed: pullRequest.installed,
        merged: pullRequest.merged,
        number: pullRequest.number,
        patchDigest: configuration.input.patchDigest,
      });
      const outputHash = sha256(content);
      const result = { outputReference: `urn:sha256:${outputHash}`, outputHash };
      const stored = await configuration.outputs.put({
        idempotencyKey: request.idempotencyKey,
        inputHash: request.inputHash,
        kind: request.kind,
        content,
        result,
      });
      if (stored.outputReference !== result.outputReference || stored.outputHash !== result.outputHash) {
        throw new Error("GITHUB_WORKFLOW_OUTPUT_STORE_MISMATCH");
      }
      return stored;
    },
    reconcile: lookup,
    cleanup: async () => undefined,
  };
}

export function createGitHubWorkflowPhaseHandlers(configuration: Readonly<{
  inputHash(phase: GitHubWorkerPhase, task: ClaimedWorkflowTaskRecord): string;
}>): Partial<Record<WorkflowPhase, WorkflowPhaseHandler>> {
  if (!configuration || typeof configuration.inputHash !== "function") throw new Error("GITHUB_WORKFLOW_CONTROLS_REQUIRED");
  return Object.fromEntries(Object.entries(effectKinds).map(([phase, kind]) => [phase, (async (context) => {
    if (context.signal.aborted) throw new Error("WORKFLOW_CANCELLED");
    const inputHash = configuration.inputHash(phase as GitHubWorkerPhase, context.task);
    if (!/^[a-f0-9]{64}$/.test(inputHash)) throw new Error("GITHUB_WORKFLOW_INPUT_HASH_INVALID");
    const result = await context.sideEffect(kind, inputHash);
    if (context.signal.aborted) throw new Error("WORKFLOW_CANCELLED");
    return { checkpointReference: result.outputReference, outputReference: result.outputReference };
  }) satisfies WorkflowPhaseHandler]));
}
