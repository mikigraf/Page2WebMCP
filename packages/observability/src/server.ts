import { createObservability, type ObservabilityVendor, type VendorRecord } from "./index.ts";

const LANGFUSE_FACADE_SCOPE = "langfuse-sdk";
const LANGFUSE_FACADE_PREFIX = "page2webmcp.";
let observability = createObservability();
let initialized = false;
let langfuseSdk: { shutdown(): Promise<void> } | undefined;
let posthogClient: PostHogClient | undefined;

export function getObservability() {
  return observability;
}

export async function registerObservability(): Promise<void> {
  if (initialized || process.env.PAGE2WEBMCP_OBSERVABILITY_ENABLED !== "true") return;
  initialized = true;
  observability = createObservability({
    enabled: true,
    loadVendor: loadProductionVendor,
    onVendorError: () => writeOperatorDiagnostic("OBSERVABILITY_EXPORT_FAILED")
  });
}

export async function shutdownObservability(): Promise<void> {
  const sdk = langfuseSdk;
  const posthog = posthogClient;
  langfuseSdk = undefined;
  posthogClient = undefined;
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
  client: Pick<PostHogClient, "capture" | "flush">,
  record: VendorRecord
): Promise<void> {
  client.capture({
    distinctId: "page2webmcp-server",
    event: record.event,
    properties: { ...record.properties, $process_person_profile: false }
  });
  await client.flush();
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
  ): { end(endTime?: Date): void };
};

type PostHogClient = {
  capture(input: { distinctId: string; event: string; properties: Record<string, string | number | boolean> }): void;
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
