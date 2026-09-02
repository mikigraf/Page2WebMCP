import { CONTROL_NAMES, type ControlName } from "./constants.ts";
import { GatewayError } from "./errors.ts";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type GatewayConfiguration = Readonly<{
  controls: ReadonlySet<ControlName>;
  bindAddress: string;
  port: number;
  tokens: Readonly<Partial<Record<ControlName, string>>>;
  browserUseApiKey?: string;
  browserUseUpstreamApiKey?: string;
  browserUseUpstreamOrigin?: string;
  browserUsePeerOrigin?: string;
  browserUsePeerApiKey?: string;
  authHandoffPublicOrigin?: string;
  kmsKeyId?: string;
  kmsRootKey?: Buffer;
}>;

const ALWAYS_REQUIRED = [
  "PAGE2WEBMCP_GATEWAY_CONTROLS",
  "PAGE2WEBMCP_GATEWAY_BIND_ADDRESS",
  "PAGE2WEBMCP_GATEWAY_PORT",
] as const;

const CONTROL_TOKEN_KEYS: Readonly<Record<ControlName, string | undefined>> = Object.freeze({
  "authentication-handoff": "PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_TOKEN",
  "browser-lease-store": "PAGE2WEBMCP_GATEWAY_BROWSER_LEASE_STORE_TOKEN",
  "browser-use-v4": undefined,
  "cdp-observer": "PAGE2WEBMCP_GATEWAY_CDP_OBSERVER_TOKEN",
  "egress-policy-store": "PAGE2WEBMCP_GATEWAY_EGRESS_POLICY_TOKEN",
  "egress-proxy": "PAGE2WEBMCP_GATEWAY_EGRESS_PROXY_TOKEN",
  "evidence-store": "PAGE2WEBMCP_GATEWAY_EVIDENCE_STORE_TOKEN",
  "ownership-store": "PAGE2WEBMCP_GATEWAY_OWNERSHIP_STORE_TOKEN",
  "ttl-secret-store": "PAGE2WEBMCP_GATEWAY_SECRET_STORE_TOKEN",
});

const EXTRA_KEYS_BY_CONTROL: Readonly<Record<ControlName, readonly string[]>> = Object.freeze({
  "authentication-handoff": ["PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_PUBLIC_ORIGIN"],
  "browser-lease-store": [],
  "browser-use-v4": [
    "PAGE2WEBMCP_GATEWAY_BROWSER_USE_API_KEY",
    "PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_API_KEY",
    "PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_ORIGIN",
  ],
  "cdp-observer": [],
  "egress-policy-store": [],
  "egress-proxy": [],
  "evidence-store": [],
  "ownership-store": [],
  "ttl-secret-store": [
    "PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_KEY_ID",
    "PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_ROOT_KEY",
  ],
});

const OPTIONAL_KEYS = [
  "PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_ORIGIN",
  "PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_API_KEY",
] as const;

function boundedToken(value: string | undefined): boolean {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && /^[!-~]+$/.test(value);
}

function browserUseKey(value: string | undefined): boolean {
  return boundedToken(value) && /^bu_[A-Za-z0-9_-]+$/.test(value as string);
}

function exactHttpsOrigin(value: string | undefined): boolean {
  if (!value || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.origin === value && url.href === `${value}/`;
  } catch { return false; }
}

function kmsRootKey(value: string | undefined): Buffer | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 ? decoded : undefined;
}

function parsedControls(value: string | undefined): ControlName[] | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  const names = value.split(",").map((entry) => entry.trim());
  if (names.length === 0 || names.some((name) => !CONTROL_NAMES.includes(name as ControlName))) return undefined;
  return [...new Set(names)] as ControlName[];
}

function validateKey(key: string, environment: RuntimeEnvironment): boolean {
  const value = environment[key];
  switch (key) {
    case "PAGE2WEBMCP_GATEWAY_CONTROLS":
      return parsedControls(value) !== undefined;
    case "PAGE2WEBMCP_GATEWAY_BIND_ADDRESS":
      return typeof value === "string" && value.length > 0 && value.length <= 255;
    case "PAGE2WEBMCP_GATEWAY_PORT":
      return typeof value === "string" && /^\d{1,5}$/.test(value) && Number(value) <= 65_535;
    case "PAGE2WEBMCP_GATEWAY_BROWSER_USE_API_KEY":
    case "PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_API_KEY":
    case "PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_API_KEY":
      return browserUseKey(value);
    case "PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_ORIGIN":
    case "PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_ORIGIN":
    case "PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_PUBLIC_ORIGIN":
      return exactHttpsOrigin(value);
    case "PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_KEY_ID":
      return typeof value === "string" && value.length >= 1 && value.length <= 512
        && /^[!-~]+$/.test(value);
    case "PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_ROOT_KEY":
      return kmsRootKey(value) !== undefined;
    default:
      return boundedToken(value);
  }
}

export function websiteGatewayRequiredKeys(environment: RuntimeEnvironment): string[] {
  const controls = parsedControls(environment.PAGE2WEBMCP_GATEWAY_CONTROLS) ?? [];
  const keys = new Set<string>(ALWAYS_REQUIRED);
  for (const control of controls) {
    const tokenKey = CONTROL_TOKEN_KEYS[control];
    if (tokenKey) keys.add(tokenKey);
    for (const extra of EXTRA_KEYS_BY_CONTROL[control]) keys.add(extra);
  }
  return [...keys].sort();
}

/**
 * Operator-only surface: the sorted names of every configuration value that is
 * absent or malformed. Values are never echoed, only names.
 */
export function websiteGatewayMissingConfiguration(environment: RuntimeEnvironment): string[] {
  const invalid = new Set<string>();
  for (const key of websiteGatewayRequiredKeys(environment)) {
    if (!validateKey(key, environment)) invalid.add(key);
  }
  for (const key of OPTIONAL_KEYS) {
    if (environment[key] !== undefined && !validateKey(key, environment)) invalid.add(key);
  }
  const peerOrigin = environment.PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_ORIGIN;
  const peerKey = environment.PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_API_KEY;
  if ((peerOrigin === undefined) !== (peerKey === undefined)) {
    invalid.add("PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_API_KEY");
    invalid.add("PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_ORIGIN");
  }
  return [...invalid].sort();
}

export function loadWebsiteGatewayConfiguration(environment: RuntimeEnvironment): GatewayConfiguration {
  const missing = websiteGatewayMissingConfiguration(environment);
  if (missing.length > 0) throw new GatewayError("WEBSITE_GATEWAY_CONFIGURATION_REQUIRED", 500);
  const controls = new Set(parsedControls(environment.PAGE2WEBMCP_GATEWAY_CONTROLS)!);
  const tokens: Partial<Record<ControlName, string>> = {};
  for (const control of controls) {
    const key = CONTROL_TOKEN_KEYS[control];
    if (key) tokens[control] = environment[key]!;
  }
  return Object.freeze({
    controls,
    bindAddress: environment.PAGE2WEBMCP_GATEWAY_BIND_ADDRESS!,
    port: Number(environment.PAGE2WEBMCP_GATEWAY_PORT),
    tokens: Object.freeze(tokens),
    browserUseApiKey: environment.PAGE2WEBMCP_GATEWAY_BROWSER_USE_API_KEY,
    browserUseUpstreamApiKey: environment.PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_API_KEY,
    browserUseUpstreamOrigin: environment.PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_ORIGIN,
    browserUsePeerOrigin: environment.PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_ORIGIN,
    browserUsePeerApiKey: environment.PAGE2WEBMCP_GATEWAY_BROWSER_USE_PEER_API_KEY,
    authHandoffPublicOrigin: environment.PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_PUBLIC_ORIGIN,
    kmsKeyId: environment.PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_KEY_ID,
    kmsRootKey: kmsRootKey(environment.PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_ROOT_KEY),
  });
}
