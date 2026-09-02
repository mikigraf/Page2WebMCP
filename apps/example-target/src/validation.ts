import { ConsoleError } from "./errors.ts";

export type ReservationInput = Readonly<{
  sku: string;
  quantity: number;
  orderReference: string;
  confirmed: boolean;
}>;

export type ConfirmationRequest = Readonly<{
  toolName: "reserve_part_stock";
  input: ReservationInput;
  idempotencyKey: string;
}>;

export const RESERVE_TOOL_NAME = "reserve_part_stock";
export const MAX_RESERVED_QUANTITY = 99;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConsoleError("VALIDATION_ERROR");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const present = Object.keys(value);
  if (present.length !== keys.length || present.some((key) => !allowed.has(key))) {
    throw new ConsoleError("VALIDATION_ERROR");
  }
}

export function boundedString(value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw new ConsoleError("VALIDATION_ERROR");
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new ConsoleError("VALIDATION_ERROR");
  return normalized;
}

export function normalizeLoginInput(value: unknown): { email: string; password: string } {
  const input = record(value);
  exactKeys(input, ["email", "password"]);
  if (typeof input.email !== "string" || typeof input.password !== "string") throw new ConsoleError("VALIDATION_ERROR");
  return { email: input.email, password: input.password };
}

export function normalizeReservationInput(value: unknown): ReservationInput {
  const input = record(value);
  exactKeys(input, ["sku", "quantity", "orderReference", "confirmed"]);
  const quantity = input.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity)
    || quantity < 1 || quantity > MAX_RESERVED_QUANTITY) throw new ConsoleError("VALIDATION_ERROR");
  if (typeof input.confirmed !== "boolean") throw new ConsoleError("VALIDATION_ERROR");
  return {
    sku: boundedString(input.sku, 1, 64),
    quantity,
    orderReference: boundedString(input.orderReference, 3, 64),
    confirmed: input.confirmed,
  };
}

export function normalizeConfirmationRequest(value: unknown): ConfirmationRequest {
  const request = record(value);
  exactKeys(request, ["toolName", "input", "idempotencyKey"]);
  if (request.toolName !== RESERVE_TOOL_NAME) throw new ConsoleError("VALIDATION_ERROR");
  return {
    toolName: RESERVE_TOOL_NAME,
    input: normalizeReservationInput(request.input),
    idempotencyKey: normalizeIdempotencyKey(request.idempotencyKey, "VALIDATION_ERROR"),
  };
}

export function normalizeIdempotencyKey(
  value: unknown,
  failure: "VALIDATION_ERROR" | "IDEMPOTENCY_REQUIRED" = "IDEMPOTENCY_REQUIRED",
): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new ConsoleError(failure);
  }
  return value;
}

export function reservationFingerprint(input: ReservationInput): string {
  return JSON.stringify({ sku: input.sku, quantity: input.quantity, orderReference: input.orderReference });
}
