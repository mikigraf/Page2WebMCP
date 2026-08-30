import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { InMemoryControlPlaneRepository, RepositoryError, type RepositoryActor } from "../../../packages/database/src/control-plane.ts";
import { WorkflowController, type WorkflowPhase, type WorkflowSideEffectPort } from "../../../packages/database/src/workflow.ts";
import { createGitHubAnalysisAdapter } from "./workflow.ts";
import {
  createGitHubDraftPullRequestSideEffect,
  createGitHubProductionWorkflowSideEffect,
  createGitHubWorkflowPhaseHandlers,
  GITHUB_PRODUCTION_EFFECT_KINDS,
  gitHubDraftPullRequestEffectInputHash,
} from "./github-workflow.ts";
import { processNextAnalysis } from "./runner.ts";

const owner: RepositoryActor = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "owner",
};
const now = new Date("2026-08-30T12:00:00.000Z");
const token = "ghs_worker_ephemeral_abcdefghijklmnopqrstuvwxyz";
const selection = {
  installationId: 41,
  repositoryId: 90210,
  owner: "bright-tools",
  repository: "widget-console",
  ref: "refs/heads/main",
};

const route = `
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
`;
const sourceFiles = [
  { path: "app/api/widgets/route.ts", kind: "blob", content: route },
  { path: "lib/auth.ts", kind: "blob", content: "export function requireAccount(request: Request) { if (!request.headers.get('cookie')) throw new Error('AUTHENTICATION_REQUIRED'); return { id: 'account' }; }" },
  { path: "lib/widgets.ts", kind: "blob", content: "export async function createWidget() { return { id: 'widget' }; }" },
] as const;

function configuration(events: string[], files: readonly { path: string; kind: "blob"; content: string }[] = sourceFiles) {
  return {
    targetOrigin: "https://widgets.example",
    clock: () => now,
    installation: {
      resolve: async (input: { sourceUrl: string }) => {
        events.push(`resolve:${input.sourceUrl}`);
        return selection;
      },
    },
    tokens: {
      issue: async () => ({ ...selection, token, expiresAt: new Date(now.getTime() + 3_600_000).toISOString() }),
      revoke: async (_token: string, reason: string) => { events.push(`revoke:${reason}`); },
    },
    snapshot: {
      resolveRef: async () => ({ ...selection, requestedRef: selection.ref, commitSha: "a".repeat(40) }),
      readTree: async ({ commitSha }: { commitSha: string }) => ({ ...selection, requestedRef: selection.ref, commitSha, files }),
    },
  };
}

test("GitHub worker requires explicit controls and returns canonical source-native candidate without claiming a draft PR", async () => {
  assert.throws(() => createGitHubAnalysisAdapter({} as ReturnType<typeof configuration>), /GITHUB_ANALYSIS_CONTROLS_REQUIRED/);
  const events: string[] = [];
  const adapter = createGitHubAnalysisAdapter(configuration(events));
  const result = await adapter({
    sourceType: "github",
    sourceUrl: "https://github.com/bright-tools/widget-console",
    id: "run-1",
    organizationId: owner.organizationId,
    projectId: "22222222-2222-4222-8222-222222222222",
  }, new AbortController().signal);
  assert.deepEqual(result.capabilities.map(({ plan }) => plan.tool.name), ["post_api_widgets"]);
  assert.ok(result.release);
  assert.equal(result.release?.allowedOrigin, "https://widgets.example");
  assert.deepEqual(result.evidence.map(({ source }) => source), ["github", "source"]);
  assert.equal(result.draftPullRequest, undefined);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(events, ["resolve:https://github.com/bright-tools/widget-console", "revoke:completed"]);
  assert.doesNotMatch(JSON.stringify(result), /ghs_worker_ephemeral|api\.github/i);

  await assert.rejects(adapter({ sourceType: "website", sourceUrl: "https://widgets.example" }, new AbortController().signal), /SOURCE_TYPE_UNSUPPORTED/);
  await assert.rejects(adapter({
    sourceType: "github",
    sourceUrl: "https://github.com/other/repository",
    id: "run-2",
    organizationId: owner.organizationId,
    projectId: "22222222-2222-4222-8222-222222222222",
  }, new AbortController().signal), /GITHUB_SOURCE_SELECTION_MISMATCH/);
});

test("GitHub adapter persists exact source-native analysis while unsupported commits remain diagnostic-only", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Widget console persisted",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "project-github-persisted",
    inputHash: "project-github-persisted",
  });
  const run = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-github-persisted",
    inputHash: "analysis-github-persisted",
  });
  const completed = await processNextAnalysis(repository, {
    workerId: "github-analysis-worker",
    analyze: createGitHubAnalysisAdapter(configuration([])),
  });
  assert.equal(completed?.status, "succeeded");
  const persisted = await repository.getAnalysisResult(owner, run.id);
  assert.deepEqual(persisted?.capabilities.map(({ plan }) => plan.tool.name), ["post_api_widgets"]);
  assert.equal(persisted?.draftPullRequest, undefined);
  assert.deepEqual(persisted?.evidence.map(({ source }) => source), ["github", "source"]);

  const unsupportedProject = await repository.createProject(owner, {
    name: "Unsupported repository",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "project-github-unsupported",
    inputHash: "project-github-unsupported",
  });
  const unsupportedRun = await repository.enqueueAnalysis(owner, {
    projectId: unsupportedProject.id,
    idempotencyKey: "analysis-github-unsupported",
    inputHash: "analysis-github-unsupported",
  });
  const unsupportedCompleted = await processNextAnalysis(repository, {
    workerId: "github-unsupported-worker",
    analyze: createGitHubAnalysisAdapter(configuration([], [{ path: "README.md", kind: "blob", content: "A static package." }])),
  });
  assert.equal(unsupportedCompleted?.status, "succeeded");
  const unsupported = await repository.getAnalysisResult(owner, unsupportedRun.id);
  assert.deepEqual(unsupported?.capabilities, []);
  assert.equal(unsupported?.release, undefined);
  assert.deepEqual(unsupported?.diagnostics, [{ code: "UNSUPPORTED_REPOSITORY", operationKey: "a".repeat(40) }]);
});

test("GitHub Task 5 handlers expose only controller side effects with stable inputs and cancellation", async () => {
  const calls: Array<[WorkflowPhase, string]> = [];
  const handlers = createGitHubWorkflowPhaseHandlers({
    inputHash: (phase) => createHash("sha256").update(`github:${phase}`).digest("hex"),
  });
  const workerPhases = ["preflight", "ownership", "browser_auth", "explore", "propose", "review_wait", "controlled_mutation_verification", "compile", "candidate_verify", "publish", "install_verify"] as const;
  for (const phase of workerPhases) {
    const handler = handlers[phase];
    assert.ok(handler, phase);
    const result = await handler({
      task: { id: `task-${phase}`, phase } as never,
      signal: new AbortController().signal,
      sideEffect: async (kind, inputHash) => {
        calls.push([phase, kind]);
        assert.equal(inputHash, createHash("sha256").update(`github:${phase}`).digest("hex"));
        return { outputReference: `urn:sha256:${createHash("sha256").update(kind).digest("hex")}`, outputHash: createHash("sha256").update(kind).digest("hex") };
      },
    });
    assert.match(result.outputReference ?? "", /^urn:sha256:/);
  }
  assert.deepEqual(calls.map(([phase, kind]) => `${phase}:${kind}`), [
    "preflight:github.installation.resolve",
    "ownership:github.installation.verify",
    "browser_auth:github.app_authorization.verify",
    "explore:github.snapshot.capture",
    "propose:github.source.analyze",
    "review_wait:github.review.verify",
    "controlled_mutation_verification:github.patch.generate",
    "compile:github.release.compile",
    "candidate_verify:github.sandbox.verify",
    "publish:github.draft_pull_request.reconcile",
    "install_verify:github.check.reconcile",
  ]);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(handlers.publish!({
    task: { id: "task-cancelled", phase: "publish" } as never,
    signal: aborted.signal,
    sideEffect: async () => { throw new Error("must not execute"); },
  }), /WORKFLOW_CANCELLED/);
});

test("controller recovers a completed GitHub side effect after provider ambiguity and never lets it transition state", async () => {
  const repository = new InMemoryControlPlaneRepository(undefined, { random: () => 0 });
  const project = await repository.createProject(owner, {
    name: "Widget console",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "project-github-worker",
    inputHash: "project-github-worker",
  });
  const run = await repository.startWorkflow(owner, {
    projectId: project.id,
    idempotencyKey: "workflow-github-worker",
    inputHash: "workflow-github-worker",
  });
  const outputHash = createHash("sha256").update("resolved-installation").digest("hex");
  const output = { outputReference: `urn:sha256:${outputHash}`, outputHash };
  let executed = 0;
  let reconciled = 0;
  let cleaned = 0;
  const sideEffect: WorkflowSideEffectPort = {
    lookup: async () => undefined,
    execute: async () => { executed += 1; throw new Error("PROVIDER_RESPONSE_LOST"); },
    reconcile: async () => { reconciled += 1; return output; },
    cleanup: async () => { cleaned += 1; },
  };
  const handlers = createGitHubWorkflowPhaseHandlers({ inputHash: () => "a".repeat(64) });
  const controller = new WorkflowController(repository, {
    handlers,
    sideEffects: { "github.installation.resolve": sideEffect },
    heartbeatMs: 10,
  });
  const completed = await controller.runNext("github-worker");
  assert.equal(completed?.phase, "preflight");
  assert.equal(completed?.status, "succeeded");
  assert.equal(completed?.outputReference, output.outputReference);
  assert.deepEqual([executed, reconciled, cleaned], [1, 1, 1]);
  assert.equal((await repository.getWorkflowRun(owner, run.id)).currentPhase, "ownership");
});

test("GitHub controller side effects abort on lease loss and always clean ephemeral state", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Widget console lease loss",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "project-github-lease-loss",
    inputHash: "project-github-lease-loss",
  });
  await repository.startWorkflow(owner, {
    projectId: project.id,
    idempotencyKey: "workflow-github-lease-loss",
    inputHash: "workflow-github-lease-loss",
  });
  repository.heartbeatWorkflowTask = async () => { throw new RepositoryError("LEASE_LOST"); };
  let observedAbort = false;
  let cleaned = 0;
  const sideEffect: WorkflowSideEffectPort = {
    lookup: async () => undefined,
    execute: async ({ signal }) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("provider timeout")), 1_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    }),
    reconcile: async () => undefined,
    cleanup: async () => { cleaned += 1; },
  };
  const controller = new WorkflowController(repository, {
    handlers: createGitHubWorkflowPhaseHandlers({ inputHash: () => "a".repeat(64) }),
    sideEffects: { "github.installation.resolve": sideEffect },
    heartbeatMs: 10,
  });
  await assert.rejects(controller.runNext("github-lease-loss-worker"), /LEASE_LOST/);
  assert.equal(observedAbort, true);
  assert.equal(cleaned, 1);
});

test("draft PR provider composition is usable only as a stable controller side effect and persists sanitized evidence", async () => {
  const content = "export const installed = true;\n";
  const input = {
    selection,
    baseCommitSha: "a".repeat(40),
    patchDigest: "b".repeat(64),
    files: [{ path: "app/_page2webmcp/register.generated.mjs", content, contentHash: createHash("sha256").update(content).digest("hex") }],
    checkOutputReference: `urn:sha256:${"c".repeat(64)}`,
  };
  const state = new Map<string, unknown>();
  const outputState = new Map<string, { inputHash: string; content: string; result: { outputReference: string; outputHash: string } }>();
  const provider = {
    lookupBranch: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`branch:${idempotencyKey}`),
    createBranch: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: input.baseCommitSha, branch: request.branch, idempotencyKey: request.idempotencyKey };
      state.set(`branch:${request.idempotencyKey}`, value);
      return value;
    },
    lookupPatch: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`patch:${idempotencyKey}`),
    applyPatch: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: input.baseCommitSha, headCommitSha: "e".repeat(40), branch: request.branch, patchDigest: input.patchDigest, idempotencyKey: request.idempotencyKey };
      state.set(`patch:${request.idempotencyKey}`, value);
      return value;
    },
    lookupDraftPullRequest: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`pr:${idempotencyKey}`),
    createDraftPullRequest: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: input.baseCommitSha, headCommitSha: "e".repeat(40), branch: request.branch, number: 17, draft: true, idempotencyKey: request.idempotencyKey };
      state.set(`pr:${request.idempotencyKey}`, value);
      return value;
    },
    lookupCheck: async ({ idempotencyKey }: { idempotencyKey: string }) => state.get(`check:${idempotencyKey}`),
    createCheck: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: input.baseCommitSha, headCommitSha: "e".repeat(40), externalId: request.idempotencyKey, status: "completed", conclusion: "success" };
      state.set(`check:${request.idempotencyKey}`, value);
      return value;
    },
  };
  const effect = createGitHubDraftPullRequestSideEffect({
    selection,
    session: { clock: () => now, tokens: configuration([]).tokens },
    provider,
    input,
    outputs: {
      get: async ({ idempotencyKey, inputHash }) => {
        const stored = outputState.get(idempotencyKey);
        return stored?.inputHash === inputHash ? stored.result : undefined;
      },
      put: async (record) => {
        outputState.set(record.idempotencyKey, { inputHash: record.inputHash, content: record.content, result: record.result });
        return record.result;
      },
    },
  });
  const request = {
    workerId: "github-draft-worker",
    taskId: "task-draft",
    workflowRunId: "run-draft",
    phase: "publish" as const,
    leaseGeneration: 1,
    idempotencyKey: `wfx_${"d".repeat(64)}`,
    kind: "github.draft_pull_request.reconcile",
    inputHash: gitHubDraftPullRequestEffectInputHash(input),
    signal: new AbortController().signal,
  };
  assert.equal(await effect.lookup(request), undefined);
  const executed = await effect.execute(request);
  assert.deepEqual(await effect.lookup(request), executed);
  assert.deepEqual(await effect.reconcile(request), executed);
  const persisted = outputState.get(request.idempotencyKey)?.content ?? "";
  assert.match(persisted, /"draft":true/);
  assert.match(persisted, /"installed":false/);
  assert.doesNotMatch(persisted, /ghs_worker_ephemeral|github\.com|api\.github/i);
  await assert.rejects(effect.execute({ ...request, kind: "github.unapproved" }), /GITHUB_WORKFLOW_EFFECT_REQUEST_INVALID/);
});

test("reviewed GitHub workflow reaches sandbox, draft PR, successful check, and preview without merge or install", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const project = await repository.createProject(owner, {
    name: "Reviewed widget workflow",
    sourceType: "github",
    url: "https://github.com/bright-tools/widget-console",
    idempotencyKey: "project-reviewed-github-workflow",
    inputHash: "project-reviewed-github-workflow",
  });
  const analysis = await repository.enqueueAnalysis(owner, {
    projectId: project.id,
    idempotencyKey: "analysis-reviewed-github-workflow",
    inputHash: "analysis-reviewed-github-workflow",
  });
  await processNextAnalysis(repository, {
    workerId: "reviewed-analysis-worker",
    analyze: createGitHubAnalysisAdapter(configuration([])),
  });
  const [capability] = await repository.listAnalysisCapabilities(owner, analysis.id);
  assert.ok(capability);
  await repository.reviewCapability(owner, capability.id, { action: "approve", expectedVersion: capability.version });
  const run = await repository.startWorkflow(owner, {
    projectId: project.id,
    analysisRunId: analysis.id,
    idempotencyKey: "start-reviewed-github-workflow",
    inputHash: "start-reviewed-github-workflow",
  });
  const providerState = new Map<string, unknown>();
  let sandboxRuns = 0;
  const provider = {
    lookupBranch: async ({ idempotencyKey }: { idempotencyKey: string }) => providerState.get(`branch:${idempotencyKey}`),
    createBranch: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: request.baseCommitSha, branch: request.branch, idempotencyKey: request.idempotencyKey };
      providerState.set(`branch:${request.idempotencyKey}`, value);
      return value;
    },
    lookupPatch: async ({ idempotencyKey }: { idempotencyKey: string }) => providerState.get(`patch:${idempotencyKey}`),
    applyPatch: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: request.baseCommitSha, headCommitSha: "e".repeat(40), branch: request.branch,
        patchDigest: request.patchDigest, idempotencyKey: request.idempotencyKey };
      providerState.set(`patch:${request.idempotencyKey}`, value);
      return value;
    },
    lookupDraftPullRequest: async ({ idempotencyKey }: { idempotencyKey: string }) => providerState.get(`pr:${idempotencyKey}`),
    createDraftPullRequest: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: request.baseCommitSha, headCommitSha: request.headCommitSha, branch: request.branch,
        number: 19, draft: true, idempotencyKey: request.idempotencyKey };
      providerState.set(`pr:${request.idempotencyKey}`, value);
      return value;
    },
    lookupCheck: async ({ idempotencyKey }: { idempotencyKey: string }) => providerState.get(`check:${idempotencyKey}`),
    createCheck: async (request: Record<string, unknown>) => {
      const value = { ...selection, baseCommitSha: request.baseCommitSha, headCommitSha: request.headCommitSha,
        externalId: request.idempotencyKey, status: "completed", conclusion: "success" };
      providerState.set(`check:${request.idempotencyKey}`, value);
      return value;
    },
  };
  const github = configuration([]);
  const sideEffect = createGitHubProductionWorkflowSideEffect({
    repository,
    bindings: [{ ...selection, targetOrigin: "https://widgets.example" }],
    clock: () => now,
    tokens: github.tokens,
    snapshot: github.snapshot,
    sandbox: { run: async (input) => {
      sandboxRuns += 1;
      return {
        snapshotReference: input.snapshotReference,
        patchDigest: input.patchDigest,
        baseCommitSha: input.baseCommitSha,
        appliedLimits: input.limits,
        environmentKeys: [],
        networkAttempts: [],
        steps: input.steps.map((step) => ({ step, exitCode: 0, log: `${step} passed` })),
      };
    } },
    draftPullRequest: provider,
    preview: { lookup: async ({ selection: actual, commitSha }) => ({
      ...actual,
      commitSha,
      servedCommitSha: commitSha,
      status: "ready",
      url: "https://widgets.example/preview/reviewed",
    }) },
  });
  const sideEffects = Object.fromEntries(GITHUB_PRODUCTION_EFFECT_KINDS.map((kind) => [kind, sideEffect]));
  const controller = new WorkflowController(repository, {
    handlers: createGitHubWorkflowPhaseHandlers({
      inputHash: (phase, task) => createHash("sha256").update(`${task.inputHash}\0${phase}`).digest("hex"),
    }),
    sideEffects,
  });
  for (let index = 0; index < 11; index += 1) assert.ok(await controller.runNext(`github-production-${index}`));
  const completed = await repository.getWorkflowRun(owner, run.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.currentPhase, "install_verify");
  assert.equal(sandboxRuns, 3);
  const published = (await repository.listWorkflowTasks(owner, run.id)).find(({ phase }) => phase === "publish");
  assert.match(published?.outputReference ?? "", /^urn:sha256:/);
  assert.doesNotMatch(JSON.stringify(await repository.listWorkflowTasks(owner, run.id)), /ghs_worker_ephemeral|merged":true|installed":true/);
});
