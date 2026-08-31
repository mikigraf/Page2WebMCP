import type { ControlPlaneRepository, SourceType } from "../../../packages/database/src/control-plane.ts";
import { createHash } from "node:crypto";
import { WorkflowController } from "../../../packages/database/src/workflow.ts";
import { createConfiguredGitHubWorkflow, githubConfigurationInvalidKeys } from "./github-live.ts";
import { createConfiguredOpenApiAnalysisAdapter } from "./openapi-live.ts";
import { createConfiguredWebsiteAnalysisAdapter, websiteMissingControls } from "./website-live.ts";
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
  analysisSourceTypes: readonly SourceType[];
  workflows?: WorkflowController;
}>;

export type ProductionProviderInspection = Readonly<{
  code:
    | "PRODUCTION_PROVIDER_CONFIGURATION_READY"
    | "INVALID_PROVIDER_MODE"
    | "WORKER_PROVIDER_MODE_REQUIRED"
    | "WEBSITE_LIVE_CONFIGURATION_REQUIRED"
    | "GITHUB_LIVE_CONFIGURATION_REQUIRED";
  keys: readonly string[];
}>;

export function inspectProductionProviderConfiguration(
  environment: RuntimeEnvironment,
): ProductionProviderInspection {
  const mode = environment.PAGE2WEBMCP_PROVIDER_MODE;
  if (mode === undefined || mode === "local") {
    return { code: "WORKER_PROVIDER_MODE_REQUIRED", keys: ["PAGE2WEBMCP_PROVIDER_MODE"] };
  }
  if (mode === "openapi") return { code: "PRODUCTION_PROVIDER_CONFIGURATION_READY", keys: [] };
  if (mode === "website") {
    const keys = websiteMissingControls(environment);
    return keys.length > 0
      ? { code: "WEBSITE_LIVE_CONFIGURATION_REQUIRED", keys }
      : { code: "PRODUCTION_PROVIDER_CONFIGURATION_READY", keys: [] };
  }
  if (mode === "github") {
    const keys = githubConfigurationInvalidKeys(environment);
    return keys.length > 0
      ? { code: "GITHUB_LIVE_CONFIGURATION_REQUIRED", keys }
      : { code: "PRODUCTION_PROVIDER_CONFIGURATION_READY", keys: [] };
  }
  return { code: "INVALID_PROVIDER_MODE", keys: ["PAGE2WEBMCP_PROVIDER_MODE"] };
}

export function createProductionWorkerRuntime(
  repository: ControlPlaneRepository,
  environment: RuntimeEnvironment = process.env,
  dependencies: Readonly<{ fetch: typeof fetch; clock?: () => Date }> = { fetch },
): ProductionWorkerRuntime {
  const inspection = inspectProductionProviderConfiguration(environment);
  if (inspection.code === "WORKER_PROVIDER_MODE_REQUIRED" || inspection.code === "INVALID_PROVIDER_MODE") {
    throw new Error(inspection.code);
  }
  if (environment.PAGE2WEBMCP_PROVIDER_MODE === "openapi") {
    return {
      analyze: createConfiguredOpenApiAnalysisAdapter(environment, {}),
      analysisSourceTypes: ["openapi"],
    };
  }
  if (environment.PAGE2WEBMCP_PROVIDER_MODE === "website") {
    return {
      analyze: createConfiguredWebsiteAnalysisAdapter(environment, dependencies),
      analysisSourceTypes: ["website"],
    };
  }
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
    analysisSourceTypes: ["github"],
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
  const analysis = await processNextAnalysis(repository, {
    workerId,
    analyze: runtime.analyze,
    sourceTypes: runtime.analysisSourceTypes,
  });
  if (analysis !== undefined) return true;
  if (!runtime.workflows) return false;
  await repository.reconcileWorkflows(`${workerId}-reconcile`);
  return await runtime.workflows.runNext(workerId, signal) !== undefined;
}
