import type { ControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { createHash } from "node:crypto";
import { WorkflowController } from "../../../packages/database/src/workflow.ts";
import { createConfiguredGitHubWorkflow } from "./github-live.ts";
import {
  createGitHubProductionWorkflowSideEffect,
  createGitHubWorkflowPhaseHandlers,
  GITHUB_PRODUCTION_EFFECT_KINDS,
} from "./github-workflow.ts";
import { processNextAnalysis } from "./runner.ts";
import type { AnalysisAdapter } from "./workflow.ts";

type RuntimeEnvironment = Record<string, string | undefined>;

export type ProductionWorkerRuntime = Readonly<{
  analyze: AnalysisAdapter;
  workflows: WorkflowController;
}>;

export function createProductionWorkerRuntime(
  repository: ControlPlaneRepository,
  environment: RuntimeEnvironment = process.env,
  dependencies: Readonly<{ fetch: typeof fetch; clock?: () => Date }> = { fetch },
): ProductionWorkerRuntime {
  const github = createConfiguredGitHubWorkflow(environment, dependencies);
  const sideEffect = createGitHubProductionWorkflowSideEffect({
    repository,
    bindings: github.bindings,
    clock: dependencies.clock ?? (() => new Date()),
    tokens: github.tokens,
    snapshot: github.snapshot,
    sandbox: github.sandbox,
    draftPullRequest: github.draftPullRequest,
    preview: github.preview,
  });
  const sideEffects = Object.fromEntries(GITHUB_PRODUCTION_EFFECT_KINDS.map((kind) => [kind, sideEffect]));
  return {
    analyze: github.analyze,
    workflows: new WorkflowController(repository, {
      handlers: createGitHubWorkflowPhaseHandlers({
        inputHash: (phase, task) => createHash("sha256").update(`${task.inputHash}\0${phase}`, "utf8").digest("hex"),
      }),
      sideEffects,
    }),
  };
}

export async function processProductionWorkerIteration(
  repository: ControlPlaneRepository,
  runtime: ProductionWorkerRuntime,
  workerId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const analysis = await processNextAnalysis(repository, { workerId, analyze: runtime.analyze });
  if (analysis !== undefined) return true;
  await repository.reconcileWorkflows(`${workerId}-reconcile`);
  return await runtime.workflows.runNext(workerId, signal) !== undefined;
}
