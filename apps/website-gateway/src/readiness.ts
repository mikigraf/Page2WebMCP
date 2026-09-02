import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfiguration } from "./config.ts";
import type { BrowserUseUpstream } from "./dependencies.ts";
import {
  AUTHENTICATION_CHECKPOINT_PROTOCOL_VERSION,
  AUTHENTICATION_USER_HANDOFF_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  HEX64,
  SOURCE_ATTESTATION_PROTOCOL_VERSION,
} from "./constants.ts";
import { authorizeControl, isControlName } from "./authz.ts";
import { badRequest, forbidden, unavailable } from "./errors.ts";
import { respondJson } from "./http/respond.ts";
import { secretEquals, sha256Hex } from "./canonical.ts";

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The readiness contract the worker validates byte for byte. Everything echoed
 * here is either a constant this build implements or a value the caller sent,
 * except the Browser Use upstream block, which is only emitted after this
 * process has authenticated against the real upstream.
 */
export async function handleReadiness(
  configuration: GatewayConfiguration,
  upstream: BrowserUseUpstream | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const control = header(request, "x-page2webmcp-control");
  if (!isControlName(control)) throw badRequest("GATEWAY_CONTROL_UNKNOWN");
  authorizeControl(configuration, control, request);
  if (header(request, "x-page2webmcp-gateway-version") !== String(GATEWAY_PROTOCOL_VERSION)) {
    throw badRequest("GATEWAY_PROTOCOL_VERSION_UNSUPPORTED");
  }
  const nonce = header(request, "x-page2webmcp-readiness-nonce");
  // The release hash identifies the caller's selected release. This service
  // cannot verify a hash it did not build, so it only bounds its shape and
  // echoes it; it never claims to have validated the release itself.
  const selectedReleaseHash = header(request, "x-page2webmcp-release-hash");
  if (!nonce || !HEX64.test(nonce)) throw badRequest("GATEWAY_READINESS_NONCE_INVALID");
  if (!selectedReleaseHash || !HEX64.test(selectedReleaseHash)) throw badRequest("GATEWAY_RELEASE_HASH_INVALID");

  const extra: Record<string, unknown> = {};
  if (control === "authentication-handoff") {
    extra.authenticationCheckpointProtocolVersion = AUTHENTICATION_CHECKPOINT_PROTOCOL_VERSION;
    extra.authenticationUserHandoffProtocolVersion = AUTHENTICATION_USER_HANDOFF_PROTOCOL_VERSION;
  }
  if (control === "ownership-store") extra.sourceAttestationProtocolVersion = SOURCE_ATTESTATION_PROTOCOL_VERSION;
  if (control === "ttl-secret-store") {
    const digest = sha256Hex(configuration.kmsKeyId ?? "");
    if (!secretEquals(header(request, "x-page2webmcp-kms-key-id-digest"), digest)) {
      throw forbidden("GATEWAY_KMS_KEY_MISMATCH");
    }
    extra.kmsKeyIdDigest = digest;
  }
  if (control === "browser-use-v4") {
    if (!upstream) throw unavailable("GATEWAY_BROWSER_USE_UPSTREAM_UNAVAILABLE");
    let attested;
    try { attested = await upstream.verifyCredentials(); }
    catch { throw unavailable("GATEWAY_BROWSER_USE_UPSTREAM_UNAVAILABLE"); }
    if (attested?.apiVersion !== "v4" || attested.authenticated !== true || attested.model !== "browser-use-2.0") {
      throw unavailable("GATEWAY_BROWSER_USE_UPSTREAM_UNAVAILABLE");
    }
    extra.gateway = "page2webmcp-browser-use-v4";
    extra.upstream = { apiVersion: "v4", authenticated: true, model: "browser-use-2.0" };
  }
  respondJson(response, 200, {
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    status: "ready",
    readOnly: true,
    control,
    selectedReleaseHash,
    nonce,
    ...extra,
  });
}
