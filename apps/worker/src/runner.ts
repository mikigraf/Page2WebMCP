import { randomUUID } from "node:crypto";
import type {
  AnalysisResult,
  AnalysisRunRecord,
  ClaimedAnalysisRunRecord,
  ControlPlaneRepository,
  SourceType,
} from "../../../packages/database/src/control-plane.ts";
import { getObservability } from "../../../packages/observability/src/server.ts";

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const ANALYSIS_DEADLINE_MS = 120_000;

export type ProcessAnalysisOptions = {
  workerId?: string;
  leaseMs?: number;
  deadlineMs?: number;
  heartbeatMs?: number;
  sourceTypes?: readonly SourceType[];
  analyze?: (source: ClaimedAnalysisRunRecord, signal: AbortSignal) => Promise<AnalysisResult>;
};

type AnalysisAdapter = NonNullable<ProcessAnalysisOptions["analyze"]>;
let testAnalysisAdapter: AnalysisAdapter | undefined;

export function setAnalysisAdapterForTest(adapter: AnalysisAdapter | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_ADAPTER_FORBIDDEN");
  testAnalysisAdapter = adapter;
}

/** Claims and processes at most one durable analysis job. */
export async function processNextAnalysis(
  repository: ControlPlaneRepository,
  options: ProcessAnalysisOptions = {}
): Promise<AnalysisRunRecord | undefined> {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const leaseMs = boundedDuration(options.leaseMs, LEASE_MS, 1_000, 300_000);
  const deadlineMs = boundedDuration(options.deadlineMs, ANALYSIS_DEADLINE_MS, 10, 300_000);
  const heartbeatMs = boundedDuration(
    options.heartbeatMs,
    Math.min(HEARTBEAT_MS, Math.max(1_000, Math.floor(leaseMs / 2))),
    10,
    Math.max(10, Math.floor(leaseMs / 2))
  );
  const run = await repository.claimAnalysis(workerId, leaseMs, options.sourceTypes);
  if (!run) return undefined;
  const startedAt = Date.now();

  let heartbeatFailure: unknown;
  const heartbeatController = new AbortController();
  const heartbeat = maintainLease(
    repository, workerId, run.id, run.leaseGeneration, leaseMs, heartbeatMs, heartbeatController.signal, (error) => {
    if (stableFailureCode(error) === "LEASE_LOST") heartbeatFailure = error;
    },
  );

  try {
    const analyze = options.analyze ?? testAnalysisAdapter;
    const result = await withDeadline(
      (signal) => analyze ? analyze(run, signal) : Promise.reject(new Error("ANALYZER_NOT_CONFIGURED")),
      deadlineMs
    );
    heartbeatController.abort();
    await heartbeat;
    if (heartbeatFailure) throw heartbeatFailure;
    const completed = await repository.completeAnalysis(workerId, run.id, result, run.leaseGeneration);
    await recordAnalysisOutcome(run.id, "success", run.sourceType, undefined, startedAt, run.attempts);
    return completed;
  } catch (error) {
    heartbeatController.abort();
    await heartbeat;
    const code = stableFailureCode(error);
    try {
      const failed = await repository.failAnalysis(
        workerId, run.id, code, isRetryableFailure(code), run.leaseGeneration,
      );
      await recordAnalysisOutcome(run.id, "failure", run.sourceType, code, startedAt, run.attempts);
      return failed;
    } catch (transitionError) {
      // A lost lease means another worker owns recovery. Never overwrite its state.
      await recordAnalysisOutcome(run.id, "failure", run.sourceType, code, startedAt, run.attempts);
      throw transitionError;
    }
  } finally {
    heartbeatController.abort();
    await heartbeat;
  }

}

async function recordAnalysisOutcome(
  requestId: string,
  outcome: "success" | "failure",
  sourceType?: ClaimedAnalysisRunRecord["sourceType"],
  code?: string,
  startedAt?: number,
  attempts?: number
): Promise<void> {
  try {
    await getObservability().record({
      event: "analysis_completed",
      operation: "analysis",
      outcome,
      requestId,
      properties: {
        source_type: sourceType,
        code,
        attempts,
        retryable: code === undefined ? false : isRetryableFailure(code),
        duration_ms: startedAt === undefined ? undefined : Date.now() - startedAt
      }
    });
  } catch {
    // Observability is never allowed to influence durable worker state.
  }
}

function boundedDuration(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("ANALYSIS_DEADLINE_EXCEEDED");
          controller.abort(error);
          reject(error);
        }, deadlineMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function maintainLease(
  repository: ControlPlaneRepository,
  workerId: string,
  runId: string,
  leaseGeneration: number,
  leaseMs: number,
  heartbeatMs: number,
  signal: AbortSignal,
  onFailure: (error: unknown) => void
): Promise<void> {
  while (!signal.aborted) {
    await abortableDelay(heartbeatMs, signal);
    if (signal.aborted) return;
    try {
      await repository.heartbeatAnalysis(workerId, runId, leaseMs, leaseGeneration);
    } catch (error) {
      onFailure(error);
      if (stableFailureCode(error) === "LEASE_LOST") return;
    }
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function stableFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
  return "ANALYSIS_FAILED";
}

function isRetryableFailure(code: string): boolean {
  return code === "ANALYSIS_DEADLINE_EXCEEDED" || code === "ANALYSIS_FAILED";
}
