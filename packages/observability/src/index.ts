import { createHash, randomUUID } from "node:crypto";

export const PRODUCT_EVENTS = [
  "project_created",
  "analysis_completed",
  "capability_reviewed",
  "release_verified",
  "release_published",
  "installation_verified"
] as const;

export const TRACE_OPERATIONS = ["analysis", "verify", "publish"] as const;

export type ProductEvent = typeof PRODUCT_EVENTS[number];
export type TraceOperation = typeof TRACE_OPERATIONS[number];
export type Outcome = "success" | "failure" | "security_denial";
export type SafeProperties = Record<string, string | number | boolean>;

export type ObservabilityRecord = {
  event: ProductEvent;
  operation?: TraceOperation;
  outcome: Outcome;
  requestId?: string;
  properties?: Record<string, unknown>;
};

export type VendorRecord = {
  event: ProductEvent;
  operation?: TraceOperation;
  outcome: Outcome;
  requestId: string;
  properties: SafeProperties;
};

export type ObservabilityVendor = {
  trace(record: VendorRecord): Promise<void>;
  event(record: VendorRecord): Promise<void>;
};

export type ObservabilityOptions = {
  enabled?: boolean;
  timeoutMs?: number;
  loadVendor?: () => Promise<ObservabilityVendor>;
  writeLog?: (line: string) => void;
  onVendorError?: (error: unknown) => void;
};

const MAX_VENDOR_TIMEOUT_MS = 250;
const SUCCESS_SAMPLE_PERCENT = 20;
const SAFE_PROPERTY_RULES: Record<string, (value: unknown) => string | number | boolean | undefined> = {
  actor_id: safeUuid,
  code: safeCode,
  attempts: safeAttempts,
  environment: safeLabel,
  http_status: safeStatus,
  organization_id: safeUuid,
  outcome: safeOutcome,
  release: safeLabel,
  release_result: safeLabel,
  request_id: safeRequestId,
  review_action: safeLabel,
  retryable: safeBoolean,
  risk_tier: safeLabel,
  schema_version: safeSchemaVersion,
  source_type: safeLabel,
  duration_ms: safeDuration
};

export function createObservability(options: ObservabilityOptions = {}) {
  const enabled = options.enabled ?? process.env.PAGE2WEBMCP_OBSERVABILITY_ENABLED === "true";
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? MAX_VENDOR_TIMEOUT_MS, 1), MAX_VENDOR_TIMEOUT_MS);
  const loadVendor = options.loadVendor ?? (async () => NOOP_VENDOR);
  const writeLog = options.writeLog ?? ((line: string) => console.info(line));
  let vendor: Promise<ObservabilityVendor> | undefined;

  return {
    async record(input: ObservabilityRecord): Promise<string> {
      const requestId = safeRequestId(input.requestId) ?? createRequestId();
      if (!isOutcome(input.outcome) || !PRODUCT_EVENTS.includes(input.event) || (input.operation !== undefined && !TRACE_OPERATIONS.includes(input.operation))) return requestId;
      const properties = sanitizeProperties({
        ...runtimeProperties(),
        ...input.properties,
        outcome: input.outcome,
        request_id: requestId,
        schema_version: 1
      });
      const record: VendorRecord = { ...input, requestId, properties };
      try {
        writeLog(JSON.stringify({
          level: "info",
          event: record.event,
          request_id: requestId,
          outcome: record.outcome,
          ...properties
        }));
      } catch (error) {
        try { options.onVendorError?.(error); } catch { /* observability must not affect callers */ }
      }

      if (!enabled) return requestId;
      vendor ??= loadVendor();
      await swallowVendorFailure(
        () => vendor!.then((loaded) => Promise.all([
          loaded.event(record),
          record.operation && shouldSample(record) ? loaded.trace(record) : Promise.resolve()
        ]).then(() => undefined)),
        timeoutMs,
        options.onVendorError
      );
      return requestId;
    }
  };
}

export function createRequestId(): string {
  return randomUUID();
}

export function shouldSample(input: Pick<VendorRecord, "requestId" | "outcome">): boolean {
  if (input.outcome !== "success") return true;
  const bucket = createHash("sha256").update(input.requestId).digest().readUInt32BE(0) % 100;
  return bucket < SUCCESS_SAMPLE_PERCENT;
}

export function sanitizeProperties(properties: Record<string, unknown>): SafeProperties {
  return Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => {
    const safe = SAFE_PROPERTY_RULES[key]?.(value);
    return safe === undefined ? [] : [[key, safe]];
  }));
}

async function swallowVendorFailure(action: () => Promise<void>, timeoutMs: number, onVendorError?: (error: unknown) => void): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action(),
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("OBSERVABILITY_EXPORT_TIMEOUT")), timeoutMs);
      })
    ]);
  } catch (error) {
    try { onVendorError?.(error); } catch { /* observability must not affect callers */ }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return isSensitive(value) ? "[REDACTED]" : /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || isSensitive(value)) return undefined;
  return /^[a-z0-9_-]{1,48}$/i.test(value) ? value : undefined;
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9-]{1,80}$/i.test(value) && !isSensitive(value) ? value : undefined;
}

function safeUuid(value: unknown): string | undefined {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 300_000 ? Math.round(value) : undefined;
}

function safeAttempts(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? value : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function safeSchemaVersion(value: unknown): number | undefined {
  return value === 1 ? 1 : undefined;
}

function safeOutcome(value: unknown): string | undefined {
  return isOutcome(value) ? value : undefined;
}

function isOutcome(value: unknown): value is Outcome {
  return value === "success" || value === "failure" || value === "security_denial";
}

function isSensitive(value: string): boolean {
  return /(?:password|secret|token|api[_-]?key|bearer|cookie|authorization|@|:\/\/)/i.test(value);
}

function runtimeProperties(): Record<string, string> {
  return {
    environment: process.env.PAGE2WEBMCP_OBSERVABILITY_ENVIRONMENT ?? "",
    release: process.env.PAGE2WEBMCP_OBSERVABILITY_RELEASE ?? ""
  };
}

const NOOP_VENDOR: ObservabilityVendor = {
  trace: async () => undefined,
  event: async () => undefined
};
