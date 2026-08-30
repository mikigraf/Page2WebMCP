import type {
  WorkflowCapabilityPlanLink,
  WorkflowEventRecord,
  WorkflowEvidenceLink,
  WorkflowRunRecord,
  WorkflowTaskRecord,
} from "../../database/src/workflow.ts";

export type WorkflowTelemetryInput = Readonly<{
  run: WorkflowRunRecord;
  tasks: readonly WorkflowTaskRecord[];
  events: readonly WorkflowEventRecord[];
  evidence: readonly WorkflowEvidenceLink[];
  capabilityPlans: readonly WorkflowCapabilityPlanLink[];
}>;

type WorkflowObservationAttributes = Readonly<Record<string,
  string | number | boolean>>;

export type WorkflowTelemetryObservation = Readonly<{
  observationId: string;
  parentObservationId: string;
  traceId: string;
  workflowId: string;
  taskId?: string;
  sequence: number;
  version: number;
  name: string;
  startedAt: string;
  attributes: WorkflowObservationAttributes;
}>;

export type WorkflowTelemetryBatch = Readonly<{
  workflowId: string;
  batchIndex: number;
  observations: readonly WorkflowTelemetryObservation[];
}>;

export type WorkflowTelemetrySink = Readonly<{
  exportBatch(batch: WorkflowTelemetryBatch): Promise<void>;
}>;

const MAX_BATCH_SIZE = 100;

export function createWorkflowTelemetryBatches(input: WorkflowTelemetryInput): WorkflowTelemetryBatch[] {
  const taskIds = new Set(input.tasks.filter(({ workflowRunId }) => workflowRunId === input.run.id).map(({ id }) => id));
  const observations = [...input.events]
    .filter(({ workflowRunId, organizationId, projectId }) => workflowRunId === input.run.id
      && organizationId === input.run.organizationId && projectId === input.run.projectId)
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((event) => {
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1
        || !Number.isSafeInteger(event.version) || event.version < 1
        || event.taskId !== undefined && !taskIds.has(event.taskId)) return [];
      const attributes = eventAttributes(event);
      return [{
        observationId: event.id,
        parentObservationId: event.taskId ?? input.run.id,
        traceId: input.run.id,
        workflowId: input.run.id,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        sequence: event.sequence,
        version: event.version,
        name: event.type,
        startedAt: event.createdAt,
        attributes,
      } satisfies WorkflowTelemetryObservation];
    });
  const batches: WorkflowTelemetryBatch[] = [];
  for (let offset = 0; offset < observations.length; offset += MAX_BATCH_SIZE) {
    batches.push({
      workflowId: input.run.id,
      batchIndex: batches.length,
      observations: observations.slice(offset, offset + MAX_BATCH_SIZE),
    });
  }
  return batches;
}

export async function exportWorkflowTelemetry(
  input: WorkflowTelemetryInput,
  sink: WorkflowTelemetrySink,
): Promise<Readonly<{ batches: number; observations: number; exported: number; dropped: number }>> {
  const batches = createWorkflowTelemetryBatches(input);
  let exported = 0;
  let dropped = 0;
  for (const batch of batches) {
    try {
      await sink.exportBatch(batch);
      exported += batch.observations.length;
    } catch {
      dropped += batch.observations.length;
    }
  }
  return {
    batches: batches.length,
    observations: exported + dropped,
    exported,
    dropped,
  };
}

function eventAttributes(event: WorkflowEventRecord): WorkflowObservationAttributes {
  const common: Record<string, string | number | boolean> = {
    event_type: event.type,
    event_version: event.version,
  };
  if (event.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(event.code)) common.code = event.code;
  if (!event.type.startsWith("task.side_effect_") || !event.payload) return common;
  const { payload } = event;
  const attributes: Record<string, string | number | boolean> = {};
  if (typeof payload.operation === "string" && /^[a-z][a-z0-9._:-]{0,127}$/.test(payload.operation)) {
    attributes.operation = payload.operation;
  }
  if (typeof payload.inputHash === "string" && /^[0-9a-f]{64}$/.test(payload.inputHash)) {
    attributes.input_hash = payload.inputHash;
  }
  if (typeof payload.outputHash === "string" && /^[0-9a-f]{64}$/.test(payload.outputHash)) {
    attributes.output_hash = payload.outputHash;
  }
  if (typeof payload.durationMs === "number" && Number.isSafeInteger(payload.durationMs)
    && payload.durationMs >= 0 && payload.durationMs <= 3_600_000) attributes.duration_ms = payload.durationMs;
  if (typeof payload.version === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(payload.version)) {
    attributes.version = payload.version;
  }
  if (typeof payload.costMicros === "number" && Number.isSafeInteger(payload.costMicros)
    && payload.costMicros >= 0 && payload.costMicros <= 1_000_000_000) attributes.cost_micros = payload.costMicros;
  if (event.type === "task.side_effect_completed") attributes.outcome = "success";
  if (event.type === "task.side_effect_failed" && payload.outcome === "failure") attributes.outcome = "failure";
  return attributes;
}
