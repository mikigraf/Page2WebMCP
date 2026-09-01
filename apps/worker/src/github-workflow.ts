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
  capabilityPlanDigest,
  type ControlPlaneRepository,
  type WorkflowExecutionMaterial,
} from "../../../packages/database/src/control-plane.ts";
import {
  captureGitHubSourceSnapshot,
  reconcileGitHubDraftPullRequest,
  verifyGitHubPreview,
  withGitHubAppSession,
  type GitHubDraftPullRequestInput,
  type GitHubDraftPullRequestPort,
  type GitHubPreviewPort,
  type GitHubRepositorySelection,
  type GitHubSessionControls,
  type GitHubSnapshotPort,
} from "../../../packages/providers/src/github.ts";
import {
  runGitHubSandboxVerification,
  type GitHubSandboxLimits,
  type GitHubSandboxPort,
} from "../../../packages/providers/src/github-sandbox.ts";
import {
  analyzeGitHubSourceSnapshot,
  generateSourceNativeChange,
} from "../../../packages/source-analyzer/src/analyze.ts";

const effectKinds = Object.freeze({
  preflight: "github.installation.resolve",
  ownership: "github.installation.verify",
  browser_auth: "github.app_authorization.verify",
  explore: "github.snapshot.capture",
  propose: "github.source.analyze",
  review_wait: "github.review.verify",
  controlled_mutation_verification: "github.patch.generate",
  compile: "github.release.compile",
  candidate_verify: "github.sandbox.verify",
  publish: "github.draft_pull_request.reconcile",
  install_verify: "github.check.reconcile",
} as const satisfies Partial<Record<WorkflowPhase, string>>);

export type GitHubWorkerPhase = keyof typeof effectKinds;

export const GITHUB_PRODUCTION_EFFECT_KINDS = Object.freeze(Object.values(effectKinds));

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

function parseRecord(value: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(code); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, unknown>;
}

function exactGitHubBinding(
  material: WorkflowExecutionMaterial,
  bindings: readonly Readonly<GitHubRepositorySelection & { targetOrigin: string }>[]
): Readonly<GitHubRepositorySelection & { targetOrigin: string }> {
  let url: URL;
  try { url = new URL(material.sourceUrl); } catch { throw new Error("GITHUB_SOURCE_URL_INVALID"); }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash || parts.length !== 2) {
    throw new Error("GITHUB_SOURCE_URL_INVALID");
  }
  const binding = bindings.find(({ owner, repository }) => owner === parts[0] && repository === parts[1]);
  if (!binding) throw new Error("GITHUB_REPOSITORY_NOT_CONFIGURED");
  return binding;
}

function sourceNativeContent(
  snapshotReference: string,
  change: ReturnType<typeof generateSourceNativeChange>,
): string {
  return JSON.stringify({
    adapter: "github-source-native-change",
    adapterVersion: 1,
    baseCommitSha: change.baseCommitSha,
    files: change.files.map(({ path, contentHash }) => ({ path, contentHash })),
    patchDigest: change.patchDigest,
    releaseContentHash: change.release.contentHash,
    snapshotReference,
  });
}

function assertReviewedMaterial(
  material: WorkflowExecutionMaterial,
  binding: Readonly<GitHubRepositorySelection & { targetOrigin: string }>,
  snapshot: Awaited<ReturnType<typeof captureGitHubSourceSnapshot>>,
) {
  if (material.sourceType !== "github" || material.capabilities.length === 0
    || material.capabilities.some(({ status, reviewedPlanDigest, planDigest }) =>
      status === "blocked" || reviewedPlanDigest !== planDigest)) throw new Error("GITHUB_REVIEW_BINDING_INVALID");
  const sourceEvidence = material.analysis.evidence.find(({ source }) => source === "github");
  const changeEvidence = material.analysis.evidence.find(({ source }) => source === "source");
  if (!sourceEvidence || !changeEvidence || sourceEvidence.reference !== `urn:sha256:${sha256(sourceEvidence.content)}`
    || changeEvidence.reference !== `urn:sha256:${sha256(changeEvidence.content)}`) {
    throw new Error("GITHUB_EVIDENCE_BINDING_INVALID");
  }
  const evidence = parseRecord(sourceEvidence.content, "GITHUB_EVIDENCE_BINDING_INVALID");
  if (evidence.adapter !== "github-nextjs-source" || evidence.adapterVersion !== 1
    || evidence.installationId !== binding.installationId || evidence.repositoryId !== binding.repositoryId
    || evidence.repository !== `${binding.owner}/${binding.repository}` || evidence.requestedRef !== binding.ref
    || evidence.commitSha !== snapshot.commitSha || evidence.snapshotReference !== snapshot.reference
    || evidence.targetOrigin !== binding.targetOrigin) throw new Error("GITHUB_EVIDENCE_BINDING_INVALID");
  const analysis = analyzeGitHubSourceSnapshot(snapshot, { targetOrigin: binding.targetOrigin });
  if (analysis.evidence.reference !== sourceEvidence.reference || analysis.evidence.content !== sourceEvidence.content) {
    throw new Error("GITHUB_SOURCE_ANALYSIS_DRIFT");
  }
  const change = generateSourceNativeChange(snapshot, analysis);
  if (sourceNativeContent(snapshot.reference, change) !== changeEvidence.content
    || material.analysis.release?.contentHash !== change.release.contentHash
    || material.analysis.release?.code !== change.release.code
    || material.analysis.release?.allowedOrigin !== change.release.allowedOrigin
    || canonicalJson(material.analysis.release?.manifest) !== canonicalJson(change.release.manifest)) {
    throw new Error("GITHUB_SOURCE_CHANGE_DRIFT");
  }
  const reviewed = material.capabilities.map(({ plan }) => capabilityPlanDigest(plan)).sort(compareStrings);
  const regenerated = change.release.manifest.plans.map(capabilityPlanDigest).sort(compareStrings);
  if (canonicalJson(reviewed) !== canonicalJson(regenerated)) throw new Error("GITHUB_REVIEW_BINDING_INVALID");
  return change;
}

const defaultSandboxLimits: GitHubSandboxLimits = Object.freeze({
  cpuCount: 2,
  memoryBytes: 1_024 * 1_024 * 1_024,
  timeoutMs: 5 * 60_000,
  maxLogBytes: 64 * 1_024,
  network: Object.freeze({ mode: "deny", packageCacheReferences: Object.freeze([]) }),
});

/**
 * Production Task 5 side-effect port. Every operation reloads the exact
 * reviewed analysis under the live worker lease and re-derives the candidate
 * from the immutable commit before any sandbox or GitHub mutation is allowed.
 */
export function createGitHubProductionWorkflowSideEffect(configuration: Readonly<{
  repository: Pick<ControlPlaneRepository,
    "getWorkflowExecutionMaterial" | "getGitHubDraftPullRequestForTask" | "saveGitHubDraftPullRequest">;
  bindings: readonly Readonly<GitHubRepositorySelection & { targetOrigin: string }>[];
  clock: () => Date;
  tokens: GitHubSessionControls["tokens"];
  snapshot: GitHubSnapshotPort;
  sandbox: GitHubSandboxPort;
  draftPullRequest: GitHubDraftPullRequestPort;
  preview?: GitHubPreviewPort;
  sandboxLimits?: GitHubSandboxLimits;
}>): WorkflowSideEffectPort {
  if (!configuration?.repository?.getWorkflowExecutionMaterial
    || !configuration.repository.getGitHubDraftPullRequestForTask
    || !configuration.repository.saveGitHubDraftPullRequest || configuration.bindings.length === 0
    || !configuration.tokens || !configuration.snapshot || !configuration.sandbox?.run
    || !configuration.draftPullRequest || typeof configuration.clock !== "function") {
    throw new Error("GITHUB_PRODUCTION_WORKFLOW_CONTROLS_REQUIRED");
  }
  const operate = async (request: WorkflowSideEffectRequest): Promise<WorkflowSideEffectResult> => {
    if (!GITHUB_PRODUCTION_EFFECT_KINDS.includes(request.kind as typeof GITHUB_PRODUCTION_EFFECT_KINDS[number])
      || request.signal.aborted) throw new Error("GITHUB_WORKFLOW_EFFECT_REQUEST_INVALID");
    const material = await configuration.repository.getWorkflowExecutionMaterial(
      request.workerId, request.taskId, request.leaseGeneration,
    );
    if (material.workflowRunId !== request.workflowRunId) throw new Error("GITHUB_WORKFLOW_BINDING_INVALID");
    const binding = exactGitHubBinding(material, configuration.bindings);
    const selection: GitHubRepositorySelection = {
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      owner: binding.owner,
      repository: binding.repository,
      ref: binding.ref,
    };
    return withGitHubAppSession(selection, {
      clock: configuration.clock,
      tokens: configuration.tokens,
      signal: request.signal,
    }, async (session) => {
      const snapshot = await captureGitHubSourceSnapshot(session, configuration.snapshot);
      const change = assertReviewedMaterial(material, binding, snapshot);
      let sandboxReference: string | undefined;
      if (["candidate_verify", "publish", "install_verify"].includes(request.phase)) {
        const verification = await runGitHubSandboxVerification({
          snapshotReference: snapshot.reference,
          patchDigest: change.patchDigest,
          baseCommitSha: change.baseCommitSha,
          limits: configuration.sandboxLimits ?? defaultSandboxLimits,
        }, configuration.sandbox, request.signal);
        if (!verification.passed) throw new Error("GITHUB_SANDBOX_VERIFICATION_FAILED");
        sandboxReference = verification.reference;
      }
      let draft: Awaited<ReturnType<typeof reconcileGitHubDraftPullRequest>> | undefined;
      if (["publish", "install_verify"].includes(request.phase)) {
        draft = await reconcileGitHubDraftPullRequest(session, configuration.draftPullRequest, {
          selection,
          baseCommitSha: change.baseCommitSha,
          patchDigest: change.patchDigest,
          files: change.files,
          checkOutputReference: sandboxReference!,
        });
      }
      let previewReference: string | undefined;
      if (request.phase === "install_verify") {
        if (draft?.check.status !== "completed" || draft.check.conclusion !== "success") {
          throw new Error("GITHUB_CHECK_NOT_SUCCESSFUL");
        }
        if (configuration.preview) {
          previewReference = (await verifyGitHubPreview(session, configuration.preview, {
            commitSha: draft.headCommitSha,
            allowedOrigin: binding.targetOrigin,
          })).reference;
        }
      }
      const content = canonicalJson({
        adapter: "github-reviewed-workflow",
        adapterVersion: 1,
        analysisRunId: material.analysisRunId,
        commitSha: snapshot.commitSha,
        draft: draft ? {
          branch: draft.branch,
          check: draft.check,
          draft: draft.draft,
          headCommitSha: draft.headCommitSha,
          installed: draft.installed,
          merged: draft.merged,
          number: draft.number,
        } : undefined,
        phase: request.phase,
        previewReference,
        sandboxReference,
        snapshotReference: snapshot.reference,
        sourceNativeReference: material.analysis.evidence.find(({ source }) => source === "source")?.reference,
      });
      const outputHash = sha256(content);
      const result = { outputHash, outputReference: `urn:sha256:${outputHash}` };
      if (draft && sandboxReference) {
        const stored = await configuration.repository.saveGitHubDraftPullRequest(
          request.workerId,
          request.taskId,
          request.leaseGeneration,
          {
            workflowRunId: material.workflowRunId,
            analysisRunId: material.analysisRunId,
            installationId: selection.installationId,
            repositoryId: selection.repositoryId,
            owner: selection.owner,
            repository: selection.repository,
            requestedRef: selection.ref,
            baseCommitSha: draft.baseCommitSha,
            patchDigest: change.patchDigest,
            branch: draft.branch,
            number: draft.number,
            headCommitSha: draft.headCommitSha,
            draft: draft.draft,
            merged: draft.merged,
            check: draft.check,
            sandboxReference,
            ...(previewReference ? { previewReference } : {}),
            sideEffectIdempotencyKey: request.idempotencyKey,
            sideEffectInputHash: request.inputHash,
            ...result,
          },
        );
        if (stored.outputHash !== result.outputHash || stored.outputReference !== result.outputReference) {
          throw new Error("GITHUB_WORKFLOW_OUTPUT_STORE_MISMATCH");
        }
      }
      return result;
    });
  };
  const lookup = async (request: WorkflowSideEffectRequest): Promise<WorkflowSideEffectResult | undefined> => {
    if (!GITHUB_PRODUCTION_EFFECT_KINDS.includes(request.kind as typeof GITHUB_PRODUCTION_EFFECT_KINDS[number])
      || request.signal.aborted) throw new Error("GITHUB_WORKFLOW_EFFECT_REQUEST_INVALID");
    if (!(["publish", "install_verify"] as const).includes(request.phase as "publish" | "install_verify")) {
      return undefined;
    }
    const stored = await configuration.repository.getGitHubDraftPullRequestForTask(
      request.workerId, request.taskId, request.leaseGeneration,
    );
    if (!stored) return undefined;
    if (stored.workflowRunId !== request.workflowRunId
      || stored.sideEffectIdempotencyKey !== request.idempotencyKey
      || stored.sideEffectInputHash !== request.inputHash) throw new Error("GITHUB_WORKFLOW_OUTPUT_STORE_MISMATCH");
    return { outputHash: stored.outputHash, outputReference: stored.outputReference };
  };
  return {
    lookup,
    execute: operate,
    reconcile: async (request) => await lookup(request) ?? operate(request),
    cleanup: async () => undefined,
  };
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
