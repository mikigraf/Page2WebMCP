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

test("PostHog lifecycle events are flushed before a request export completes", async () => {
  const calls: string[] = [];
  await flushPostHogEvent({
    capture: (input) => { calls.push(`capture:${input.event}`); },
    flush: async () => { calls.push("flush"); }
  }, {
    event: "project_created",
    outcome: "success",
    requestId: "request-posthog",
    properties: { outcome: "success", request_id: "request-posthog", schema_version: 1 }
  });
  assert.deepEqual(calls, ["capture:project_created", "flush"]);
});

function span(name: string, scope: string) {
  return { name, instrumentationScope: { name: scope } };
}
