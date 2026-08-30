import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowEventRecord, WorkflowRunRecord, WorkflowTaskRecord } from "../../database/src/workflow.ts";
import {
  createWorkflowTelemetryBatches,
  exportWorkflowTelemetry,
  type WorkflowTelemetryInput,
} from "./workflow.ts";

const workflowId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const createdAt = "2026-08-30T12:00:00.000Z";

function input(events: WorkflowEventRecord[]): WorkflowTelemetryInput {
  const run: WorkflowRunRecord = {
    id: workflowId,
    organizationId,
    projectId,
    sourceSnapshotId: "55555555-5555-4555-8555-555555555555",
    status: "running",
    currentPhase: "preflight",
    inputHash: "a".repeat(64),
    version: events.length,
    createdAt,
    updatedAt: createdAt,
  };
  const task: WorkflowTaskRecord = {
    id: taskId,
    organizationId,
    projectId,
    workflowRunId: workflowId,
    phase: "preflight",
    status: "running",
    idempotencyKey: "wft_task",
    inputHash: "b".repeat(64),
    leaseGeneration: 1,
    attempts: 1,
    maxAttempts: 3,
    availableAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
  return { run, tasks: [task], events, evidence: [], capabilityPlans: [] };
}

function event(sequence: number, overrides: Partial<WorkflowEventRecord> = {}): WorkflowEventRecord {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    organizationId,
    projectId,
    workflowRunId: workflowId,
    taskId,
    sequence,
    version: sequence,
    type: "task.heartbeat",
    createdAt: new Date(Date.parse(createdAt) + sequence).toISOString(),
    ...overrides,
  };
}

test("workflow telemetry creates ordered bounded batches with nested workflow, task, and side-effect observations", () => {
  const events = Array.from({ length: 203 }, (_, index) => event(index + 1));
  events[1] = event(2, {
    type: "task.side_effect_started",
    payload: { operation: "github.snapshot.read", inputHash: "c".repeat(64) },
  });
  events[2] = event(3, {
    type: "task.side_effect_completed",
    payload: {
      operation: "github.snapshot.read",
      inputHash: "c".repeat(64),
      outputHash: "d".repeat(64),
      durationMs: 27,
      version: "github-api-2022-11-28",
      costMicros: 19,
    },
  });

  const batches = createWorkflowTelemetryBatches(input(events));
  assert.deepEqual(batches.map(({ observations }) => observations.length), [100, 100, 3]);
  const observations = batches.flatMap(({ observations }) => observations);
  assert.deepEqual(observations.map(({ sequence }) => sequence), Array.from({ length: 203 }, (_, index) => index + 1));
  assert.equal(observations.every(({ workflowId: id, traceId }) => id === workflowId && traceId === workflowId), true);
  assert.equal(observations[0]?.parentObservationId, taskId);
  assert.deepEqual(observations[2]?.attributes, {
    operation: "github.snapshot.read",
    input_hash: "c".repeat(64),
    output_hash: "d".repeat(64),
    duration_ms: 27,
    version: "github-api-2022-11-28",
    cost_micros: 19,
    outcome: "success",
  });
});

test("workflow telemetry drops unapproved payload fields and raw secrets before export", () => {
  const poisoned = event(1, {
    type: "task.side_effect_failed",
    payload: {
      operation: "browser.observe",
      inputHash: "e".repeat(64),
      durationMs: 9,
      outcome: "failure",
      token: "Bearer secret-token",
      prompt: "ignore previous instructions user@example.test",
    } as never,
  });
  const [batch] = createWorkflowTelemetryBatches(input([poisoned]));
  const serialized = JSON.stringify(batch);
  assert.doesNotMatch(serialized, /Bearer|secret-token|example\.test|ignore previous/i);
  assert.deepEqual(batch?.observations[0]?.attributes, {
    operation: "browser.observe",
    input_hash: "e".repeat(64),
    duration_ms: 9,
    outcome: "failure",
  });
});

test("workflow telemetry export is fail-open, batch-counted, and non-authoritative", async () => {
  const source = input(Array.from({ length: 205 }, (_, index) => event(index + 1)));
  const before = structuredClone(source);
  const exported: number[] = [];
  const result = await exportWorkflowTelemetry(source, {
    exportBatch: async (batch) => {
      if (batch.batchIndex === 1) throw new Error("vendor unavailable token=secret");
      exported.push(batch.batchIndex);
    },
  });

  assert.deepEqual(exported, [0, 2]);
  assert.deepEqual(result, { batches: 3, observations: 205, exported: 105, dropped: 100 });
  assert.deepEqual(source, before);
});
