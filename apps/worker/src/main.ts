import { getControlPlaneRepository } from "../../../packages/database/src/factory.ts";
import type { ControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { validateWorkerRuntimeConfiguration } from "../../control-plane/src/config.ts";
import {
  registerObservability,
  shutdownObservability
} from "../../../packages/observability/src/server.ts";
import { randomUUID } from "node:crypto";
import {
  createProductionWorkerRuntime,
  inspectProductionProviderConfiguration,
  processProductionWorkerIteration,
} from "./production-runtime.ts";

class WorkerStartupConfigurationError extends Error {
  constructor(readonly code: string, readonly missingEnvironment: readonly string[]) {
    super(code);
    this.name = "WorkerStartupConfigurationError";
  }
}

const shutdown = new AbortController();
const workerId = `worker-${randomUUID()}`;
const pollMs = boundedInteger(process.env.PAGE2WEBMCP_WORKER_POLL_MS, 1_000, 100, 30_000);
let consecutiveFailures = 0;
let repository: ControlPlaneRepository | undefined;
let observabilityRegistered = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown.abort());
}

try {
  const provider = inspectProductionProviderConfiguration(process.env);
  if (provider.code !== "PRODUCTION_PROVIDER_CONFIGURATION_READY") {
    throw new WorkerStartupConfigurationError(provider.code, provider.keys);
  }
  validateWorkerRuntimeConfiguration();
  repository = getControlPlaneRepository();
  const runtime = createProductionWorkerRuntime(repository);
  await registerObservability();
  observabilityRegistered = true;
  while (!shutdown.signal.aborted) {
    try {
      const processed = await processProductionWorkerIteration(repository, runtime, workerId, shutdown.signal);
      consecutiveFailures = 0;
      if (!processed) await delay(pollMs, shutdown.signal);
    } catch (error) {
      consecutiveFailures += 1;
      console.error(JSON.stringify({
        level: "error",
        event: "worker_loop_failed",
        code: stableCode(error),
        consecutive_failures: consecutiveFailures
      }));
      const backoffMs = Math.min(pollMs * (2 ** Math.min(consecutiveFailures, 5)), 30_000);
      await delay(backoffMs, shutdown.signal);
    }
  }
} catch (error) {
  const failure = startupFailure(error);
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([
    repository ? closeRepository(repository) : Promise.resolve(),
    observabilityRegistered ? shutdownObservability() : Promise.resolve(),
  ]);
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
