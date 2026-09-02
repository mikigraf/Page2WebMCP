/**
 * Every failure surfaces as a stable machine code and an HTTP status. Nothing
 * derived from a credential, a live URL, page content, or an upstream error
 * message is ever attached: the code is the whole public payload.
 */
export class GatewayError extends Error {
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "GatewayError";
    this.status = status;
  }
}

export function badRequest(code: string): GatewayError {
  return new GatewayError(code, 400);
}

export function unauthorized(code: string): GatewayError {
  return new GatewayError(code, 401);
}

export function forbidden(code: string): GatewayError {
  return new GatewayError(code, 403);
}

export function notFound(code: string): GatewayError {
  return new GatewayError(code, 404);
}

export function conflict(code: string): GatewayError {
  return new GatewayError(code, 409);
}

export function tooLarge(code: string): GatewayError {
  return new GatewayError(code, 413);
}

export function unavailable(code: string): GatewayError {
  return new GatewayError(code, 503);
}

export function gatewayStatus(error: unknown): number {
  return error instanceof GatewayError ? error.status : 500;
}

export function gatewayCode(error: unknown): string {
  return error instanceof GatewayError ? error.message : "GATEWAY_INTERNAL_ERROR";
}
