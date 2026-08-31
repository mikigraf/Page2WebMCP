import {
  RELEASE_VERIFICATION_CHECK_NAMES,
  type ReleaseVerificationCheckName as CandidateVerificationCheckName,
  type ReleaseVerificationCheckRecord as ReleaseVerificationCheck,
  type ReleaseVerificationFailureCode,
} from "../../../packages/database/src/control-plane.ts";

const HASH = /^[0-9a-f]{64}$/;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const MAX_REPORT_BYTES = 64 * 1_024;
const VERIFICATION_DEADLINE_MS = 120_000;

export const REQUIRED_CANDIDATE_CHECKS = RELEASE_VERIFICATION_CHECK_NAMES;
export type { CandidateVerificationCheckName, ReleaseVerificationCheck, ReleaseVerificationFailureCode };

export type CandidateVerificationInput = Readonly<{
  code: string;
  contentHash: string;
  integrity: string;
  manifest: Readonly<{ releaseId: string }> & Record<string, unknown>;
  targetOrigin: string;
  expectedTools: readonly string[];
}>;

export type CandidateVerificationReport = Readonly<{
  observedContentHash: string;
  observedIntegrity: string;
  observedReleaseId: string;
  observedTargetOrigin: string;
  registeredTools: readonly string[];
  trustedLoader: Readonly<{ enforcedBeforeEvaluation: boolean; evaluatedContentHash: string }>;
  controlPlaneRequestsDuringExecution: number;
  modelRequestsDuringExecution: number;
  checks: readonly ReleaseVerificationCheck[];
  csp: Readonly<{ hosted: "allowed" | "blocked"; directive?: string }>;
}>;

export type InstalledVerificationInput = Readonly<{
  pageUrl: string;
  artifactUrl: string;
  downloadUrl: string;
  localOnly: boolean;
  contentHash: string;
  integrity: string;
  manifest: unknown;
  targetOrigin: string;
  expectedTools: readonly string[];
  selfHostedUrl?: string;
}>;

export type InstalledVerificationReport = Readonly<{
  observedArtifactUrl: string;
  observedDownloadUrl: string;
  observedLocalOnly: boolean;
  observedIntegrity: string;
  executedArtifactUrl: string | null;
  servedContentHash: string;
  executedContentHash: string | null;
  observedTargetOrigin: string;
  registeredTools: readonly string[];
  webMcpImplementation: "native" | "compatibility_shim";
  normalPageLoad: boolean;
  routeInterception: boolean;
  injectedRegistration: boolean;
  syntheticHarness: boolean;
  duplicateLoadHarmless: boolean | null;
  csp: Readonly<{ hosted: "allowed" | "blocked"; directive?: string }>;
}>;

export type InstalledAttestation = Readonly<{
  status: "verified" | "pending_self_host";
  delivery: "hosted" | "self_hosted";
  csp: InstalledVerificationReport["csp"];
  webMcpImplementation: InstalledVerificationReport["webMcpImplementation"];
  report: InstalledVerificationReport;
}>;

export interface ReleaseVerificationPort {
  readonly mode: "live" | "hermetic";
  verifyCandidate(input: CandidateVerificationInput, signal: AbortSignal): Promise<CandidateVerificationReport>;
  verifyInstalled(input: InstalledVerificationInput, signal: AbortSignal): Promise<InstalledVerificationReport>;
}

export type CandidateAttestation = Readonly<{
  schema: boolean;
  authenticated: boolean;
  replayPasses: number;
  noSecretLeakage: boolean;
  browserExecution: boolean;
  selectionScore: number;
  checks: readonly ReleaseVerificationCheck[];
  csp: CandidateVerificationReport["csp"];
  verificationMode: ReleaseVerificationPort["mode"];
}>;

let testPort: ReleaseVerificationPort | undefined;

export function setReleaseVerificationPortForTest(port: ReleaseVerificationPort | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_ADAPTER_FORBIDDEN");
  testPort = port;
}

export function releaseVerificationPort(): ReleaseVerificationPort {
  return testPort ?? configuredReleaseVerificationPort(process.env);
}

export async function attestReleaseCandidate(
  input: CandidateVerificationInput,
  port: ReleaseVerificationPort,
  signal: AbortSignal,
): Promise<CandidateAttestation> {
  assertCandidateInput(input);
  const report = await withDeadline((deadlineSignal) => port.verifyCandidate(input, deadlineSignal), signal);
  if (!report || typeof report !== "object"
    || report.observedContentHash !== input.contentHash
    || report.observedIntegrity !== input.integrity
    || report.observedReleaseId !== input.manifest.releaseId
    || report.observedTargetOrigin !== input.targetOrigin
    || !equalStrings(report.registeredTools, input.expectedTools)
    || report.trustedLoader?.enforcedBeforeEvaluation !== true
    || report.trustedLoader.evaluatedContentHash !== input.contentHash
    || report.controlPlaneRequestsDuringExecution !== 0
    || report.modelRequestsDuringExecution !== 0) {
    throw new Error("CANDIDATE_VERIFICATION_INVALID");
  }
  const checks = normalizeChecks(report.checks);
  const passed = new Set(checks.filter(({ status }) => status === "passed").map(({ name }) => name));
  const allPassed = passed.size === REQUIRED_CANDIDATE_CHECKS.length;
  if (!report.csp || !["allowed", "blocked"].includes(report.csp.hosted)
    || report.csp.directive !== undefined && !safeDirective(report.csp.directive)) {
    throw new Error("CANDIDATE_VERIFICATION_INVALID");
  }
  return {
    schema: passed.has("schema") && passed.has("trusted_loader"),
    authenticated: passed.has("authentication") && passed.has("origin"),
    replayPasses: passed.has("replay_idempotency") ? 3 : 0,
    noSecretLeakage: passed.has("secret_leakage") && passed.has("no_control_plane_or_model_calls"),
    browserExecution: allPassed,
    selectionScore: passed.has("tool_selection") ? 20 : 0,
    checks,
    csp: { hosted: report.csp.hosted, ...(report.csp.directive ? { directive: report.csp.directive } : {}) },
    verificationMode: port.mode,
  };
}

export async function attestReleaseInstallation(
  input: InstalledVerificationInput,
  port: ReleaseVerificationPort,
  signal: AbortSignal,
): Promise<InstalledAttestation> {
  assertInstalledInput(input, port.mode);
  const report = await withDeadline((deadlineSignal) => port.verifyInstalled(input, deadlineSignal), signal);
  if (!report || typeof report !== "object"
    || report.observedArtifactUrl !== input.artifactUrl
    || report.observedDownloadUrl !== input.downloadUrl
    || report.observedLocalOnly !== input.localOnly
    || report.observedIntegrity !== input.integrity
    || report.servedContentHash !== input.contentHash
    || report.observedTargetOrigin !== input.targetOrigin
    || report.normalPageLoad !== true
    || report.routeInterception !== false
    || report.injectedRegistration !== false
    || report.syntheticHarness !== false
    || !["native", "compatibility_shim"].includes(report.webMcpImplementation)
    || !report.csp || !["allowed", "blocked"].includes(report.csp.hosted)
    || report.csp.directive !== undefined && !safeDirective(report.csp.directive)) {
    throw new Error("INSTALLED_VERIFICATION_INVALID");
  }
  const pendingSelfHost = !input.selfHostedUrl && report.csp.hosted === "blocked";
  if (pendingSelfHost) {
    if (report.executedArtifactUrl !== null || report.executedContentHash !== null
      || !Array.isArray(report.registeredTools) || report.registeredTools.length !== 0
      || report.duplicateLoadHarmless !== null) {
      throw new Error("INSTALLED_VERIFICATION_INVALID");
    }
  } else if (report.executedArtifactUrl !== (input.selfHostedUrl ?? input.artifactUrl)
    || report.executedContentHash !== input.contentHash
    || !equalStrings(report.registeredTools, input.expectedTools)
    || report.duplicateLoadHarmless !== true) {
    throw new Error("INSTALLED_VERIFICATION_INVALID");
  }
  if (port.mode === "live" && report.webMcpImplementation !== "native") {
    throw new Error("WEBMCP_NATIVE_REQUIRED");
  }
  const normalizedReport = normalizeInstalledReport(report);
  if (pendingSelfHost) {
    return {
      status: "pending_self_host",
      delivery: "hosted",
      csp: normalizedCsp(report.csp),
      webMcpImplementation: report.webMcpImplementation,
      report: normalizedReport,
    };
  }
  return {
    status: "verified",
    delivery: input.selfHostedUrl ? "self_hosted" : "hosted",
    csp: normalizedCsp(report.csp),
    webMcpImplementation: report.webMcpImplementation,
    report: normalizedReport,
  };
}

export function configuredReleaseVerificationPort(
  environment: Record<string, string | undefined>,
  dependencies: Readonly<{ fetch?: typeof fetch }> = {},
): ReleaseVerificationPort {
  const origin = exactHttpsOrigin(environment.PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN);
  const token = environment.PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN;
  if (!origin || !token || token.length < 32 || token.length > 512) {
    throw new Error("RELEASE_VERIFIER_CONFIGURATION_REQUIRED");
  }
  const transport = dependencies.fetch ?? fetch;
  const request = async <T>(path: string, body: unknown, signal: AbortSignal): Promise<T> => {
    const url = `${origin}${path}`;
    const response = await transport(url, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.url !== url || response.status !== 200
      || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_REPORT_BYTES) throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
    try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID"); }
  };
  return {
    mode: "live",
    verifyCandidate: (input, signal) => request("/v1/candidates/verify", input, signal),
    verifyInstalled: (input, signal) => request("/v1/installations/verify", input, signal),
  };
}

function assertCandidateInput(input: CandidateVerificationInput): void {
  if (!input || typeof input.code !== "string" || Buffer.byteLength(input.code) > 65_536
    || !HASH.test(input.contentHash) || !SRI.test(input.integrity)
    || !HASH.test(input.manifest?.releaseId) || exactHttpsOrigin(input.targetOrigin) !== input.targetOrigin
    || !validTools(input.expectedTools)) throw new Error("CANDIDATE_VERIFICATION_INVALID");
}

function assertInstalledInput(input: InstalledVerificationInput, mode: ReleaseVerificationPort["mode"]): void {
  const targetOrigin = exactHttpsOrigin(input.targetOrigin);
  let page: URL;
  try {
    page = new URL(input.pageUrl);
  } catch {
    throw new Error("INSTALLED_VERIFICATION_INVALID");
  }
  const prefix = input.localOnly
    ? "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases"
    : "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
  const artifactUrl = `${prefix}/${input.contentHash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${input.contentHash}.js`;
  if (!targetOrigin || page.origin !== targetOrigin || page.username || page.password || page.search || page.hash
    || typeof input.localOnly !== "boolean" || mode === "live" && input.localOnly
    || input.artifactUrl !== artifactUrl || input.downloadUrl !== downloadUrl
    || !HASH.test(input.contentHash) || !SRI.test(input.integrity) || !validTools(input.expectedTools)) {
    throw new Error("INSTALLED_VERIFICATION_INVALID");
  }
  if (input.selfHostedUrl) {
    try {
      const selfHosted = new URL(input.selfHostedUrl);
      if (selfHosted.origin !== targetOrigin || selfHosted.username || selfHosted.password
        || selfHosted.search || selfHosted.hash) {
        throw new Error("INSTALLED_VERIFICATION_INVALID");
      }
    } catch {
      throw new Error("INSTALLED_VERIFICATION_INVALID");
    }
  }
}

function normalizeInstalledReport(report: InstalledVerificationReport): InstalledVerificationReport {
  return {
    observedArtifactUrl: report.observedArtifactUrl,
    observedDownloadUrl: report.observedDownloadUrl,
    observedLocalOnly: report.observedLocalOnly,
    observedIntegrity: report.observedIntegrity,
    executedArtifactUrl: report.executedArtifactUrl,
    servedContentHash: report.servedContentHash,
    executedContentHash: report.executedContentHash,
    observedTargetOrigin: report.observedTargetOrigin,
    registeredTools: [...report.registeredTools].sort(compareStrings),
    webMcpImplementation: report.webMcpImplementation,
    normalPageLoad: report.normalPageLoad,
    routeInterception: report.routeInterception,
    injectedRegistration: report.injectedRegistration,
    syntheticHarness: report.syntheticHarness,
    duplicateLoadHarmless: report.duplicateLoadHarmless,
    csp: normalizedCsp(report.csp),
  };
}

function normalizedCsp(csp: InstalledVerificationReport["csp"]): InstalledVerificationReport["csp"] {
  return { hosted: csp.hosted, ...(csp.directive ? { directive: csp.directive } : {}) };
}

function normalizeChecks(value: readonly ReleaseVerificationCheck[]): ReleaseVerificationCheck[] {
  if (!Array.isArray(value) || value.length !== REQUIRED_CANDIDATE_CHECKS.length) {
    throw new Error("CANDIDATE_VERIFICATION_INVALID");
  }
  const allowedNames = new Set<string>(REQUIRED_CANDIDATE_CHECKS);
  const allowedCodes = new Set<string>([
    "LOGGED_OUT", "FORBIDDEN", "STALE_PAGE", "DEADLINE_EXCEEDED", "INVALID_OUTPUT", "WRONG_STATE",
    "DUPLICATE_REGISTRATION", "ORIGIN_MISMATCH", "WEBMCP_UNAVAILABLE", "TRUSTED_LOADER_REQUIRED",
    "SECRET_LEAKAGE", "CONTROL_PLANE_REQUEST", "MODEL_REQUEST", "CANCELLED",
  ]);
  const names = new Set<string>();
  const checks = value.map((check) => {
    if (!check || typeof check !== "object" || !allowedNames.has(check.name) || names.has(check.name)
      || !["passed", "failed"].includes(check.status)
      || check.status === "passed" && check.code !== undefined
      || check.status === "failed" && !allowedCodes.has(check.code ?? "")) {
      throw new Error("CANDIDATE_VERIFICATION_INVALID");
    }
    names.add(check.name);
    return { name: check.name, status: check.status, ...(check.code ? { code: check.code } : {}) };
  });
  return checks.sort((left, right) => compareStrings(left.name, right.name));
}

function validTools(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every((name) => typeof name === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(name))
    && new Set(value).size === value.length;
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  if (!validTools(left) || !validTools(right)) return false;
  const a = [...left].sort(compareStrings);
  const b = [...right].sort(compareStrings);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function safeDirective(value: string): boolean {
  return value.length <= 512 && /^[\u0020-\u007e]+$/.test(value) && !/[\r\n]/.test(value);
}

function exactHttpsOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.origin === value ? value : undefined;
  } catch { return undefined; }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("CANCELLED");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason ?? new Error("CANCELLED"));
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("RELEASE_VERIFICATION_DEADLINE_EXCEEDED")),
    VERIFICATION_DEADLINE_MS);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason),
        { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
