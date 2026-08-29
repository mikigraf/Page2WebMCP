import {
  getObservability
} from "../../../packages/observability/src/server.ts";
import type { ObservabilityRecord } from "../../../packages/observability/src/index.ts";
import { RepositoryError } from "../../../packages/database/src/control-plane.ts";
import { ApiError } from "./api.ts";

/** Telemetry is always fail-open and cannot alter an API or worker outcome. */
export async function recordLifecycle(record: ObservabilityRecord): Promise<void> {
  try {
    await getObservability().record(record);
  } catch {
    // Keep this boundary even if a future adapter violates the facade contract.
  }
}

export async function recordLifecycleFailure(
  record: Pick<ObservabilityRecord, "event" | "operation" | "requestId"> & { startedAt?: number },
  error: unknown,
  httpStatus: number
): Promise<void> {
  await recordLifecycle({
    event: record.event,
    operation: record.operation,
    requestId: record.requestId,
    outcome: httpStatus === 401 || httpStatus === 403 ? "security_denial" : "failure",
    properties: {
      code: error instanceof ApiError || error instanceof RepositoryError ? error.code : "INTERNAL_ERROR",
      http_status: httpStatus,
      duration_ms: record.startedAt === undefined ? undefined : Math.max(0, Date.now() - record.startedAt)
    }
  });
}
