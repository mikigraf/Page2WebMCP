import { createObservability, type ObservabilityVendor, type VendorRecord } from "./index.ts";
import type { WorkflowTelemetryBatch, WorkflowTelemetrySink } from "./workflow.ts";

const LANGFUSE_FACADE_SCOPE = "langfuse-sdk";
const LANGFUSE_FACADE_PREFIX = "page2webmcp.";
let observability = createObservability();
let initialized = false;
let langfuseSdk: { shutdown(): Promise<void> } | undefined;
let posthogClient: PostHogClient | undefined;
let workflowTelemetrySink: WorkflowTelemetrySink | undefined;
let productionVendorLoad: Promise<ObservabilityVendor> | undefined;

export function getObservability() {
  return observability;
}

export async function getWorkflowTelemetrySink(): Promise<WorkflowTelemetrySink | undefined> {
  if (!workflowTelemetrySink && process.env.PAGE2WEBMCP_OBSERVABILITY_ENABLED === "true") {
    await loadProductionVendorOnce();
  }
  return workflowTelemetrySink;
}

export function setWorkflowTelemetrySinkForTest(sink: WorkflowTelemetrySink | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_TELEMETRY_OVERRIDE_FORBIDDEN");
  workflowTelemetrySink = sink;
}

export async function registerObservability(): Promise<void> {
  if (initialized || process.env.PAGE2WEBMCP_OBSERVABILITY_ENABLED !== "true") return;
  initialized = true;
  observability = createObservability({
    enabled: true,
    loadVendor: loadProductionVendorOnce,
    onVendorError: () => writeOperatorDiagnostic("OBSERVABILITY_EXPORT_FAILED")
  });
}

function loadProductionVendorOnce(): Promise<ObservabilityVendor> {
  productionVendorLoad ??= loadProductionVendor();
  return productionVendorLoad;
}

export async function shutdownObservability(): Promise<void> {
  const sdk = langfuseSdk;
  const posthog = posthogClient;
  langfuseSdk = undefined;
  posthogClient = undefined;
  workflowTelemetrySink = undefined;
  await Promise.allSettled([sdk?.shutdown(), posthog?.shutdown?.()]);
}

async function loadProductionVendor(): Promise<ObservabilityVendor> {
  const [langfuse, posthog] = await Promise.all([loadLangfuse(), loadPostHog()]);
  if (!langfuse && !posthog) writeOperatorDiagnostic("OBSERVABILITY_VENDOR_UNCONFIGURED");
  return {
    trace: (record) => record.operation ? langfuse?.trace(record) ?? Promise.resolve() : Promise.resolve(),
    event: (record) => posthog?.event(record) ?? Promise.resolve()
  };
}

async function loadLangfuse(): Promise<Pick<ObservabilityVendor, "trace"> | undefined> {
  const configured = [process.env.LANGFUSE_PUBLIC_KEY, process.env.LANGFUSE_SECRET_KEY];
  if (configured.some(Boolean) && !configured.every(Boolean)) {
    writeOperatorDiagnostic("LANGFUSE_CONFIGURATION_INVALID");
    return undefined;
  }
  if (!configured.every(Boolean)) return undefined;
  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }, tracing] = await Promise.all([
      importVendor<{ NodeSDK: new (options: unknown) => { start(): void; shutdown(): Promise<void> } }>("@opentelemetry/sdk-node"),
      importVendor<{ LangfuseSpanProcessor: new (options: unknown) => unknown }>("@langfuse/otel"),
      importVendor<LangfuseTracing>("@langfuse/tracing")
    ]);
    const sdk = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor({ exportMode: "immediate", shouldExportSpan: shouldExportPage2WebMcpSpan })]
    });
    sdk.start();
    langfuseSdk = sdk;
    workflowTelemetrySink = createLangfuseWorkflowTelemetrySink(tracing);
    return {
      trace: async (record) => tracing.propagateAttributes({
        traceName: `page2webmcp.${record.operation ?? record.event}`,
        metadata: metadata(record)
      }, () => {
        const duration = typeof record.properties.duration_ms === "number" ? record.properties.duration_ms : 0;
        const endTime = new Date();
        const span = tracing.startObservation(
          `page2webmcp.${record.operation ?? record.event}`,
          { metadata: metadata(record) },
          { asType: "span", startTime: new Date(endTime.getTime() - duration) }
        );
        span.end(endTime);
      })
    };
  } catch {
    writeOperatorDiagnostic("LANGFUSE_INITIALIZATION_FAILED");
    return undefined;
  }
}

export function createLangfuseWorkflowTelemetrySink(
  tracing: Pick<LangfuseTracing, "startObservation">,
): WorkflowTelemetrySink {
  return {
    exportBatch: async (batch) => exportLangfuseWorkflowBatch(tracing, batch),
  };
}

async function exportLangfuseWorkflowBatch(
  tracing: Pick<LangfuseTracing, "startObservation">,
  batch: WorkflowTelemetryBatch,
): Promise<void> {
  const first = batch.observations[0];
  const root = tracing.startObservation("page2webmcp.workflow", {
    metadata: {
      workflow_id: batch.workflowId,
      batch_index: String(batch.batchIndex),
      observations: String(batch.observations.length),
    },
  }, { asType: "span", startTime: safeObservationTime(first?.startedAt) });
  const tasks = new Map<string, LangfuseObservation>();
  try {
    for (const item of batch.observations) {
      let parent = root;
      if (item.taskId) {
        const existing = tasks.get(item.taskId);
        if (existing) parent = existing;
        else {
          parent = root.startObservation("page2webmcp.task", {
            metadata: { workflow_id: batch.workflowId, task_id: item.taskId },
          }, { asType: "span", startTime: safeObservationTime(item.startedAt) });
          tasks.set(item.taskId, parent);
        }
      }
      const startedAt = safeObservationTime(item.startedAt);
      const event = parent.startObservation(`page2webmcp.${item.name}`, {
        metadata: {
          workflow_id: batch.workflowId,
          observation_id: item.observationId,
          sequence: String(item.sequence),
          version: String(item.version),
          ...Object.fromEntries(Object.entries(item.attributes).map(([key, value]) => [key, String(value)])),
        },
      }, { asType: "span", startTime: startedAt });
      const duration = typeof item.attributes.duration_ms === "number" ? item.attributes.duration_ms : 0;
      event.end(new Date(startedAt.getTime() + duration));
    }
  } finally {
    for (const task of tasks.values()) task.end();
    root.end();
  }
}

function safeObservationTime(value: string | undefined): Date {
  const milliseconds = value === undefined ? Number.NaN : Date.parse(value);
  return new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
}

export function shouldExportPage2WebMcpSpan(input: { otelSpan: { name?: unknown; instrumentationScope?: { name?: unknown } } }): boolean {
  return input.otelSpan.instrumentationScope?.name === LANGFUSE_FACADE_SCOPE
    && typeof input.otelSpan.name === "string"
    && input.otelSpan.name.startsWith(LANGFUSE_FACADE_PREFIX);
}

async function loadPostHog(): Promise<Pick<ObservabilityVendor, "event"> | undefined> {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST;
  const configured = [apiKey, host];
  if (configured.some(Boolean) && !configured.every(Boolean)) {
    writeOperatorDiagnostic("POSTHOG_CONFIGURATION_INVALID");
    return undefined;
  }
  if (!apiKey || !host) return undefined;
  try {
    const { PostHog } = await importVendor<{ PostHog: new (key: string, options: unknown) => PostHogClient }>("posthog-node");
    const client = new PostHog(apiKey, {
      host,
      disableGeoip: true,
      flushAt: 20,
      flushInterval: 5_000
    });
    posthogClient = client;
    return {
      event: (record) => flushPostHogEvent(client, record)
    };
  } catch {
    writeOperatorDiagnostic("POSTHOG_INITIALIZATION_FAILED");
    return undefined;
  }
}

export async function flushPostHogEvent(
  client: Pick<PostHogClient, "capture">,
  record: VendorRecord
): Promise<void> {
  const actorId = typeof record.properties.actor_id === "string"
    ? record.properties.actor_id
    : record.requestId;
  const organizationId = typeof record.properties.organization_id === "string"
    ? record.properties.organization_id
    : undefined;
  client.capture({
    distinctId: actorId,
    event: record.event,
    ...(organizationId ? { groups: { organization: organizationId } } : {}),
    properties: { ...record.properties, $process_person_profile: false }
  });
}

async function importVendor<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

function metadata(record: VendorRecord): Record<string, string> {
  return Object.fromEntries(Object.entries(record.properties).map(([key, value]) => [key, String(value)]));
}

type LangfuseTracing = {
  propagateAttributes(attributes: { traceName: string; metadata: Record<string, string> }, callback: () => void): void;
  startObservation(
    name: string,
    attributes: { metadata: Record<string, string> },
    options: { asType: "span"; startTime: Date }
  ): LangfuseObservation;
};

type LangfuseObservation = {
  startObservation(
    name: string,
    attributes?: { metadata?: Record<string, string> },
    options?: { asType?: "span"; startTime?: Date },
  ): LangfuseObservation;
  end(endTime?: Date): void;
};

type PostHogClient = {
  capture(input: {
    distinctId: string;
    event: string;
    groups?: Record<string, string>;
    properties: Record<string, string | number | boolean>;
  }): void;
  flush(): Promise<void>;
  shutdown?(): Promise<void>;
};

function writeOperatorDiagnostic(code: string): void {
  try {
    console.error(JSON.stringify({ level: "error", event: "observability_failed", code }));
  } catch {
    // Diagnostics remain fail-open if stderr is unavailable.
  }
}
