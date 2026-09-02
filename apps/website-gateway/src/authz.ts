import type { IncomingMessage } from "node:http";
import type { GatewayConfiguration } from "./config.ts";
import { CONTROL_NAMES, type ControlName } from "./constants.ts";
import { forbidden, notFound, unauthorized } from "./errors.ts";
import { secretEquals } from "./canonical.ts";

export function isControlName(value: unknown): value is ControlName {
  return typeof value === "string" && CONTROL_NAMES.includes(value as ControlName);
}

export function assertControlServed(configuration: GatewayConfiguration, control: ControlName): void {
  if (!configuration.controls.has(control)) throw notFound("GATEWAY_CONTROL_NOT_SERVED");
}

function presentedBearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) return undefined;
  return rest[0];
}

/**
 * Capability-scoped authorization. Each control owns exactly one credential and
 * a credential is only ever compared against the credential of the control that
 * owns the route being served, so no token can cross a scope boundary.
 */
export function authorizeControl(
  configuration: GatewayConfiguration,
  control: ControlName,
  request: IncomingMessage,
): void {
  assertControlServed(configuration, control);
  if (control === "browser-use-v4") {
    const presented = request.headers["x-browser-use-api-key"];
    if (typeof presented !== "string" || presented.length === 0) throw unauthorized("GATEWAY_CREDENTIAL_REQUIRED");
    if (!secretEquals(presented, configuration.browserUseApiKey)) throw forbidden("GATEWAY_CREDENTIAL_REJECTED");
    return;
  }
  const bearer = presentedBearer(request);
  if (bearer === undefined) throw unauthorized("GATEWAY_CREDENTIAL_REQUIRED");
  if (!secretEquals(bearer, configuration.tokens[control])) throw forbidden("GATEWAY_CREDENTIAL_REJECTED");
}
