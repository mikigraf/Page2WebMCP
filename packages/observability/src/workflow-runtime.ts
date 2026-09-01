import type { WorkflowEventRecord } from "../../database/src/workflow.ts";
import { deriveOperationalMetrics, evaluateOperationalAlerts } from "./metrics.ts";
import { getWorkflowTelemetrySink } from "./server.ts";
import {
  createWorkflowTelemetryBatches,
  exportWorkflowTelemetry,
  type WorkflowTelemetryInput,
} from "./workflow.ts";

export type WorkflowStatusObservability = Readonly<{
  telemetry: Readonly<{
    configured: boolean;
    batches: number;
    observations: number;
    exported: number;
    dropped: number;
  }>;
  metrics: ReturnType<typeof deriveOperationalMetrics>;
  alerts: ReturnType<typeof evaluateOperationalAlerts>;
}>;

/** Projects authoritative durable state to optional vendors and operational signals. */
export async function observeWorkflowStatus(input: WorkflowTelemetryInput): Promise<WorkflowStatusObservability> {
  const sink = await getWorkflowTelemetrySink();
  const projected = createWorkflowTelemetryBatches(input);
  const observations = projected.reduce((total, batch) => total + batch.observations.length, 0);
  const telemetry = sink
    ? { configured: true, ...await exportWorkflowTelemetry(input, sink) }
    : { configured: false, batches: projected.length, observations, exported: 0, dropped: 0 };
  const counters = deriveCounters(input.events, input.tasks);
  const metrics = deriveOperationalMetrics({
    now: new Date(),
    runs: [input.run],
    tasks: input.tasks,
    counters: { ...counters, telemetryDropped: telemetry.dropped },
    databasePool: { active: 0, idle: 0, waiting: 0, max: 1 },
  });
  const alerts = evaluateOperationalAlerts(metrics);
  writeOperationalProjection(input.run.id, metrics, alerts, telemetry);
  return { telemetry, metrics, alerts };
}

function deriveCounters(
  events: readonly WorkflowEventRecord[],
  tasks: WorkflowTelemetryInput["tasks"],
) {
  const failed = events.filter(({ type }) => type === "task.failed" || type === "task.side_effect_failed");
  const label = (event: WorkflowEventRecord) => `${event.code ?? ""}:${event.payload?.operation ?? ""}`;
  const countFailures = (pattern: RegExp) => failed.filter((event) => pattern.test(label(event))).length;
  const verification = tasks.filter(({ phase }) =>
    phase === "controlled_mutation_verification" || phase === "candidate_verify");
  return {
    providerErrors: countFailures(/PROVIDER|GITHUB|OPENAPI|HTTP|FETCH/i),
    browserErrors: countFailures(/BROWSER|PLAYWRIGHT|CDP/i),
    modelErrors: countFailures(/MODEL|GROUPING/i),
    verificationAttempts: verification.length,
    verificationFailures: verification.filter(({ status }) => status === "failed").length,
    releasesPublished: tasks.filter(({ phase, status }) => phase === "publish" && status === "succeeded").length,
    installationsVerified: tasks.filter(({ phase, status }) => phase === "install_verify" && status === "succeeded").length,
    reconciliations: events.filter(({ type }) => type === "workflow.reconciled" || type === "task.reconciled").length,
    reconciliationFailures: failed.filter(({ code }) => code === "RECONCILIATION_FAILED").length,
    retentionFailures: failed.filter(({ code }) => code === "RETENTION_FAILED").length,
  };
}

function writeOperationalProjection(
  workflowId: string,
  metrics: ReturnType<typeof deriveOperationalMetrics>,
  alerts: ReturnType<typeof evaluateOperationalAlerts>,
  telemetry: WorkflowStatusObservability["telemetry"],
): void {
  try {
    console.info(JSON.stringify({
      level: "info",
      event: "workflow_status_observed",
      workflow_id: workflowId,
      telemetry,
      metrics,
      alerts,
    }));
  } catch {
    // Operational projection is non-authoritative and must never break status.
  }
}
