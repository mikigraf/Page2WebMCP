import { randomUUID } from "node:crypto";
import { AcmeSupport } from "../../acme-support/src/app.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import type {
  AnalysisResult,
  AnalysisRunRecord,
  ClaimedAnalysisRunRecord,
  ControlPlaneRepository,
} from "../../../packages/database/src/control-plane.ts";
import { getObservability } from "../../../packages/observability/src/server.ts";
import { runFixtureSourceHardening, runFixtureWorkflow } from "./workflow.ts";

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const ANALYSIS_DEADLINE_MS = 120_000;

export type ProcessAnalysisOptions = {
  workerId?: string;
  leaseMs?: number;
  deadlineMs?: number;
  heartbeatMs?: number;
  analyze?: (source: ClaimedAnalysisRunRecord, signal: AbortSignal) => Promise<AnalysisResult>;
};

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
  const run = await repository.claimAnalysis(workerId, leaseMs);
  if (!run) return undefined;
  const startedAt = Date.now();

  let heartbeatFailure: unknown;
  const heartbeatController = new AbortController();
  const heartbeat = maintainLease(repository, workerId, run.id, leaseMs, heartbeatMs, heartbeatController.signal, (error) => {
    if (stableFailureCode(error) === "LEASE_LOST") heartbeatFailure = error;
  });

  try {
    const result = await withDeadline(
      (signal) => options.analyze ? options.analyze(run, signal) : Promise.resolve(buildResult(run)),
      deadlineMs
    );
    heartbeatController.abort();
    await heartbeat;
    if (heartbeatFailure) throw heartbeatFailure;
    const completed = await repository.completeAnalysis(workerId, run.id, result);
    await recordAnalysisOutcome(run.id, "success", run.sourceType, undefined, startedAt, run.attempts);
    return completed;
  } catch (error) {
    heartbeatController.abort();
    await heartbeat;
    const code = stableFailureCode(error);
    try {
      const failed = await repository.failAnalysis(workerId, run.id, code, isRetryableFailure(code));
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

function buildResult(source: ClaimedAnalysisRunRecord): AnalysisResult {
  assertFixtureScope(source);

  if (source.sourceType === "github") {
    const draftPullRequest = runFixtureSourceHardening();
    const origin = fixtureOrigin();
    const release = compileWebMcpRelease([], origin);
    return {
      capabilities: [],
      evidence: [{ source: "source", draft: true, changedFiles: draftPullRequest.files?.length ?? 0 }],
      release: {
        code: release.code,
        contentHash: release.contentHash,
        allowedOrigin: release.allowedOrigin,
        manifest: release.manifest
      },
      draftPullRequest
    };
  }

  const origin = new URL(source.sourceUrl).origin;
  const workflow = runFixtureWorkflow(new AcmeSupport(), origin);
  const capabilities = workflow.capabilities.map((capability) => ({
    stableName: capability.identity.name,
    riskTier: capability.safety.riskTier,
    status: capability.status === "blocked" ? "blocked" as const : "proposed" as const
  }));
  return {
    capabilities,
    evidence: workflow.evidence,
    release: {
      code: workflow.release.code,
      contentHash: workflow.release.contentHash,
      allowedOrigin: workflow.release.allowedOrigin,
      manifest: workflow.release.manifest
    }
  };
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

function assertFixtureScope(source: ClaimedAnalysisRunRecord): void {
  const expectedOrigin = fixtureOrigin();
  if (source.sourceType === "website" && source.sourceUrl === `${expectedOrigin}/`) return;
  if (source.sourceType === "openapi" && source.sourceUrl === `${expectedOrigin}/openapi.json`) return;
  const expectedRepository = process.env.PAGE2WEBMCP_FIXTURE_GITHUB_URL ?? "https://github.com/acme/support";
  if (source.sourceType === "github" && canonicalUrl(source.sourceUrl) === canonicalUrl(expectedRepository)) return;
  throw new Error("SOURCE_SCOPE_MISMATCH");
}

function fixtureOrigin(): string {
  const configured = process.env.PAGE2WEBMCP_FIXTURE_APP_URL ?? "https://acme.example";
  return new URL(configured).origin;
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
  leaseMs: number,
  heartbeatMs: number,
  signal: AbortSignal,
  onFailure: (error: unknown) => void
): Promise<void> {
  while (!signal.aborted) {
    await abortableDelay(heartbeatMs, signal);
    if (signal.aborted) return;
    try {
      await repository.heartbeatAnalysis(workerId, runId, leaseMs);
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

function canonicalUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function stableFailureCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
  return "ANALYSIS_FAILED";
}

function isRetryableFailure(code: string): boolean {
  return code === "ANALYSIS_DEADLINE_EXCEEDED" || code === "ANALYSIS_FAILED";
}
