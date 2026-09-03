import { createHash } from "node:crypto";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../../packages/capability-ir/src/plan.ts";
import {
  RELEASE_VERIFICATION_CHECK_NAMES,
  type ReleaseVerificationCheckName as CandidateVerificationCheckName,
  type ReleaseVerificationCheckRecord as ReleaseVerificationCheck,
  type ReleaseVerificationFailureCode,
} from "../../../packages/database/src/control-plane.ts";
import {
  createNodePinnedJsonTransport,
  type NodePinnedJsonTransport,
} from "../../worker/src/node-network.ts";
import { configuredDeploymentIdentity } from "./deployment-identity.ts";
import {
  buildLiveVerifierRequest,
  verifyLiveVerifierResponse,
  type LiveVerifierAttestationIdentityV2,
  type LiveVerifierReplayGuard,
  type LiveVerifierScope,
} from "./release-verifier-protocol-v2.ts";

const HASH = /^[0-9a-f]{64}$/;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const MAX_REPORT_BYTES = 64 * 1_024;
const MAX_VERIFIER_REQUEST_BYTES = 160 * 1_024;
const VERIFICATION_DEADLINE_MS = 120_000;
const HERMETIC_VERIFIER_IDENTIFIER = "page2webmcp:hermetic-release-verifier:v1";

export const REQUIRED_CANDIDATE_CHECKS = RELEASE_VERIFICATION_CHECK_NAMES;
export const RELEASE_VERIFIER_PROTOCOL_VERSION = 1;
export const LIVE_RELEASE_VERIFIER_PROTOCOL_VERSION = 2;
export type { CandidateVerificationCheckName, ReleaseVerificationCheck, ReleaseVerificationFailureCode };

export type VerificationMode = "hermetic" | "local_live" | "live";
type CandidateVerifierAttestationV2 = LiveVerifierAttestationIdentityV2 & Readonly<{ operation: "candidate" }>;
type InstallationVerifierAttestationV2 = LiveVerifierAttestationIdentityV2 & Readonly<{ operation: "installation" }>;

export type VerifierIdentity = Readonly<{
  protocolVersion: 1 | 2;
  mode: VerificationMode;
  webMcpImplementation: "native";
  verifierOriginDigest: string;
}>;

export type ReleaseVerifierHttpRequest = Readonly<{
  url: string;
  method: "POST";
  redirect: "error";
  credentials: "omit";
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
}>;

export type ReleaseVerifierHttpResponse = Readonly<{
  status: number;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

export type ReleaseVerifierHttpTransport = Readonly<{
  request(input: ReleaseVerifierHttpRequest): Promise<ReleaseVerifierHttpResponse>;
}>;

export type CandidateVerificationInput = Readonly<{
  code: string;
  contentHash: string;
  integrity: string;
  manifest: Readonly<{ releaseId: string }> & Record<string, unknown>;
  targetOrigin: string;
  expectedTools: readonly string[];
  liveContext?: Readonly<{
    projectId: string;
    analysisRunId: string;
    sourceIdentityHash: string;
    environment: "test" | "staging" | "production";
  }>;
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
  liveContext?: Readonly<{
    projectId: string;
    releaseId: string;
    installationOperationId: string;
    sourceIdentityHash: string;
    environment: "test" | "staging" | "production";
  }>;
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
  executionEvidence: InstalledExecutionEvidence | null;
  csp: Readonly<{ hosted: "allowed" | "blocked"; directive?: string }>;
}>;

export type InstalledExecutionEvidence = Readonly<{
  authenticatedRead: Readonly<{
    toolName: string;
    authenticated: true;
    succeeded: true;
  }>;
  confirmedReversibleMutation: Readonly<{
    toolName: string;
    confirmation: "explicit";
    reversible: true;
    succeeded: true;
    effectCount: 1;
  }>;
  authoritativeFinalState: Readonly<{
    mutationToolName: string;
    source: "target";
    verified: true;
  }>;
}>;

export type InstalledAttestation = Readonly<{
  status: "verified" | "pending_self_host";
  delivery: "hosted" | "self_hosted";
  csp: InstalledVerificationReport["csp"];
  webMcpImplementation: InstalledVerificationReport["webMcpImplementation"];
  verifierIdentity: VerifierIdentity;
  verifierAttestation?: InstallationVerifierAttestationV2;
  report: InstalledVerificationReport;
}>;

type LiveCandidateVerifierResult = Readonly<{
  report: CandidateVerificationReport;
  verifierAttestation: CandidateVerifierAttestationV2;
}>;

type LiveInstalledVerifierResult = Readonly<{
  report: InstalledVerificationReport;
  verifierAttestation: InstallationVerifierAttestationV2;
}>;

export interface ReleaseVerificationPort {
  readonly mode: VerificationMode;
  readonly readiness?: (signal: AbortSignal) => Promise<VerifierIdentity>;
  verifyCandidate(
    input: CandidateVerificationInput,
    signal: AbortSignal,
  ): Promise<CandidateVerificationReport | LiveCandidateVerifierResult>;
  verifyInstalled(
    input: InstalledVerificationInput,
    signal: AbortSignal,
  ): Promise<InstalledVerificationReport | LiveInstalledVerifierResult>;
}

export type ConfiguredReleaseVerificationPort = ReleaseVerificationPort & Readonly<{
  mode: "live" | "local_live";
  readiness(signal: AbortSignal): Promise<VerifierIdentity>;
}>;

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
  verifierIdentity: VerifierIdentity;
  verifierAttestation?: CandidateVerifierAttestationV2;
  report: CandidateVerificationReport;
}>;

let testPort: ReleaseVerificationPort | undefined;

export function setReleaseVerificationPortForTest(port: ReleaseVerificationPort | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_ADAPTER_FORBIDDEN");
  testPort = port;
}

export function releaseVerificationPort(): ReleaseVerificationPort {
  if (testPort) return testPort;
  const mode = process.env.PAGE2WEBMCP_LOCAL_STACK === "true"
    && process.env.PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN !== undefined ? "local_live" : "live";
  return configuredReleaseVerificationPort(process.env, { mode });
}

export async function attestReleaseCandidate(
  input: CandidateVerificationInput,
  port: ReleaseVerificationPort,
  signal: AbortSignal,
): Promise<CandidateAttestation> {
  assertCandidateInput(input);
  const { verifierIdentity, report, verifierAttestation } = await withDeadline(async (deadlineSignal) => {
    const identity = await verifiedIdentity(port, deadlineSignal);
    const result = candidateVerifierResult(await port.verifyCandidate(input, deadlineSignal), port.mode);
    return { verifierIdentity: identity, ...result };
  }, signal);
  const rejection = candidateReportRejection(report, input);
  if (rejection) throw candidateInvalid(rejection);
  const checks = normalizeChecks(report.checks);
  const passed = new Set(checks.filter(({ status }) => status === "passed").map(({ name }) => name));
  const allPassed = passed.size === REQUIRED_CANDIDATE_CHECKS.length;
  if (!report.csp || !["allowed", "blocked"].includes(report.csp.hosted)
    || report.csp.directive !== undefined && !safeDirective(report.csp.directive)) {
    throw candidateInvalid("csp");
  }
  const normalizedReport = normalizeCandidateReport(report, checks);
  return {
    schema: passed.has("schema") && passed.has("trusted_loader"),
    authenticated: passed.has("authentication") && passed.has("origin"),
    replayPasses: passed.has("replay_idempotency") ? 3 : 0,
    noSecretLeakage: passed.has("secret_leakage") && passed.has("no_control_plane_or_model_calls"),
    browserExecution: allPassed,
    selectionScore: passed.has("tool_selection") ? 20 : 0,
    checks,
    csp: normalizedReport.csp,
    verificationMode: port.mode,
    verifierIdentity,
    ...(verifierAttestation ? { verifierAttestation } : {}),
    report: normalizedReport,
  };
}

export async function attestReleaseInstallation(
  input: InstalledVerificationInput,
  port: ReleaseVerificationPort,
  signal: AbortSignal,
): Promise<InstalledAttestation> {
  assertInstalledInput(input, port.mode);
  const { verifierIdentity, report, verifierAttestation } = await withDeadline(async (deadlineSignal) => {
    const identity = await verifiedIdentity(port, deadlineSignal);
    const result = installedVerifierResult(await port.verifyInstalled(input, deadlineSignal), port.mode);
    return { verifierIdentity: identity, ...result };
  }, signal);
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
      || report.duplicateLoadHarmless !== null || report.executionEvidence !== null) {
      throw new Error("INSTALLED_VERIFICATION_INVALID");
    }
  } else if (report.executedArtifactUrl !== (input.selfHostedUrl ?? input.artifactUrl)
    || report.executedContentHash !== input.contentHash
    || !equalStrings(report.registeredTools, input.expectedTools)
    || report.duplicateLoadHarmless !== true
    || !validInstalledExecutionEvidence(report.executionEvidence, input.manifest, input.expectedTools)) {
    throw new Error("INSTALLED_VERIFICATION_INVALID");
  }
  if (port.mode !== "hermetic" && report.webMcpImplementation !== "native") {
    throw new Error("WEBMCP_NATIVE_REQUIRED");
  }
  const normalizedReport = normalizeInstalledReport(report);
  if (pendingSelfHost) {
    return {
      status: "pending_self_host",
      delivery: "hosted",
      csp: normalizedCsp(report.csp),
      webMcpImplementation: report.webMcpImplementation,
      verifierIdentity,
      ...(verifierAttestation ? { verifierAttestation } : {}),
      report: normalizedReport,
    };
  }
  return {
    status: "verified",
    delivery: input.selfHostedUrl ? "self_hosted" : "hosted",
    csp: normalizedCsp(report.csp),
    webMcpImplementation: report.webMcpImplementation,
    verifierIdentity,
    ...(verifierAttestation ? { verifierAttestation } : {}),
    report: normalizedReport,
  };
}

function candidateVerifierResult(
  value: CandidateVerificationReport | LiveCandidateVerifierResult,
  mode: VerificationMode,
): Readonly<{ report: CandidateVerificationReport; verifierAttestation?: CandidateVerifierAttestationV2 }> {
  if (mode !== "live") return { report: value as CandidateVerificationReport };
  if (!plainRecordWithKeys(value, ["report", "verifierAttestation"])) {
    throw new Error("RELEASE_VERIFIER_ATTESTATION_REQUIRED");
  }
  const wrapped = value as LiveCandidateVerifierResult;
  const attestation = wrapped.verifierAttestation;
  if (!validVerifierAttestationIdentity(attestation, "candidate")) {
    throw new Error("RELEASE_VERIFIER_ATTESTATION_INVALID");
  }
  return { report: wrapped.report, verifierAttestation: attestation };
}

function installedVerifierResult(
  value: InstalledVerificationReport | LiveInstalledVerifierResult,
  mode: VerificationMode,
): Readonly<{ report: InstalledVerificationReport; verifierAttestation?: InstallationVerifierAttestationV2 }> {
  if (mode !== "live") return { report: value as InstalledVerificationReport };
  if (!plainRecordWithKeys(value, ["report", "verifierAttestation"])) {
    throw new Error("RELEASE_VERIFIER_ATTESTATION_REQUIRED");
  }
  const wrapped = value as LiveInstalledVerifierResult;
  const attestation = wrapped.verifierAttestation;
  if (!validVerifierAttestationIdentity(attestation, "installation")) {
    throw new Error("RELEASE_VERIFIER_ATTESTATION_INVALID");
  }
  return { report: wrapped.report, verifierAttestation: attestation };
}

export function configuredReleaseVerificationPort(
  environment: Record<string, string | undefined>,
  dependencies: Readonly<{
    mode?: "live" | "local_live";
    transport?: ReleaseVerifierHttpTransport;
    fetch?: typeof fetch;
    deploymentIdentityDigest?: string;
    now?: () => Date;
    randomUuid?: () => string;
    randomBytes?: () => Uint8Array;
    replayGuard?: LiveVerifierReplayGuard;
  }> = {},
): ConfiguredReleaseVerificationPort {
  const mode = dependencies.mode ?? "live";
  const origin = mode === "live"
    ? exactHttpsOrigin(environment.PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN)
    : environment.PAGE2WEBMCP_LOCAL_STACK === "true"
      ? exactLoopbackHttpOrigin(environment.PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN)
      : undefined;
  const token = environment.PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN;
  if (!origin || !validVerifierToken(token) || dependencies.transport && dependencies.fetch) {
    throw new Error("RELEASE_VERIFIER_CONFIGURATION_REQUIRED");
  }
  const deploymentIdentityDigest = mode === "live"
    ? dependencies.deploymentIdentityDigest ?? configuredDeploymentIdentity(environment).identityDigest
    : undefined;
  if (mode === "live" && (!deploymentIdentityDigest || !HASH.test(deploymentIdentityDigest))) {
    throw new Error("RELEASE_VERIFIER_CONFIGURATION_REQUIRED");
  }
  const transport = dependencies.transport ?? (dependencies.fetch
    ? fetchReleaseVerifierTransport(dependencies.fetch)
    : mode === "live" ? pinnedReleaseVerifierTransport() : fetchReleaseVerifierTransport(fetch));
  const verifierOriginDigest = createHash("sha256").update(origin).digest("hex");
  const legacyRequest = async <T>(path: string, body: unknown, signal: AbortSignal): Promise<T> => {
    return await withDeadline(async (deadlineSignal) => {
      const url = `${origin}${path}`;
      const encodedBody = JSON.stringify(body);
      const response = await transport.request({
        url,
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: deadlineSignal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: encodedBody,
      });
      if (!validVerifierResponse(response, url)) throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
      try { return JSON.parse(Buffer.from(response.body).toString("utf8")) as T; }
      catch { throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID"); }
    }, signal);
  };
  const liveRequest = async <T>(
    path: string,
    scope: LiveVerifierScope,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<Readonly<{ report: T; verifierAttestation: LiveVerifierAttestationIdentityV2 }>> => {
    return await withDeadline(async (deadlineSignal) => {
      const url = `${origin}${path}`;
      const request = buildLiveVerifierRequest({
        operation: scope.operation,
        scope,
        payload,
        token,
      }, {
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.randomUuid ? { randomUuid: dependencies.randomUuid } : {}),
        ...(dependencies.randomBytes ? { randomBytes: dependencies.randomBytes } : {}),
      });
      const response = await transport.request({
        url,
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: deadlineSignal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-page2webmcp-signature": request.signature,
        },
        body: request.body,
      });
      if (!validVerifierResponse(response, url)) throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
      const verified = verifyLiveVerifierResponse({
        body: response.body,
        signature: headerValue(response.headers, "x-page2webmcp-signature"),
        token,
        request: request.context,
      }, {
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.replayGuard ? { replayGuard: dependencies.replayGuard } : {}),
      });
      return {
        report: verified.report as T,
        verifierAttestation: verified.attestation,
      };
    }, signal);
  };
  return {
    mode,
    readiness: async (signal) => {
      const response = mode === "live"
        ? (await liveRequest<unknown>("/v2/readiness", {
          operation: "readiness",
          deploymentIdentityDigest: deploymentIdentityDigest!,
        }, {}, signal)).report
        : await legacyRequest<unknown>("/v1/readiness", {}, signal);
      const protocolVersion = mode === "live"
        ? LIVE_RELEASE_VERIFIER_PROTOCOL_VERSION : RELEASE_VERIFIER_PROTOCOL_VERSION;
      if (!validReadinessResponse(response, mode, protocolVersion)) {
        throw new Error("RELEASE_VERIFIER_IDENTITY_INVALID");
      }
      return {
        protocolVersion,
        mode,
        webMcpImplementation: "native",
        verifierOriginDigest,
      };
    },
    verifyCandidate: (input, signal) => {
      if (mode !== "live") return legacyRequest("/v1/candidates/verify", input, signal);
      const context = input.liveContext;
      const payload = {
        code: input.code,
        contentHash: input.contentHash,
        integrity: input.integrity,
        manifest: input.manifest,
        targetOrigin: input.targetOrigin,
        expectedTools: input.expectedTools,
      };
      return liveRequest("/v2/candidates/verify", {
        operation: "candidate",
        projectId: context?.projectId ?? "",
        analysisRunId: context?.analysisRunId ?? "",
        sourceIdentityHash: context?.sourceIdentityHash ?? "",
        targetOrigin: input.targetOrigin,
        environment: context?.environment ?? "" as "test",
        contentHash: input.contentHash,
      }, payload, signal) as Promise<LiveCandidateVerifierResult>;
    },
    verifyInstalled: (input, signal) => {
      if (mode !== "live") return legacyRequest("/v1/installations/verify", input, signal);
      const context = input.liveContext;
      const payload = {
        pageUrl: input.pageUrl,
        artifactUrl: input.artifactUrl,
        downloadUrl: input.downloadUrl,
        localOnly: input.localOnly,
        contentHash: input.contentHash,
        integrity: input.integrity,
        manifest: input.manifest,
        targetOrigin: input.targetOrigin,
        expectedTools: input.expectedTools,
        ...(input.selfHostedUrl ? { selfHostedUrl: input.selfHostedUrl } : {}),
      };
      return liveRequest("/v2/installations/verify", {
        operation: "installation",
        projectId: context?.projectId ?? "",
        releaseId: context?.releaseId ?? "",
        installationOperationId: context?.installationOperationId ?? "",
        sourceIdentityHash: context?.sourceIdentityHash ?? "",
        pageUrl: input.pageUrl,
        targetOrigin: input.targetOrigin,
        environment: context?.environment ?? "" as "test",
        selectedHash: input.contentHash,
      }, payload, signal) as Promise<LiveInstalledVerifierResult>;
    },
  };
}

function pinnedReleaseVerifierTransport(): ReleaseVerifierHttpTransport {
  const transport: NodePinnedJsonTransport = createNodePinnedJsonTransport();
  return {
    async request(input) {
      assertVerifierHttpRequest(input, "https:");
      return await transport.request({
        url: input.url,
        method: input.method,
        headers: input.headers,
        body: input.body,
        maxBodyBytes: MAX_VERIFIER_REQUEST_BYTES,
        signal: input.signal,
      });
    },
  };
}

function fetchReleaseVerifierTransport(transport: typeof fetch): ReleaseVerifierHttpTransport {
  if (typeof transport !== "function") throw new Error("RELEASE_VERIFIER_CONFIGURATION_REQUIRED");
  return {
    async request(input) {
      assertVerifierHttpRequest(input);
      const response = await transport(input.url, {
        method: input.method,
        redirect: input.redirect,
        credentials: input.credentials,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
      });
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength)
        || Number(declaredLength) > MAX_REPORT_BYTES)) throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
      return {
        status: response.status,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        body: await boundedResponseBytes(response, input.signal),
      };
    },
  };
}

function assertVerifierHttpRequest(input: ReleaseVerifierHttpRequest, protocol?: "https:"): void {
  let url: URL;
  try { url = new URL(input.url); }
  catch { throw new Error("RELEASE_VERIFIER_CONFIGURATION_REQUIRED"); }
  if (input.method !== "POST" || input.redirect !== "error" || input.credentials !== "omit"
    || protocol && url.protocol !== protocol || url.username || url.password || url.search || url.hash
    || typeof input.body !== "string" || Buffer.byteLength(input.body) > MAX_VERIFIER_REQUEST_BYTES
    || input.signal.aborted) throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
}

async function boundedResponseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("CANCELLED");
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REPORT_BYTES) {
        await reader.cancel(new Error("RELEASE_VERIFIER_RESPONSE_INVALID"));
        throw new Error("RELEASE_VERIFIER_RESPONSE_INVALID");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validVerifierResponse(response: ReleaseVerifierHttpResponse, expectedUrl: string): boolean {
  const contentType = response && typeof response === "object"
    ? headerValue(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    : undefined;
  return !!response && typeof response === "object"
    && response.url === expectedUrl
    && response.status === 200
    && contentType === "application/json"
    && !hasHeader(response.headers, "set-cookie")
    && !hasHeader(response.headers, "set-cookie2")
    && headerValue(response.headers, "access-control-allow-credentials")?.trim().toLowerCase() !== "true"
    && response.body instanceof Uint8Array
    && response.body.byteLength <= MAX_REPORT_BYTES;
}

function headerValue(headers: Readonly<Record<string, string>> | undefined, expectedName: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === expectedName && typeof value === "string") return value;
  }
  return undefined;
}

function hasHeader(headers: Readonly<Record<string, string>> | undefined, expectedName: string): boolean {
  return !!headers && Object.keys(headers).some((name) => name.toLowerCase() === expectedName);
}

function validReadinessResponse(
  value: unknown,
  mode: "live" | "local_live",
  protocolVersion: 1 | 2,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareStrings);
  return keys.length === 3
    && keys[0] === "mode" && keys[1] === "protocolVersion" && keys[2] === "webMcpImplementation"
    && record.protocolVersion === protocolVersion
    && record.mode === mode
    && record.webMcpImplementation === "native";
}

async function verifiedIdentity(port: ReleaseVerificationPort, signal: AbortSignal): Promise<VerifierIdentity> {
  const identity = port.readiness
    ? await port.readiness(signal)
    : port.mode === "hermetic" ? hermeticVerifierIdentity() : undefined;
  if (!identity) throw new Error("RELEASE_VERIFIER_IDENTITY_REQUIRED");
  const expectedProtocolVersion = port.mode === "live"
    ? LIVE_RELEASE_VERIFIER_PROTOCOL_VERSION : RELEASE_VERIFIER_PROTOCOL_VERSION;
  const keys = Object.keys(identity).sort(compareStrings);
  if (keys.length !== 4 || keys[0] !== "mode" || keys[1] !== "protocolVersion"
    || keys[2] !== "verifierOriginDigest" || keys[3] !== "webMcpImplementation"
    || identity.protocolVersion !== expectedProtocolVersion
    || identity.mode !== port.mode || identity.webMcpImplementation !== "native"
    || !HASH.test(identity.verifierOriginDigest)) throw new Error("RELEASE_VERIFIER_IDENTITY_INVALID");
  return {
    protocolVersion: expectedProtocolVersion,
    mode: identity.mode,
    webMcpImplementation: "native",
    verifierOriginDigest: identity.verifierOriginDigest,
  };
}

function hermeticVerifierIdentity(): VerifierIdentity {
  return {
    protocolVersion: RELEASE_VERIFIER_PROTOCOL_VERSION,
    mode: "hermetic",
    webMcpImplementation: "native",
    verifierOriginDigest: createHash("sha256").update(HERMETIC_VERIFIER_IDENTIFIER).digest("hex"),
  };
}

function jsonByteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? Buffer.byteLength(encoded) : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The candidate report is refused by one stable code, which leaves a live
 * rejection unattributable. The message stays the code; the reason names the
 * field that refused it, on the error and in the control-plane log.
 */
function candidateInvalid(reason: string): Error {
  console.error(JSON.stringify({
    level: "error", event: "candidate_verification_invalid", reason,
  }));
  return Object.assign(new Error("CANDIDATE_VERIFICATION_INVALID"), { reason });
}

function candidateReportRejection(
  report: CandidateVerificationReport | undefined,
  input: CandidateVerificationInput,
): string | undefined {
  if (!report || typeof report !== "object") return "report_missing";
  if (report.observedContentHash !== input.contentHash) return "content_hash";
  if (report.observedIntegrity !== input.integrity) return "integrity";
  if (report.observedReleaseId !== input.manifest.releaseId) return "release_id";
  if (report.observedTargetOrigin !== input.targetOrigin) return "target_origin";
  if (!equalStrings(report.registeredTools, input.expectedTools)) {
    return `registered_tools observed=${JSON.stringify(report.registeredTools)} expected=${JSON.stringify(input.expectedTools)}`;
  }
  if (report.trustedLoader?.enforcedBeforeEvaluation !== true) return "trusted_loader_not_enforced";
  if (report.trustedLoader.evaluatedContentHash !== input.contentHash) return "trusted_loader_hash";
  if (report.controlPlaneRequestsDuringExecution !== 0) return "control_plane_requests";
  if (report.modelRequestsDuringExecution !== 0) return "model_requests";
  return undefined;
}

function assertCandidateInput(input: CandidateVerificationInput): void {
  if (!input || typeof input.code !== "string" || Buffer.byteLength(input.code) > 65_536
    || !HASH.test(input.contentHash) || !SRI.test(input.integrity)
    || !HASH.test(input.manifest?.releaseId) || exactHttpsOrigin(input.targetOrigin) !== input.targetOrigin
    || !validTools(input.expectedTools) || jsonByteLength(input) > MAX_VERIFIER_REQUEST_BYTES) {
    throw candidateInvalid("input");
  }
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
    ? "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases"
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

function normalizeCandidateReport(
  report: CandidateVerificationReport,
  checks: readonly ReleaseVerificationCheck[],
): CandidateVerificationReport {
  return {
    observedContentHash: report.observedContentHash,
    observedIntegrity: report.observedIntegrity,
    observedReleaseId: report.observedReleaseId,
    observedTargetOrigin: report.observedTargetOrigin,
    registeredTools: [...report.registeredTools].sort(compareStrings),
    trustedLoader: {
      enforcedBeforeEvaluation: report.trustedLoader.enforcedBeforeEvaluation,
      evaluatedContentHash: report.trustedLoader.evaluatedContentHash,
    },
    controlPlaneRequestsDuringExecution: report.controlPlaneRequestsDuringExecution,
    modelRequestsDuringExecution: report.modelRequestsDuringExecution,
    checks: [...checks],
    csp: normalizedCsp(report.csp),
  };
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
    executionEvidence: report.executionEvidence === null ? null : {
      authenticatedRead: { ...report.executionEvidence.authenticatedRead },
      confirmedReversibleMutation: { ...report.executionEvidence.confirmedReversibleMutation },
      authoritativeFinalState: { ...report.executionEvidence.authoritativeFinalState },
    },
    csp: normalizedCsp(report.csp),
  };
}

function validInstalledExecutionEvidence(
  value: unknown,
  manifest: unknown,
  expectedTools: readonly string[],
): value is InstalledExecutionEvidence {
  if (!plainRecordWithKeys(value, ["authenticatedRead", "authoritativeFinalState", "confirmedReversibleMutation"])) {
    return false;
  }
  const read = value.authenticatedRead;
  const mutation = value.confirmedReversibleMutation;
  const finalState = value.authoritativeFinalState;
  if (!plainRecordWithKeys(read, ["authenticated", "succeeded", "toolName"])
    || !plainRecordWithKeys(mutation, ["confirmation", "effectCount", "reversible", "succeeded", "toolName"])
    || !plainRecordWithKeys(finalState, ["mutationToolName", "source", "verified"])
    || !validToolName(read.toolName) || !validToolName(mutation.toolName)
    || finalState.mutationToolName !== mutation.toolName
    || read.authenticated !== true || read.succeeded !== true
    || mutation.confirmation !== "explicit" || mutation.reversible !== true || mutation.succeeded !== true
    || mutation.effectCount !== 1
    || finalState.source !== "target" || finalState.verified !== true
    || read.toolName === mutation.toolName
    || !expectedTools.includes(read.toolName) || !expectedTools.includes(mutation.toolName)) return false;
  const plans = installedPlans(manifest);
  if (!plans) return false;
  const readPlan = plans.find(({ tool }) => tool.name === read.toolName);
  const mutationPlan = plans.find(({ tool }) => tool.name === mutation.toolName);
  return readPlan?.effects.kind === "read" && readPlan.annotations.readOnly
    && ["same_origin_cookie", "browser_oauth"].includes(readPlan.authentication.mode)
    && mutationPlan?.effects.kind === "mutation" && !mutationPlan.annotations.readOnly
    && mutationPlan.effects.reversible && mutationPlan.effects.confirmation === "always";
}

function installedPlans(manifest: unknown): readonly CapabilityPlan[] | undefined {
  if (!manifest || typeof manifest !== "object" || !("plans" in manifest)
    || !Array.isArray((manifest as { plans?: unknown }).plans)) return undefined;
  try {
    return canonicalizeCapabilityPlans((manifest as { plans: CapabilityPlan[] }).plans);
  } catch {
    return undefined;
  }
}

function plainRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value);
}

function normalizedCsp(csp: InstalledVerificationReport["csp"]): InstalledVerificationReport["csp"] {
  return { hosted: csp.hosted, ...(csp.directive ? { directive: csp.directive } : {}) };
}

function normalizeChecks(value: readonly ReleaseVerificationCheck[]): ReleaseVerificationCheck[] {
  if (!Array.isArray(value) || value.length !== REQUIRED_CANDIDATE_CHECKS.length) {
    throw candidateInvalid(`check_count ${Array.isArray(value) ? value.length : "not-array"}`);
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
      throw candidateInvalid(`check ${JSON.stringify(check)}`);
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

function validVerifierAttestationIdentity<Operation extends "candidate" | "installation">(
  value: unknown,
  operation: Operation,
): value is LiveVerifierAttestationIdentityV2 & Readonly<{ operation: Operation }> {
  if (!plainRecordWithKeys(value, [
    "attestationId", "attestedAt", "expiresAt", "issuedAt", "nonceDigest", "operation",
    "payloadDigest", "protocolVersion", "requestId", "scopeDigest",
  ])) return false;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  return value.protocolVersion === LIVE_RELEASE_VERIFIER_PROTOCOL_VERSION
    && value.operation === operation
    && typeof value.attestationId === "string" && uuid.test(value.attestationId)
    && typeof value.requestId === "string" && uuid.test(value.requestId)
    && typeof value.nonceDigest === "string" && HASH.test(value.nonceDigest)
    && typeof value.scopeDigest === "string" && HASH.test(value.scopeDigest)
    && typeof value.payloadDigest === "string" && HASH.test(value.payloadDigest)
    && typeof value.issuedAt === "string" && timestamp.test(value.issuedAt)
    && typeof value.expiresAt === "string" && timestamp.test(value.expiresAt)
    && typeof value.attestedAt === "string" && timestamp.test(value.attestedAt)
    && Date.parse(value.issuedAt) <= Date.parse(value.attestedAt)
    && Date.parse(value.attestedAt) < Date.parse(value.expiresAt);
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

function exactLoopbackHttpOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "http:" && (hostname === "127.0.0.1" || hostname === "::1")
      && url.port !== "" && !url.username && !url.password && url.origin === value ? value : undefined;
  } catch { return undefined; }
}

function validVerifierToken(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && /^[\u0021-\u007e]+$/.test(value) && !/[\r\n]/.test(value);
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
