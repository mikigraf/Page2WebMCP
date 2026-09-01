import type {
  ClaimedWebsiteAuthenticationCleanupRecord,
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
import type {
  AnalysisAdapter,
  AnalysisSource,
  WebsiteAuthenticationWaitingOutcome,
} from "./workflow.ts";
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
  const stamped: AnalysisAdapter = async (source, signal) => {
    const outcome = await analyze(source, signal);
    if ("disposition" in outcome && outcome.disposition === "waiting_for_authentication") return outcome;
    return { ...outcome, providerProvenance: provenance };
  };
  stamped.finalizeAuthenticationCheckpoint = analyze.finalizeAuthenticationCheckpoint?.bind(analyze);
  stamped.reconcileAuthenticationCheckpoint = analyze.reconcileAuthenticationCheckpoint?.bind(analyze);
  return stamped;
}

export async function processProductionWorkerIteration(
  repository: ControlPlaneRepository,
  runtime: ProductionWorkerRuntime,
  workerId: string,
  signal: AbortSignal,
): Promise<boolean> {
  await repository.reconcileWorkflows(`${workerId}-reconcile`);
  if (runtime.analysisSourceTypes.includes("website")) {
    const cleanup = await repository.claimWebsiteAuthenticationCleanup(workerId, 60_000);
    if (cleanup) {
      await reconcileTerminalWebsiteAuthentication(repository, runtime.analyze, workerId, cleanup, signal);
      return true;
    }
  }
  const analysis = await processNextAnalysis(repository, {
    workerId,
    analyze: runtime.analyze,
    sourceTypes: runtime.analysisSourceTypes,
  });
  if (analysis !== undefined) return true;
  if (!runtime.workflows) return false;
  return await runtime.workflows.runNext(workerId, signal) !== undefined;
}

async function reconcileTerminalWebsiteAuthentication(
  repository: ControlPlaneRepository,
  analyze: AnalysisAdapter,
  workerId: string,
  cleanup: ClaimedWebsiteAuthenticationCleanupRecord,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!analyze.reconcileAuthenticationCheckpoint) {
      throw new Error("WEBSITE_AUTHENTICATION_RECONCILE_NOT_CONFIGURED");
    }
    const source: AnalysisSource = {
      id: cleanup.analysisRunId,
      organizationId: cleanup.organizationId,
      projectId: cleanup.projectId,
      sourceType: "website",
      sourceUrl: cleanup.sourceUrl,
      sourceSnapshotId: cleanup.sourceSnapshotId,
      sourceIdentityHash: cleanup.sourceIdentityHash,
      liveReceiptEvidence: cleanup.liveReceiptEvidence,
    };
    const waiting: WebsiteAuthenticationWaitingOutcome = {
      disposition: "waiting_for_authentication",
      capabilities: [],
      diagnostics: [],
      evidence: [],
      checkpointReference: cleanup.checkpointReference,
      sourceSnapshotId: cleanup.sourceSnapshotId,
      sourceIdentityHash: cleanup.sourceIdentityHash,
      targetOriginDigest: cleanup.targetOriginDigest,
      expiresAt: cleanup.expiresAt,
    };
    const resourceUpdates = await analyze.reconcileAuthenticationCheckpoint(
      source, waiting, signal, cleanup.outcome,
    );
    await repository.completeWebsiteAuthenticationCleanup(
      workerId,
      cleanup.analysisRunId,
      cleanup.leaseGeneration,
      resourceUpdates ?? [],
    );
  } catch (error) {
    const failureCode = authenticationCleanupFailureCode(error);
    await repository.retryWebsiteAuthenticationCleanup(
      workerId,
      cleanup.analysisRunId,
      cleanup.leaseGeneration,
      failureCode,
      authenticationCleanupRetryable(failureCode),
    );
    throw error;
  }
}

function authenticationCleanupRetryable(code: string): boolean {
  return code === "WEBSITE_CONTROL_RETRYABLE"
    || code === "WEBSITE_CONTROL_TIMEOUT"
    || code === "WEBSITE_CONTROL_ABORTED";
}

function authenticationCleanupFailureCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "WEBSITE_AUTHENTICATION_RECONCILE_FAILED";
}
