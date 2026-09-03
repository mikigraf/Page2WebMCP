export type ConsoleErrorCode =
  | "AUTH_REQUIRED"
  | "ORIGIN_MISMATCH"
  | "REQUEST_TOKEN_REQUIRED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INVALID_JSON"
  | "PAYLOAD_TOO_LARGE"
  | "HIGH_RISK_ACTION"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_INVALID"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "INSUFFICIENT_STOCK"
  | "CAPACITY_EXCEEDED";

/** Stable, non-descriptive failure carried to clients as a bare code. */
export class ConsoleError extends Error {
  constructor(readonly code: ConsoleErrorCode) {
    super(code);
    this.name = "ConsoleError";
  }
}

export function consoleErrorStatus(code: ConsoleErrorCode | "INTERNAL_ERROR"): number {
  if (code === "AUTH_REQUIRED") return 401;
  if (code === "ORIGIN_MISMATCH" || code === "REQUEST_TOKEN_REQUIRED" || code === "HIGH_RISK_ACTION"
    || code === "CONFIRMATION_REQUIRED" || code === "CONFIRMATION_INVALID") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "IDEMPOTENCY_CONFLICT" || code === "INSUFFICIENT_STOCK") return 409;
  if (code === "PAYLOAD_TOO_LARGE") return 413;
  if (code === "CAPACITY_EXCEEDED") return 503;
  if (code === "INTERNAL_ERROR") return 500;
  return 400;
}
