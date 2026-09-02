import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createWebsiteGatewayServer } from "../src/server.ts";
import { loadWebsiteGatewayConfiguration } from "../src/config.ts";
import type { GatewayDependencies } from "../src/dependencies.ts";

export const TEST_KMS_KEY_ID = "kms://page2webmcp/browser-session-secrets";
export const TEST_TOKENS = Object.freeze({
  "authentication-handoff": "auth_handoff_control_token_abcdefghijklmnopqrstuvwxyz",
  "browser-lease-store": "browser_lease_control_token_abcdefghijklmnopqrstuvwxyz",
  "cdp-observer": "cdp_observer_control_token_abcdefghijklmnopqrstuvwxyz",
  "egress-policy-store": "egress_policy_control_token_abcdefghijklmnopqrstuvwxyz",
  "egress-proxy": "egress_proxy_control_token_abcdefghijklmnopqrstuvwxyz",
  "evidence-store": "evidence_store_control_token_abcdefghijklmnopqrstuvwxyz",
  "ownership-store": "ownership_store_control_token_abcdefghijklmnopqrstuvwxyz",
  "ttl-secret-store": "secret_store_control_token_abcdefghijklmnopqrstuvwxyz",
} as const);
export const TEST_BROWSER_USE_KEY = "bu_test_cloud_key_abcdefghijklmnopqrstuvwxyz";

export function testEnvironment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    PAGE2WEBMCP_GATEWAY_CONTROLS: [
      "authentication-handoff", "browser-lease-store", "browser-use-v4", "cdp-observer",
      "egress-policy-store", "egress-proxy", "evidence-store", "ownership-store", "ttl-secret-store",
    ].join(","),
    PAGE2WEBMCP_GATEWAY_BIND_ADDRESS: "127.0.0.1",
    PAGE2WEBMCP_GATEWAY_PORT: "0",
    PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_TOKEN: TEST_TOKENS["authentication-handoff"],
    PAGE2WEBMCP_GATEWAY_AUTH_HANDOFF_PUBLIC_ORIGIN: "https://auth-handoff.example",
    PAGE2WEBMCP_GATEWAY_BROWSER_LEASE_STORE_TOKEN: TEST_TOKENS["browser-lease-store"],
    PAGE2WEBMCP_GATEWAY_BROWSER_USE_API_KEY: TEST_BROWSER_USE_KEY,
    PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_API_KEY: "bu_upstream_key_abcdefghijklmnopqrstuvwxyz01",
    PAGE2WEBMCP_GATEWAY_BROWSER_USE_UPSTREAM_ORIGIN: "https://api.browser-use.com",
    PAGE2WEBMCP_GATEWAY_CDP_OBSERVER_TOKEN: TEST_TOKENS["cdp-observer"],
    PAGE2WEBMCP_GATEWAY_EGRESS_POLICY_TOKEN: TEST_TOKENS["egress-policy-store"],
    PAGE2WEBMCP_GATEWAY_EGRESS_PROXY_TOKEN: TEST_TOKENS["egress-proxy"],
    PAGE2WEBMCP_GATEWAY_EVIDENCE_STORE_TOKEN: TEST_TOKENS["evidence-store"],
    PAGE2WEBMCP_GATEWAY_OWNERSHIP_STORE_TOKEN: TEST_TOKENS["ownership-store"],
    PAGE2WEBMCP_GATEWAY_SECRET_STORE_TOKEN: TEST_TOKENS["ttl-secret-store"],
    PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_KEY_ID: TEST_KMS_KEY_ID,
    PAGE2WEBMCP_GATEWAY_SECRET_STORE_KMS_ROOT_KEY: randomBytes(32).toString("base64"),
    ...overrides,
  };
}

export type GatewayHarness = Readonly<{
  origin: string;
  close(): Promise<void>;
  json(path: string, body: unknown, options?: Readonly<{
    token?: string; apiKey?: string; headers?: Record<string, string>;
  }>): Promise<Readonly<{ status: number; body: Record<string, unknown> | undefined; raw: string }>>;
  readiness(control: string, options?: Readonly<{
    token?: string; apiKey?: string; releaseHash?: string; nonce?: string; kmsKeyIdDigest?: string;
  }>): Promise<Readonly<{ status: number; body: Record<string, unknown> | undefined }>>;
  get(path: string): Promise<Readonly<{ status: number; text: string; contentType: string | null }>>;
}>;

export async function startGateway(
  environment: Readonly<Record<string, string>> = testEnvironment(),
  dependencies: GatewayDependencies = {},
): Promise<GatewayHarness> {
  const configuration = loadWebsiteGatewayConfiguration(environment);
  const server = createWebsiteGatewayServer(configuration, dependencies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))),
    json: async (path, body, options = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      if (options.apiKey) headers["x-browser-use-api-key"] = options.apiKey;
      const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      const raw = await response.text();
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = undefined; }
      return { status: response.status, body: parsed, raw };
    },
    readiness: async (control, options = {}) => {
      const headers: Record<string, string> = {
        accept: "application/json",
        "x-page2webmcp-control": control,
        "x-page2webmcp-gateway-version": "1",
        "x-page2webmcp-readiness-nonce": options.nonce ?? "c".repeat(64),
        "x-page2webmcp-release-hash": options.releaseHash ?? "a".repeat(64),
      };
      if (control === "browser-use-v4") headers["x-browser-use-api-key"] = options.apiKey ?? TEST_BROWSER_USE_KEY;
      else headers.authorization = `Bearer ${options.token ?? TEST_TOKENS[control as keyof typeof TEST_TOKENS]}`;
      if (control === "ttl-secret-store") {
        headers["x-page2webmcp-kms-key-id-digest"] = options.kmsKeyIdDigest
          ?? createHash("sha256").update(TEST_KMS_KEY_ID, "utf8").digest("hex");
      }
      const response = await fetch(`${origin}/v1/readiness`, { headers });
      const raw = await response.text();
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = undefined; }
      return { status: response.status, body: parsed };
    },
    get: async (path) => {
      const response = await fetch(`${origin}${path}`);
      return {
        status: response.status,
        text: await response.text(),
        contentType: response.headers.get("content-type"),
      };
    },
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const OWNERSHIP = Object.freeze({
  organizationId: "org-1",
  projectId: "project-1",
  runId: "run-1",
});

export function envelope(operation: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    gatewayProtocolVersion: 1,
    idempotencyKey: `website:${OWNERSHIP.runId}:1:${operation}:${sha256Hex(canonicalJson(payload))}`,
    ownership: OWNERSHIP,
    ...payload,
  };
}
