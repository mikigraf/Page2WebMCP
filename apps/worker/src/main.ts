import { getControlPlaneRepository } from "../../../packages/database/src/factory.ts";
import type { ControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { validateWorkerRuntimeConfiguration } from "../../control-plane/src/config.ts";
import {
  registerObservability,
  shutdownObservability
} from "../../../packages/observability/src/server.ts";
import { randomUUID } from "node:crypto";
import { createProductionWorkerRuntime, processProductionWorkerIteration } from "./production-runtime.ts";

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
} finally {
  await Promise.allSettled([
    repository ? closeRepository(repository) : Promise.resolve(),
    observabilityRegistered ? shutdownObservability() : Promise.resolve(),
  ]);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function stableCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
    ? error.message
    : "WORKER_LOOP_FAILED";
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
