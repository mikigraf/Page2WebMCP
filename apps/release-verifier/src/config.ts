/**
 * Startup configuration for the reference release verifier.
 *
 * Every value comes from an environment variable. Nothing is inferred from a request, and no
 * default silently weakens a boundary: the allowlist, the loopback exception, and the browser
 * settings must all be stated by the operator. Secrets are read but never echoed in an error.
 */

const REQUIRED_NAMES = [
  "PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS",
  "PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS",
  "PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS",
  "PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN",
  "PAGE2WEBMCP_RELEASE_VERIFIER_PORT",
  "PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH",
  "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
] as const;

const DEFAULT_MODEL_ORIGINS = [
  "https://api.anthropic.com",
  "https://api.openai.com",
  "https://generativelanguage.googleapis.com",
] as const;

const HASH = /^[0-9a-f]{64}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export type VerifierSessionCookie = Readonly<{
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}>;

export type VerifierExecutionStep = Readonly<{
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}>;

export type VerifierExecutionPlan = Readonly<{
  read: VerifierExecutionStep;
  mutation: VerifierExecutionStep;
  finalState: VerifierExecutionStep;
}>;

export type VerifierConfig = Readonly<{
  bindAddress: string;
  port: number;
  token: string;
  mode: "live" | "local_live";
  allowedTargetOrigins: readonly string[];
  allowLoopbackTargets: boolean;
  controlPlaneOrigin: string;
  artifactOrigin?: string;
  modelOrigins: readonly string[];
  acceptedDeploymentIdentityDigests: readonly string[];
  browser: Readonly<{ headless: boolean; executablePath?: string; blinkFeatures: readonly string[] }>;
  timeouts: Readonly<{ navigationMs: number; totalRequestMs: number; toolMs: number }>;
  limits: Readonly<{ maxArtifactBytes: number; maxResponseBytes: number; replayEntries: number }>;
  replayStorePath: string;
  targetSessionCookies: readonly VerifierSessionCookie[];
  executionPlan?: VerifierExecutionPlan;
}>;

export function loadVerifierConfig(environment: Record<string, string | undefined>): VerifierConfig {
  const missing = REQUIRED_NAMES.filter((name) => environment[name] === undefined).sort();
  if (missing.length > 0) {
    throw new Error(`RELEASE_VERIFIER_CONFIGURATION_REQUIRED: ${missing.join(", ")}`);
  }
  const bindAddress = requiredText("PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS", environment, /^[A-Za-z0-9.:_-]{1,255}$/);
  const port = boundedInteger("PAGE2WEBMCP_RELEASE_VERIFIER_PORT", environment, 0, 65_535);
  const token = requiredText("PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN", environment, /^[!-~]{32,4096}$/);
  const allowLoopbackTargets = optionalBoolean(
    "PAGE2WEBMCP_RELEASE_VERIFIER_ALLOW_LOOPBACK_TARGETS", environment, false,
  );
  const allowedTargetOrigins = originList(
    "PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS", environment, allowLoopbackTargets, true,
  );
  const controlPlaneOrigin = originList(
    "PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN", environment, true, true,
  )[0]!;
  const modelOrigins = environment.PAGE2WEBMCP_RELEASE_VERIFIER_MODEL_ORIGINS === undefined
    ? [...DEFAULT_MODEL_ORIGINS]
    : originList("PAGE2WEBMCP_RELEASE_VERIFIER_MODEL_ORIGINS", environment, true, false);
  return Object.freeze({
    bindAddress,
    port,
    token,
    mode: enumeration("PAGE2WEBMCP_RELEASE_VERIFIER_MODE", environment, ["live", "local_live"], "live"),
    allowedTargetOrigins: Object.freeze(allowedTargetOrigins),
    allowLoopbackTargets,
    controlPlaneOrigin,
    ...(environment.PAGE2WEBMCP_RELEASE_VERIFIER_ARTIFACT_ORIGIN === undefined
      ? {}
      : { artifactOrigin: originList("PAGE2WEBMCP_RELEASE_VERIFIER_ARTIFACT_ORIGIN", environment, true, true)[0]! }),
    modelOrigins: Object.freeze(modelOrigins),
    acceptedDeploymentIdentityDigests: Object.freeze(digestList(
      "PAGE2WEBMCP_RELEASE_VERIFIER_DEPLOYMENT_IDENTITY_DIGESTS", environment,
    )),
    browser: Object.freeze({
      headless: requiredBoolean("PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS", environment),
      ...(environment.PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_EXECUTABLE_PATH
        ? { executablePath: environment.PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_EXECUTABLE_PATH }
        : {}),
      blinkFeatures: Object.freeze(blinkFeatures(environment)),
    }),
    timeouts: Object.freeze({
      navigationMs: optionalInteger("PAGE2WEBMCP_RELEASE_VERIFIER_NAVIGATION_TIMEOUT_MS", environment, 30_000, 1_000, 60_000),
      totalRequestMs: optionalInteger("PAGE2WEBMCP_RELEASE_VERIFIER_REQUEST_TIMEOUT_MS", environment, 55_000, 5_000, 110_000),
      toolMs: optionalInteger("PAGE2WEBMCP_RELEASE_VERIFIER_TOOL_TIMEOUT_MS", environment, 15_000, 1_000, 60_000),
    }),
    limits: Object.freeze({
      maxArtifactBytes: optionalInteger("PAGE2WEBMCP_RELEASE_VERIFIER_MAX_ARTIFACT_BYTES", environment, 65_536, 1_024, 262_144),
      maxResponseBytes: optionalInteger("PAGE2WEBMCP_RELEASE_VERIFIER_MAX_RESPONSE_BYTES", environment, 262_144, 1_024, 1_048_576),
      replayEntries: optionalInteger("PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_ENTRIES", environment, 4_096, 16, 65_536),
    }),
    replayStorePath: environment.PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH!.trim(),
    targetSessionCookies: Object.freeze(sessionCookies(environment)),
    ...executionPlan(environment),
  });
}

export function targetOriginAllowed(config: VerifierConfig, origin: string): boolean {
  if (!config.allowedTargetOrigins.includes(origin)) return false;
  return secureTargetOrigin(origin, config.allowLoopbackTargets);
}

export function secureTargetOrigin(origin: string, allowLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (!allowLoopback || url.protocol !== "http:") return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

/**
 * Blink runtime features the observation browser must enable. WebMCP is a flagged feature in
 * current Chromium, so without it `document.modelContext` is absent on every page and the honest
 * observation would always be "not native". Naming it here keeps the flag an explicit operator
 * decision and lets it be dropped or renamed as the feature ships, without touching the
 * observation code. An empty value means "launch with no extra features".
 */
function blinkFeatures(environment: Record<string, string | undefined>): string[] {
  const raw = environment.PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_BLINK_FEATURES;
  if (raw === undefined) return ["WebMCP"];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const features = trimmed.split(",").map((feature) => feature.trim());
  if (features.some((feature) => !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(feature))) {
    invalid("PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_BLINK_FEATURES");
  }
  return [...new Set(features)].sort();
}

function invalid(name: string): never {
  throw new Error(`RELEASE_VERIFIER_CONFIGURATION_INVALID: ${name}`);
}

function requiredText(name: string, environment: Record<string, string | undefined>, pattern: RegExp): string {
  const value = environment[name] ?? "";
  return pattern.test(value) ? value : invalid(name);
}

function boundedInteger(
  name: string,
  environment: Record<string, string | undefined>,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name] ?? "";
  if (!/^\d{1,7}$/.test(raw)) invalid(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) invalid(name);
  return value;
}

function optionalInteger(
  name: string,
  environment: Record<string, string | undefined>,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (environment[name] === undefined) return fallback;
  const value = boundedInteger(name, environment, minimum, maximum);
  return value;
}

function requiredBoolean(name: string, environment: Record<string, string | undefined>): boolean {
  const value = environment[name];
  if (value !== "true" && value !== "false") invalid(name);
  return value === "true";
}

function optionalBoolean(
  name: string,
  environment: Record<string, string | undefined>,
  fallback: boolean,
): boolean {
  if (environment[name] === undefined) return fallback;
  return requiredBoolean(name, environment);
}

function enumeration<Value extends string>(
  name: string,
  environment: Record<string, string | undefined>,
  allowed: readonly Value[],
  fallback: Value,
): Value {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (!allowed.includes(value as Value)) invalid(name);
  return value as Value;
}

function originList(
  name: string,
  environment: Record<string, string | undefined>,
  allowLoopback: boolean,
  required: boolean,
): string[] {
  const raw = (environment[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (raw.length === 0) {
    if (required) invalid(name);
    return [];
  }
  if (raw.length > 32) invalid(name);
  for (const origin of raw) if (!secureTargetOrigin(origin, allowLoopback)) invalid(name);
  return [...new Set(raw)].sort();
}

function digestList(name: string, environment: Record<string, string | undefined>): string[] {
  const raw = (environment[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (raw.length > 32) invalid(name);
  for (const digest of raw) if (!HASH.test(digest)) invalid(name);
  return [...new Set(raw)].sort();
}

function sessionCookies(environment: Record<string, string | undefined>): VerifierSessionCookie[] {
  const name = "PAGE2WEBMCP_RELEASE_VERIFIER_TARGET_SESSION_COOKIES";
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid(name);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) invalid(name);
  return parsed.map((entry) => {
    if (!record(entry) || typeof entry.name !== "string" || typeof entry.value !== "string"
      || typeof entry.domain !== "string" || typeof entry.path !== "string"
      || !/^[!-~]{1,256}$/.test(entry.name) || entry.value.length > 4_096) invalid(name);
    return Object.freeze({
      name: entry.name,
      value: entry.value,
      domain: entry.domain,
      path: entry.path,
      ...(typeof entry.httpOnly === "boolean" ? { httpOnly: entry.httpOnly } : {}),
      ...(typeof entry.secure === "boolean" ? { secure: entry.secure } : {}),
      ...(entry.sameSite === "Strict" || entry.sameSite === "Lax" || entry.sameSite === "None"
        ? { sameSite: entry.sameSite }
        : {}),
    });
  });
}

function executionPlan(
  environment: Record<string, string | undefined>,
): Readonly<{ executionPlan?: VerifierExecutionPlan }> {
  const name = "PAGE2WEBMCP_RELEASE_VERIFIER_EXECUTION_PLAN";
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid(name);
  }
  if (!record(parsed)) invalid(name);
  const plan = {
    read: executionStep(name, parsed.read),
    mutation: executionStep(name, parsed.mutation),
    finalState: executionStep(name, parsed.finalState),
  };
  if (plan.read.toolName === plan.mutation.toolName) invalid(name);
  return { executionPlan: Object.freeze(plan) };
}

function executionStep(name: string, value: unknown): VerifierExecutionStep {
  if (!record(value) || typeof value.toolName !== "string" || !TOOL_NAME.test(value.toolName)
    || !record(value.input)) invalid(name);
  return Object.freeze({ toolName: value.toolName as string, input: Object.freeze({ ...value.input as object }) });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
