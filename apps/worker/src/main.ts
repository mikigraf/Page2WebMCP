import { getControlPlaneRepository } from "../../../packages/database/src/factory.ts";
import type { ControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { validateWorkerRuntimeConfiguration } from "../../control-plane/src/config.ts";
import {
  registerObservability,
  shutdownObservability
} from "../../../packages/observability/src/server.ts";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createProductionProvider,
  createProductionWorkerRuntimeFromProvider,
  inspectProductionProviderConfiguration,
  processProductionWorkerIteration,
  type ProductionProvider,
  type ProductionWorkerRuntime,
} from "./production-runtime.ts";

type RuntimeEnvironment = Record<string, string | undefined>;

export type ProductionWorkerMainDependencies = Readonly<{
  signal?: AbortSignal;
  constructProvider?: (environment: RuntimeEnvironment) => ProductionProvider;
  validateConfiguration?: (environment: RuntimeEnvironment) => void;
  getRepository?: () => ControlPlaneRepository;
  createRuntime?: (repository: ControlPlaneRepository, provider: ProductionProvider) => ProductionWorkerRuntime;
  registerObservability?: () => Promise<void>;
  shutdownObservability?: () => Promise<void>;
  processIteration?: typeof processProductionWorkerIteration;
  closeRepository?: (repository: ControlPlaneRepository) => Promise<void>;
  workerId?: string;
}>;

class WorkerStartupConfigurationError extends Error {
  constructor(readonly code: string, readonly missingEnvironment: readonly string[]) {
    super(code);
    this.name = "WorkerStartupConfigurationError";
  }
}

export async function runProductionWorker(
  environment: RuntimeEnvironment = process.env,
  dependencies: ProductionWorkerMainDependencies = {},
): Promise<void> {
  const signal = dependencies.signal ?? new AbortController().signal;
  const workerId = dependencies.workerId ?? `worker-${randomUUID()}`;
  const pollMs = boundedInteger(environment.PAGE2WEBMCP_WORKER_POLL_MS, 1_000, 100, 30_000);
  let consecutiveFailures = 0;
  let repository: ControlPlaneRepository | undefined;
  let observabilityRegistered = false;
  try {
    let provider: ProductionProvider;
    try {
      provider = (dependencies.constructProvider ?? createProductionProvider)(environment);
    } catch (error) {
      const inspection = inspectProductionProviderConfiguration(environment);
      if (inspection.code !== "PRODUCTION_PROVIDER_CONFIGURATION_READY") {
        throw new WorkerStartupConfigurationError(inspection.code, inspection.keys);
      }
      throw error;
    }
    (dependencies.validateConfiguration ?? validateWorkerRuntimeConfiguration)(environment);
    if (provider.startupProbe) await provider.startupProbe(signal);
    repository = (dependencies.getRepository ?? getControlPlaneRepository)();
    const runtime = (dependencies.createRuntime ?? createProductionWorkerRuntimeFromProvider)(repository, provider);
    await (dependencies.registerObservability ?? registerObservability)();
    observabilityRegistered = true;
    while (!signal.aborted) {
      try {
        const processed = await (dependencies.processIteration ?? processProductionWorkerIteration)(
          repository, runtime, workerId, signal,
        );
        consecutiveFailures = 0;
        if (!processed) await delay(pollMs, signal);
      } catch (error) {
        consecutiveFailures += 1;
        console.error(JSON.stringify({
          level: "error",
          event: "worker_loop_failed",
          code: stableCode(error),
          consecutive_failures: consecutiveFailures
        }));
        const backoffMs = Math.min(pollMs * (2 ** Math.min(consecutiveFailures, 5)), 30_000);
        await delay(backoffMs, signal);
      }
    }
  } finally {
    await Promise.allSettled([
      repository
        ? (dependencies.closeRepository ?? closeRepository)(repository)
        : Promise.resolve(),
      observabilityRegistered
        ? (dependencies.shutdownObservability ?? shutdownObservability)()
        : Promise.resolve(),
    ]);
  }
}

async function main(): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  try {
    await runProductionWorker(process.env, { signal: shutdown.signal });
  } catch (error) {
    console.error(JSON.stringify(startupFailure(error)));
    process.exitCode = 1;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, stop);
  }
}

function startupFailure(error: unknown): Readonly<{ code: string; missingEnvironment: readonly string[] }> {
  if (error instanceof WorkerStartupConfigurationError) {
    return { code: error.code, missingEnvironment: sortedUnique(error.missingEnvironment) };
  }
  const code = stableCode(error, "WORKER_STARTUP_FAILED");
  const keysByCode: Readonly<Record<string, readonly string[]>> = {
    DATABASE_URL_REQUIRED: ["DATABASE_URL"],
    INVALID_PROVIDER_MODE: ["PAGE2WEBMCP_PROVIDER_MODE"],
    INVALID_STORAGE_MODE: ["PAGE2WEBMCP_STORAGE_MODE"],
    WORKER_POSTGRES_REQUIRED: ["PAGE2WEBMCP_STORAGE_MODE"],
    WORKER_PROVIDER_MODE_REQUIRED: ["PAGE2WEBMCP_PROVIDER_MODE"],
  };
  return { code, missingEnvironment: sortedUnique(keysByCode[code] ?? []) };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function stableCode(error: unknown, fallback = "WORKER_LOOP_FAILED"): string {
  return error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
    ? error.message
    : fallback;
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function closeRepository(value: ControlPlaneRepository): Promise<void> {
  const close = (value as ControlPlaneRepository & { close?: () => Promise<void> }).close;
  if (typeof close === "function") await close.call(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
