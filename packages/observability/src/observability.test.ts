import assert from "node:assert/strict";
import test from "node:test";
import { acmeCapabilityPlans } from "../../../apps/acme-support/src/capability-plans.ts";
import {
  createObservability,
  createRequestId,
  sanitizeProperties,
  shouldSample,
  type ObservabilityVendor
} from "./index.ts";

test("disabled observability does not load or call vendors", async () => {
  let loads = 0;
  const observability = createObservability({
    enabled: false,
    loadVendor: async () => {
      loads += 1;
      return failingVendor();
    }
  });

  await observability.record({
    event: "analysis_completed",
    operation: "analysis",
    outcome: "success",
    requestId: "request-disabled"
  });

  assert.equal(loads, 0);
});

test("observability rejects event names outside the approved product-event schema", async () => {
  let exports = 0;
  const observability = createObservability({
    enabled: true,
    writeLog: () => undefined,
    loadVendor: async () => ({
      trace: async () => { exports += 1; },
      event: async () => { exports += 1; }
    })
  });

  await observability.record({
    event: "unapproved_event",
    outcome: "failure",
    requestId: "request-unapproved"
  } as unknown as Parameters<typeof observability.record>[0]);

  assert.equal(exports, 0);
});

test("observability replaces unsafe caller request IDs before logging or export", async () => {
  const logs: string[] = [];
  const exportedIds: string[] = [];
  const observability = createObservability({
    enabled: true,
    writeLog: (line) => logs.push(line),
    loadVendor: async () => ({
      trace: async (record) => { exportedIds.push(record.requestId); },
      event: async () => undefined
    })
  });

  const requestId = await observability.record({
    event: "analysis_completed",
    operation: "analysis",
    outcome: "failure",
    requestId: "request-token"
  });

  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(exportedIds, [requestId]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(requestId));
  assert.doesNotMatch(logs[0], /request-token/);
});

test("observability rejects runtime-invalid outcomes before logging or export", async () => {
  const logs: string[] = [];
  let exports = 0;
  const observability = createObservability({
    enabled: true,
    writeLog: (line) => logs.push(line),
    loadVendor: async () => ({
      trace: async () => { exports += 1; },
      event: async () => { exports += 1; }
    })
  });

  await observability.record({
    event: "analysis_completed",
    operation: "analysis",
    outcome: "untrusted-outcome",
    requestId: "request-outcome"
  } as unknown as Parameters<typeof observability.record>[0]);

  assert.equal(logs.length, 0);
  assert.equal(exports, 0);
});

test("observability only forwards allowlisted, non-sensitive properties", async () => {
  const emitted: Array<Record<string, unknown>> = [];
  const observability = createObservability({
    enabled: true,
    loadVendor: async () => ({
      trace: async (record) => { emitted.push(record.properties); },
      event: async () => undefined
    })
  });

  await observability.record({
    event: "analysis_completed",
    operation: "analysis",
    outcome: "failure",
    requestId: "request-safe",
    properties: {
      code: "VALIDATION_FAILED",
      http_status: 400,
      attempts: 2,
      retryable: true,
      duration_ms: 1_234.4,
      source_type: "website",
      email: "person@example.test",
      password: "not-allowed",
      artifact: "not-allowed",
      token: "not-allowed",
      evidence: "not-allowed",
      release: "https://not-allowed.example"
    }
  });

  assert.deepEqual(emitted, [{
    code: "VALIDATION_FAILED",
    attempts: 2,
    duration_ms: 1234,
    http_status: 400,
    outcome: "failure",
    request_id: "request-safe",
    retryable: true,
    source_type: "website",
    schema_version: 1
  }]);
  assert.deepEqual(sanitizeProperties({ code: "Bearer secret-value" }), { code: "[REDACTED]" });
});

test("observability fails open when a vendor errors or exceeds its timeout", async () => {
  const errors: unknown[] = [];
  const observability = createObservability({
    enabled: true,
    timeoutMs: 5,
    onVendorError: (error) => errors.push(error),
    loadVendor: async () => ({
      trace: async () => new Promise<void>(() => undefined),
      event: async () => { throw new Error("vendor unavailable"); }
    })
  });

  const start = performance.now();
  await observability.record({
    event: "capability_reviewed",
    outcome: "security_denial",
    requestId: "request-timeout"
  });

  assert.ok(performance.now() - start < 200, "the caller must not wait for a stalled export");
  assert.equal(errors.length, 1);
});

test("observability fails open when the structured log sink throws", async () => {
  let events = 0;
  const observability = createObservability({
    enabled: true,
    writeLog: () => { throw new Error("stdout unavailable"); },
    loadVendor: async () => ({
      trace: async () => undefined,
      event: async () => { events += 1; }
    })
  });

  await assert.doesNotReject(observability.record({
    event: "project_created",
    outcome: "success",
    requestId: "request-log-failure"
  }));
  assert.equal(events, 1);
});

test("all product events are retained while only successful traces are sampled", async () => {
  let events = 0;
  let traces = 0;
  const observability = createObservability({
    enabled: true,
    writeLog: () => undefined,
    loadVendor: async () => ({
      trace: async () => { traces += 1; },
      event: async () => { events += 1; }
    })
  });

  for (let index = 0; index < 100; index += 1) {
    await observability.record({
      event: "analysis_completed",
      operation: "analysis",
      outcome: "success",
      requestId: `retention-${index}`
    });
  }

  assert.equal(events, 100);
  assert.ok(traces >= 10 && traces <= 30, `expected sampled traces, received ${traces}`);
});

test("sampling is deterministic and retains all failures and security denials", () => {
  assert.equal(shouldSample({ requestId: "request-a", outcome: "success" }), shouldSample({ requestId: "request-a", outcome: "success" }));
  assert.equal(shouldSample({ requestId: "request-a", outcome: "failure" }), true);
  assert.equal(shouldSample({ requestId: "request-a", outcome: "security_denial" }), true);

  const sampled = Array.from({ length: 1_000 }, (_, index) => shouldSample({ requestId: `request-${index}`, outcome: "success" })).filter(Boolean).length;
  assert.ok(sampled >= 150 && sampled <= 250, `expected approximately 20% success sampling, received ${sampled / 10}%`);
});

test("structured logs retain request correlation without unsafe properties", async () => {
  const lines: string[] = [];
  const requestId = createRequestId();
  const observability = createObservability({
    enabled: false,
    writeLog: (line) => lines.push(line)
  });

  await observability.record({
    event: "project_created",
    outcome: "success",
    requestId,
    properties: { code: "PROJECT_CREATED", token: "not-allowed" }
  });

  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    level: "info",
    event: "project_created",
    request_id: requestId,
    outcome: "success",
    schema_version: 1,
    code: "PROJECT_CREATED"
  });
});

test("compiled WebMCP artifacts exclude observability implementation markers", async () => {
  const { compileWebMcpRelease } = await import("../../compiler/src/compiler.ts");
  const release = compileWebMcpRelease(acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name === "find_order"));
  assert.doesNotMatch(release.code, /langfuse|posthog|observability/i);
});

function failingVendor(): ObservabilityVendor {
  return {
    trace: async () => { throw new Error("unexpected trace call"); },
    event: async () => { throw new Error("unexpected event call"); }
  };
}
