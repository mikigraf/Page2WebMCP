import type {
  AnalysisResult,
  ControlPlaneRepository,
  ProviderProvenance,
  SourceType,
} from "../../../packages/database/src/control-plane.ts";
import { createHash } from "node:crypto";
import { WorkflowController } from "../../../packages/database/src/workflow.ts";
import { createConfiguredGitHubWorkflow, githubConfigurationInvalidKeys } from "./github-live.ts";
import { createConfiguredOpenApiProductionAdapter } from "./openapi-live.ts";
import {
  createConfiguredWebsiteAnalysisAdapter,
  probeConfiguredWebsiteControlStartup,
  probeConfiguredWebsiteControls,
  websiteMissingControls,
} from "./website-live.ts";
import {
  createGitHubProductionWorkflowSideEffect,
  createGitHubWorkflowPhaseHandlers,
  GITHUB_PRODUCTION_EFFECT_KINDS,
} from "./github-workflow.ts";
import { processNextAnalysis } from "./runner.ts";
import type { AnalysisAdapter } from "./workflow.ts";
import type { SelectedProviderProbeContext } from "../../../packages/operations/src/readiness.ts";

type RuntimeEnvironment = Record<string, string | undefined>;

export type ProductionWorkerRuntime = Readonly<{
  analyze: AnalysisAdapter;
  analysisSourceTypes: readonly SourceType[];
  providerProvenance?: Exclude<ProviderProvenance, { mode: "local" }>;
  workflows?: WorkflowController;
}>;

export type ProductionProvider = Readonly<{
  analyze: AnalysisAdapter;
  analysisSourceTypes: readonly [SourceType];
  provenance: Exclude<ProviderProvenance, { mode: "local" }>;
  probe(input: Readonly<{
    selectedReleaseHash: string;
    publicOrigin: string;
    context: SelectedProviderProbeContext;
    signal: AbortSignal;
  }>): Promise<void>;
  startupProbe?(signal: AbortSignal): Promise<void>;
  github?: ReturnType<typeof createConfiguredGitHubWorkflow>;
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
  const provider = createProductionProvider(environment, dependencies);
  return createProductionWorkerRuntimeFromProvider(repository, provider, dependencies);
}

export function createProductionWorkerRuntimeFromProvider(
  repository: ControlPlaneRepository,
  provider: ProductionProvider,
  dependencies: Readonly<{ fetch: typeof fetch; clock?: () => Date }> = { fetch },
): ProductionWorkerRuntime {
  if (!provider.github) {
    return {
      analyze: provider.analyze,
      analysisSourceTypes: provider.analysisSourceTypes,
      providerProvenance: provider.provenance,
    };
  }
  const github = provider.github;
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
    analyze: provider.analyze,
    analysisSourceTypes: provider.analysisSourceTypes,
    providerProvenance: provider.provenance,
    workflows: new WorkflowController(repository, {
      handlers: createGitHubWorkflowPhaseHandlers({
        inputHash: (phase, task) => createHash("sha256").update(`${task.inputHash}\0${phase}`, "utf8").digest("hex"),
      }),
      sideEffects,
    }),
  };
}

export function createProductionProvider(
  environment: RuntimeEnvironment = process.env,
  dependencies: Readonly<{ fetch: typeof fetch; clock?: () => Date }> = { fetch },
): ProductionProvider {
  const inspection = inspectProductionProviderConfiguration(environment);
  if (inspection.code !== "PRODUCTION_PROVIDER_CONFIGURATION_READY") throw new Error(inspection.code);
  if (environment.PAGE2WEBMCP_PROVIDER_MODE === "openapi") {
    const provenance = {
      mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false,
    } as const;
    const openapi = createConfiguredOpenApiProductionAdapter(environment, {});
    return {
      analyze: stampProviderProvenance(openapi.analyze, provenance),
      analysisSourceTypes: ["openapi"],
      provenance,
      probe: openapi.probe,
    };
  }
  if (environment.PAGE2WEBMCP_PROVIDER_MODE === "website") {
    const provenance = {
      mode: "website", adapter: "browser-use-v4", adapterVersion: 4, fixture: false,
    } as const;
    return {
      analyze: stampProviderProvenance(createConfiguredWebsiteAnalysisAdapter(environment, dependencies), provenance),
      analysisSourceTypes: ["website"],
      provenance,
      startupProbe: (signal) => probeConfiguredWebsiteControlStartup(environment, {}, signal),
      probe: (input) => probeConfiguredWebsiteControls(environment, {}, input),
    };
  }
  const github = createConfiguredGitHubWorkflow(environment, dependencies);
  const provenance = {
    mode: "github", adapter: "github-app", adapterVersion: 20260310, fixture: false,
  } as const;
  return {
    analyze: stampProviderProvenance(github.analyze, provenance),
    analysisSourceTypes: ["github"],
    provenance,
    probe: github.probe,
    github,
  };
}

function stampProviderProvenance(
  analyze: AnalysisAdapter,
  provenance: Exclude<ProviderProvenance, { mode: "local" }>,
): AnalysisAdapter {
  return async (source, signal): Promise<AnalysisResult> => ({
    ...await analyze(source, signal),
    providerProvenance: provenance,
  });
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
