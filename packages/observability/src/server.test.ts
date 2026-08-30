import assert from "node:assert/strict";
import test from "node:test";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { PostHog } from "posthog-node";
import { flushPostHogEvent, shouldExportPage2WebMcpSpan } from "./server.ts";

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

function span(name: string, scope: string) {
  return { name, instrumentationScope: { name: scope } };
}
