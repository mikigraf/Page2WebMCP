import assert from "node:assert/strict";
import test from "node:test";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { PostHog } from "posthog-node";
import {
  createLangfuseWorkflowTelemetrySink,
  flushPostHogEvent,
  shouldExportPage2WebMcpSpan,
} from "./server.ts";

test("installed vendor SDKs expose the APIs used by the enabled server adapter", () => {
  assert.equal(typeof LangfuseSpanProcessor, "function");
  assert.equal(typeof propagateAttributes, "function");
  assert.equal(typeof startObservation, "function");
  assert.equal(typeof PostHog, "function");
});

test("Langfuse processor filters unrelated spans while allowing only facade markers", () => {
  const processor = new LangfuseSpanProcessor({
    exporter: { export: (_, callback) => callback({ code: 0 }), shutdown: async () => undefined },
    shouldExportSpan: shouldExportPage2WebMcpSpan
  });
  const filter = (processor as unknown as { shouldExportSpan(input: { otelSpan: unknown }): boolean }).shouldExportSpan;

  assert.equal(filter({ otelSpan: span("page2webmcp.analysis", "langfuse-sdk") }), true);
  assert.equal(filter({ otelSpan: span("GET /api/projects", "next.js") }), false);
  assert.equal(filter({ otelSpan: span("page2webmcp.analysis", "third-party-sdk") }), false);
});

test("PostHog lifecycle events use pseudonymous actor and organization grouping without per-event flushes", async () => {
  const calls: Array<Record<string, unknown>> = [];
  await flushPostHogEvent({
    capture: (input) => { calls.push(input); }
  }, {
    event: "project_created",
    outcome: "success",
    requestId: "request-posthog",
    properties: {
      actor_id: "0cb50a64-a624-4f65-8f0c-a3847101ad83",
      organization_id: "db4c403c-0d99-442e-ac3a-66b574160699",
      outcome: "success",
      request_id: "request-posthog",
      schema_version: 1
    }
  });
  assert.deepEqual(calls, [{
    distinctId: "0cb50a64-a624-4f65-8f0c-a3847101ad83",
    event: "project_created",
    groups: { organization: "db4c403c-0d99-442e-ac3a-66b574160699" },
    properties: {
      actor_id: "0cb50a64-a624-4f65-8f0c-a3847101ad83",
      organization_id: "db4c403c-0d99-442e-ac3a-66b574160699",
      outcome: "success",
      request_id: "request-posthog",
      schema_version: 1,
      $process_person_profile: false
    }
  }]);
});

test("production Langfuse workflow sink creates real workflow, task, and event nesting", async () => {
  const calls: Array<{ parent: string; name: string; metadata: Record<string, string> }> = [];
  type FakeObservation = {
    startObservation(child: string, attributes?: { metadata?: Record<string, string> }): FakeObservation;
    end(): void;
  };
  function observation(name: string): FakeObservation {
    return {
      startObservation: (child, attributes) => {
        calls.push({ parent: name, name: child, metadata: attributes?.metadata ?? {} });
        return observation(child);
      },
      end: () => undefined,
    };
  }
  const sink = createLangfuseWorkflowTelemetrySink({
    startObservation: (name, attributes) => {
      calls.push({ parent: "root", name, metadata: attributes?.metadata ?? {} });
      return observation(name);
    },
  });
  await sink.exportBatch({
    workflowId: "11111111-1111-4111-8111-111111111111",
    batchIndex: 0,
    observations: [{
      observationId: "22222222-2222-4222-8222-222222222222",
      parentObservationId: "33333333-3333-4333-8333-333333333333",
      traceId: "11111111-1111-4111-8111-111111111111",
      workflowId: "11111111-1111-4111-8111-111111111111",
      taskId: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      version: 2,
      name: "task.side_effect_completed",
      startedAt: "2026-08-30T12:00:00.000Z",
      attributes: { input_hash: "a".repeat(64), duration_ms: 12, outcome: "success" },
    }],
  });
  assert.deepEqual(calls.map(({ parent, name }) => ({ parent, name })), [
    { parent: "root", name: "page2webmcp.workflow" },
    { parent: "page2webmcp.workflow", name: "page2webmcp.task" },
    { parent: "page2webmcp.task", name: "page2webmcp.task.side_effect_completed" },
  ]);
  assert.equal(calls[2]?.metadata.input_hash, "a".repeat(64));
});

function span(name: string, scope: string) {
  return { name, instrumentationScope: { name: scope } };
}
