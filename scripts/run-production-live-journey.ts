import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildOpenApiLiveJourneyReceipt,
  buildWebsiteBrowserUseLiveJourneyReceipt,
  canonicalJsonSha256,
  evaluateProductionLivePreflight,
  writeProductionLiveReceipt,
  type ProductionLiveCommandResultV1,
  type ProductionLiveJourney,
  type ProductionLiveReceiptV1,
} from "../packages/operations/src/production-live.ts";
import {
  createProductionLiveReceiptContextRepository,
  type SelectedProductionLiveReceiptEvidence,
} from "../packages/database/src/production-live-receipt-evidence.ts";
import {
  createApplicationReadinessRepository,
  createMaintenanceReadinessRepository,
} from "../packages/database/src/readiness.ts";
import {
  createWebsiteLiveReceiptEvidenceRepository,
  type SelectedWebsiteLiveReceiptEvidence,
} from "../packages/database/src/website-live-receipt-maintenance.ts";
import { runReadinessCli } from "./check-release-readiness.ts";
import {
  ProductionLiveControlSession,
  readProductionOperatorCredentials,
  type ProductionOperatorCredentials,
} from "./lib/production-live-control-session.ts";
import {
  inspectDeploymentWorkTree,
  type DeploymentWorkTreeInspection,
} from "./lib/deployment-work-tree.ts";
import {
  verifyDeploymentIdentity,
  type DeploymentIdentityDependencies,
  type DeploymentIdentityV1,
} from "../apps/control-plane/src/deployment-identity.ts";

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const MAX_ARTIFACT_BYTES = 65_536;
const DEFAULT_MAX_POLLS = 240;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const DEFAULT_RECEIPT_DIRECTORY = ".page2webmcp/production-live-receipts";
const JAVASCRIPT_MIME = "application/javascript";

type Environment = Readonly<Record<string, string | undefined>>;
type CommandExitCode = 0 | 1 | 2;

export type ProductionLiveSessionPort = Readonly<{
  login(credentials: ProductionOperatorCredentials): Promise<unknown>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T>;
}>;

export type ProductionLiveJourneyOutput = ProductionLiveCommandResultV1 & Readonly<{
  projectId?: string;
  analysisRunId?: string;
  releaseId?: string;
  selectedHash?: string;
  artifactUrl?: string;
  moduleScriptTag?: string;
  actionPath?: string;
  receiptLocation?: string;
  receiptDigest?: string;
}>;

export type ProductionLivePersistedReceiptEvidence = Readonly<{
  context: SelectedProductionLiveReceiptEvidence;
  applicationRoleDigest: string;
  maintenanceRoleDigest: string;
  website?: SelectedWebsiteLiveReceiptEvidence;
}>;

export type ProductionLiveJourneyDependencies = Readonly<{
  createSession?: (origin: string) => ProductionLiveSessionPort;
  loadBuildIdentity?: NonNullable<DeploymentIdentityDependencies["loadBuildIdentity"]>;
  readCredentials?: (path: string | undefined) => Promise<ProductionOperatorCredentials>;
  inspectWorkTree?: () => Promise<DeploymentWorkTreeInspection>;
  fetch?: typeof fetch;
  runReadiness?: (
    args: readonly string[],
    environment: Environment,
    binding: Readonly<{ deploymentIdentityDigest: string }>,
  ) => Promise<Readonly<{
    output: Readonly<{
      status: "passed" | "failed" | "skipped";
      code: string;
      liveSuccess: boolean;
      missingKeys?: readonly string[];
    }>;
    exitCode: CommandExitCode;
  }>>;
  delay?: (milliseconds: number) => Promise<void>;
  maxPolls?: number;
  loadReceiptEvidence?: (
    journey: ProductionLiveJourney,
    selectedHash: string,
    environment: Environment,
  ) => Promise<ProductionLivePersistedReceiptEvidence | undefined>;
  writeReceipt?: (input: Readonly<{
    mode: "live";
    directory: string;
    receipt: ProductionLiveReceiptV1;
  }>) => Promise<string | undefined>;
  receiptDirectory?: string;
}>;

export type ProductionLiveJourneyCliResult = Readonly<{
  output: ProductionLiveJourneyOutput;
  exitCode: CommandExitCode;
}>;

type ParsedArguments = Readonly<{
  journey: ProductionLiveJourney;
  mode: "dry-run" | "live";
  confirmedInstalledHash?: string;
  resumeAuthentication: boolean;
}>;

type Capability = Readonly<{
  id: string;
  riskTier: "R0" | "R1" | "R2" | "R3";
  status: "proposed" | "reviewed" | "verified" | "blocked";
  version: number;
}>;

type AnalysisResponse = Readonly<{
  run: Readonly<{ id: string; status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled"; errorCode?: string }>;
  result?: Readonly<{ providerProvenance?: Readonly<{ mode?: string; fixture?: boolean }> }>;
  capabilities: readonly Capability[];
  websiteUserHandoff?: Readonly<{
    authentication?: Readonly<{ endpoint?: string; state?: string }>;
  }>;
}>;

type PublishedRelease = Readonly<{
  id: string;
  contentHash: string;
  sri: string;
  url: string;
  installation: Readonly<{
    artifactUrl: string;
    downloadUrl: string;
    moduleScriptTag: string;
    contentHash: string;
    integrity: string;
    targetOrigin: string;
    verificationPageUrl: string;
    localOnly: boolean;
  }>;
}>;

export async function runProductionLiveJourneyCli(
  args: readonly string[],
  environment: Environment,
  dependencies: ProductionLiveJourneyDependencies = {},
): Promise<ProductionLiveJourneyCliResult> {
  const parsed = parseArguments(args);
  if (!parsed) return invalidArguments();
  const preflight = evaluateProductionLivePreflight({
    journey: parsed.journey,
    mode: parsed.mode,
    environment,
  });
  if (preflight.status === "failed") return { output: preflight, exitCode: 1 };
  if (parsed.mode === "dry-run") return { output: preflight, exitCode: 0 };

  // A live run must be driven from the exact clean tree the deployment identity
  // names; a stale local build manifest must never stand in for it.
  const workTree = await inspectOperatorWorkTree(dependencies.inspectWorkTree ?? inspectDeploymentWorkTree);
  if (!workTree.inspection) {
    return failed(preflight, [], workTree.code ?? "DEPLOYMENT_BUILD_GIT_FAILED", 1);
  }
  if (workTree.inspection.commit !== environment.PAGE2WEBMCP_GIT_COMMIT_SHA) {
    return failed(preflight, [], "DEPLOYMENT_BUILD_COMMIT_MISMATCH", 1);
  }
  if (workTree.inspection.dirty) return failed(preflight, [], "DEPLOYMENT_BUILD_TREE_DIRTY", 1);

  const completedOperations: string[] = [];
  let projectId: string | undefined;
  let analysisRunId: string | undefined;
  let release: PublishedRelease | undefined;
  try {
    const session = (dependencies.createSession ?? ((origin) => new ProductionLiveControlSession(origin)))(
      environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN!,
    );
    const deployment = parseDeploymentIdentity(
      await session.get<unknown>("/api/deployment-identity"),
      environment,
      dependencies.loadBuildIdentity,
    );
    completedOperations.push("verify-deployed-identity");
    const readCredentials = dependencies.readCredentials ?? readProductionOperatorCredentials;
    const credentials = await readCredentials(environment.PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE);
    await session.login(credentials);
    completedOperations.push("authenticate-operator");

    const projectResponse = await session.post<unknown>(
      "/api/projects",
      projectInput(parsed.journey, environment),
      idempotencyKey("project", parsed.journey, environment),
    );
    projectId = parseProject(projectResponse, parsed.journey);
    completedOperations.push("create-or-select-project");

    if (parsed.journey === "website") {
      const ownership = await ensureWebsiteOwnership(session, projectId, environment);
      if (!ownership.verified) {
        return actionRequired(preflight, completedOperations, "WEBSITE_OWNERSHIP_ACTION_REQUIRED", {
          projectId,
          actionPath: `/projects/${projectId}`,
        });
      }
      completedOperations.push("verify-source-ownership");
    }

    // The enqueue key is deterministic, so a rerun resumes the stored attempt.
    // Binding it to the project's latest terminated attempt starts exactly one
    // fresh run no matter how many earlier attempts failed, and leaves a live
    // attempt on the base key so it is still resumed rather than duplicated.
    const enqueued = parseEnqueued(await session.post<unknown>(
      "/api/projects/analyze",
      { projectId },
      idempotencyKey("analysis", parsed.journey, environment, "", terminatedAttemptId(projectResponse)),
    ));
    if (enqueued.terminated) throw new Error("ANALYSIS_TERMINATED");
    analysisRunId = enqueued.runId;
    completedOperations.push("enqueue-analysis");
    const analysis = await waitForAnalysis({
      session,
      journey: parsed.journey,
      runId: analysisRunId,
      resumeAuthentication: parsed.resumeAuthentication,
      delay: dependencies.delay ?? delay,
      maxPolls: dependencies.maxPolls ?? DEFAULT_MAX_POLLS,
    });
    if (analysis.actionCode !== undefined) {
      return actionRequired(preflight, completedOperations, analysis.actionCode, {
        projectId,
        analysisRunId,
        actionPath: `/projects/${projectId}`,
      });
    }
    const completedAnalysis = analysis.value;
    assertCompletedAnalysis(completedAnalysis, parsed.journey);
    completedOperations.push(parsed.journey === "website"
      ? "restart-and-resume-worker"
      : "fetch-and-freeze-openapi-document");

    if (completedAnalysis.capabilities.some(({ status }) => status === "proposed")) {
      return actionRequired(preflight, completedOperations, "CAPABILITY_REVIEW_REQUIRED", {
        projectId,
        analysisRunId,
        actionPath: `/projects/${projectId}`,
      });
    }
    if (!completedAnalysis.capabilities.some(({ status }) => status === "reviewed" || status === "verified")) {
      return failed(preflight, completedOperations, "APPROVED_CAPABILITY_REQUIRED", 2, {
        projectId, analysisRunId,
      });
    }
    completedOperations.push("review-capabilities");

    const verification = parseCandidateVerification(await session.post<unknown>(
      "/api/capabilities/verify",
      { projectId, analysisRunId },
      idempotencyKey("candidate-verification", parsed.journey, environment),
    ));
    if (!verification.eligible || verification.verificationMode !== "live") {
      return failed(preflight, completedOperations, "LIVE_CANDIDATE_VERIFICATION_REQUIRED", 2, {
        projectId, analysisRunId,
      });
    }
    completedOperations.push("verify-candidate");

    release = parsePublishedRelease(await session.post<unknown>(
      `/api/projects/${projectId}/releases`,
      { analysisRunId },
      idempotencyKey("publication", parsed.journey, environment),
    ), environment);
    completedOperations.push("publish-content-addressed-artifact");
    const publishedBytes = await verifyPublishedBytes(dependencies.fetch ?? fetch, release);
    completedOperations.push("verify-hosted-artifact", "verify-named-download");

    if (parsed.confirmedInstalledHash !== release.contentHash) {
      return actionRequired(preflight, completedOperations, "INSTALLATION_ACTION_REQUIRED", {
        projectId,
        analysisRunId,
        releaseId: release.id,
        selectedHash: release.contentHash,
        artifactUrl: release.installation.artifactUrl,
        moduleScriptTag: release.installation.moduleScriptTag,
        actionPath: `/projects/${projectId}`,
      });
    }
    completedOperations.push("install-selected-release");

    const installation = parseInstallation(await session.post<unknown>(
      `/api/projects/${projectId}/releases/${release.id}/installation`,
      { pageUrl: environment.PAGE2WEBMCP_E2E_INSTALL_PAGE_URL },
      idempotencyKey("installation", parsed.journey, environment, release.contentHash, randomUUID()),
    ), release, environment);
    if (!installation.verified) {
      return failed(preflight, completedOperations, "LIVE_INSTALLATION_EVIDENCE_REQUIRED", 2, {
        projectId, analysisRunId, releaseId: release.id, selectedHash: release.contentHash,
      });
    }
    completedOperations.push("request-native-installation-attestation", "persist-installation-attestation");

    const readiness = await (dependencies.runReadiness ?? runReadinessCli)(
      ["--live"],
      {
        ...environment,
        PAGE2WEBMCP_READINESS_RELEASE_HASH: release.contentHash,
      },
      { deploymentIdentityDigest: deployment.identityDigest },
    );
    if (!readiness.output.liveSuccess || readiness.output.status !== "passed"
      || readiness.output.code !== "LIVE_READINESS_PASSED") {
      return failed(preflight, completedOperations, readiness.output.code, readiness.exitCode === 1 ? 1 : 2, {
        projectId, analysisRunId, releaseId: release.id, selectedHash: release.contentHash,
        ...(readiness.output.missingKeys && readiness.output.missingKeys.length > 0
          ? { missingControls: Object.freeze([...readiness.output.missingKeys].sort()) }
          : {}),
      });
    }
    completedOperations.push("run-live-readiness");
    const loadReceiptEvidence = dependencies.loadReceiptEvidence ?? loadPersistedReceiptEvidence;
    const persisted = await loadReceiptEvidence(parsed.journey, release.contentHash, environment);
    if (!persisted) {
      return failed(preflight, completedOperations, "PRODUCTION_LIVE_RECEIPT_EVIDENCE_REQUIRED", 2, {
        projectId, analysisRunId, releaseId: release.id, selectedHash: release.contentHash,
      });
    }
    completedOperations.push("connect-application-database", "connect-maintenance-database");
    const receipt = buildReceipt({
      journey: parsed.journey,
      environment,
      deployment,
      projectId,
      analysisRunId,
      release,
      publishedBytes,
      readiness: readiness.output,
      persisted,
      signingKey: environment.PAGE2WEBMCP_RECEIPT_SIGNING_KEY!,
    });
    if (parsed.journey === "website") {
      // Each of these is proven by the persisted website projection the receipt
      // just bound: the browser session, egress policy, CDP observation, the
      // consumed authentication handoff, and the reconciled control cleanup.
      completedOperations.push(
        "create-browser-use-session",
        "install-egress-policy",
        "observe-browser-session",
        "complete-authentication-handoff",
        "reconcile-browser-controls",
      );
    }
    const receiptLocation = await (dependencies.writeReceipt ?? writeProductionLiveReceipt)({
      mode: "live",
      directory: resolve(dependencies.receiptDirectory ?? DEFAULT_RECEIPT_DIRECTORY),
      receipt,
    });
    if (!receiptLocation) throw new Error("PRODUCTION_LIVE_RECEIPT_WRITE_FAILED");
    completedOperations.push("write-immutable-receipt");
    return {
      output: Object.freeze({
        ...preflight,
        status: "passed" as const,
        code: "PRODUCTION_LIVE_JOURNEY_PASSED",
        completedOperations: Object.freeze([...completedOperations]),
        liveSuccess: true,
        projectId,
        analysisRunId,
        releaseId: release.id,
        selectedHash: release.contentHash,
        artifactUrl: release.installation.artifactUrl,
        moduleScriptTag: release.installation.moduleScriptTag,
        receiptLocation,
        receiptDigest: receipt.integrity.digest,
      }),
      exitCode: 0,
    };
  } catch (error) {
    return failed(preflight, completedOperations, stableCode(error), 1, {
      ...(projectId ? { projectId } : {}),
      ...(analysisRunId ? { analysisRunId } : {}),
      ...(release ? { releaseId: release.id, selectedHash: release.contentHash } : {}),
    });
  }
}

async function inspectOperatorWorkTree(
  inspect: () => Promise<DeploymentWorkTreeInspection>,
): Promise<Readonly<{ inspection?: DeploymentWorkTreeInspection; code?: string }>> {
  try { return { inspection: await inspect() }; }
  catch (error) { return { code: stableCode(error) }; }
}

type ParsedDeploymentIdentity = DeploymentIdentityV1;

function parseDeploymentIdentity(
  value: unknown,
  environment: Environment,
  loadBuildIdentity?: NonNullable<DeploymentIdentityDependencies["loadBuildIdentity"]>,
): ParsedDeploymentIdentity {
  return verifyDeploymentIdentity(value, environment, {
    ...(loadBuildIdentity ? { loadBuildIdentity } : {}),
  });
}

function parseArguments(args: readonly string[]): ParsedArguments | undefined {
  let journey: ProductionLiveJourney | undefined;
  let mode: "dry-run" | "live" | undefined;
  let confirmedInstalledHash: string | undefined;
  let resumeAuthentication = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--provider") {
      if (seen.has(argument)) return undefined;
      seen.add(argument);
      const value = args[index + 1];
      if (value !== "openapi" && value !== "website") return undefined;
      journey = value;
      index += 1;
    } else if (argument === "--live" || argument === "--dry-run") {
      if (mode) return undefined;
      mode = argument.slice(2) as "dry-run" | "live";
    } else if (argument === "--confirm-installed") {
      if (seen.has(argument)) return undefined;
      seen.add(argument);
      const value = args[index + 1];
      if (!value || !HASH.test(value)) return undefined;
      confirmedInstalledHash = value;
      index += 1;
    } else if (argument === "--resume-authentication") {
      if (resumeAuthentication) return undefined;
      resumeAuthentication = true;
    } else return undefined;
  }
  if (!journey || !mode || mode === "dry-run" && (confirmedInstalledHash || resumeAuthentication)
    || journey === "openapi" && resumeAuthentication) return undefined;
  return { journey, mode, ...(confirmedInstalledHash ? { confirmedInstalledHash } : {}), resumeAuthentication };
}

function projectInput(journey: ProductionLiveJourney, environment: Environment): unknown {
  if (journey === "openapi") return {
    sourceType: "openapi",
    url: environment.PAGE2WEBMCP_E2E_SOURCE_URL,
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: environment.PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN,
      testPageUrl: environment.PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL,
      environment: environment.PAGE2WEBMCP_E2E_ENVIRONMENT,
    },
  };
  return {
    sourceType: "website",
    url: environment.PAGE2WEBMCP_E2E_SOURCE_URL,
    sourceConfiguration: { kind: "website" },
  };
}

function parseProject(value: unknown, journey: ProductionLiveJourney): string {
  const record = plainRecord(value);
  if (!record || !UUID.test(string(record.id)) || record.sourceType !== journey) throw new Error("CONTROL_RESPONSE_INVALID");
  return record.id as string;
}

const ENQUEUED_STATUSES = ["queued", "running", "waiting", "succeeded"] as const;
const TERMINATED_STATUSES = ["failed", "cancelled"] as const;

/**
 * The id of the project's latest attempt when it has terminated, else "". Used
 * as the enqueue key's attempt identity so a terminated history costs exactly
 * one fresh run, while a live attempt keeps the base key and is resumed.
 */
function terminatedAttemptId(projectResponse: unknown): string {
  const latest = plainRecord(plainRecord(projectResponse)?.latestAnalysis);
  if (!latest || !UUID.test(string(latest.id))) return "";
  return (TERMINATED_STATUSES as readonly string[]).includes(string(latest.status)) ? string(latest.id) : "";
}

function parseEnqueued(value: unknown): Readonly<{ runId: string; terminated: boolean }> {
  const record = plainRecord(value);
  const status = record ? string(record.status) : "";
  const terminated = (TERMINATED_STATUSES as readonly string[]).includes(status);
  if (!record || !UUID.test(string(record.runId))
    || !terminated && !(ENQUEUED_STATUSES as readonly string[]).includes(status)) {
    throw new Error("CONTROL_RESPONSE_INVALID");
  }
  return { runId: record.runId as string, terminated };
}

async function ensureWebsiteOwnership(
  session: ProductionLiveSessionPort,
  projectId: string,
  environment: Environment,
): Promise<Readonly<{ verified: boolean }>> {
  const path = `/api/projects/${projectId}/website-ownership`;
  let response = parseOwnership(await session.get<unknown>(path), environment);
  if (response.state === "verified") return { verified: true };
  const action = response.state === "pending" ? "check" : "challenge";
  response = parseOwnership(await session.post<unknown>(
    path,
    { action },
    idempotencyKey(`website-ownership-${action}`, "website", environment),
  ), environment);
  return { verified: response.state === "verified" };
}

function parseOwnership(value: unknown, environment: Environment): Readonly<{ state: string }> {
  const record = plainRecord(value);
  const ownership = plainRecord(record?.ownership);
  const state = string(ownership?.state);
  if (!ownership || !["pending", "verified", "expired", "failed", "missing"].includes(state)
    || ownership.targetOrigin !== new URL(environment.PAGE2WEBMCP_E2E_SOURCE_URL!).origin
    || record?.canAnalyze !== (state === "verified")) throw new Error("CONTROL_RESPONSE_INVALID");
  return { state };
}

async function waitForAnalysis(input: Readonly<{
  session: ProductionLiveSessionPort;
  journey: ProductionLiveJourney;
  runId: string;
  resumeAuthentication: boolean;
  delay: (milliseconds: number) => Promise<void>;
  maxPolls: number;
}>): Promise<Readonly<{ value: AnalysisResponse; actionCode?: never } | { value?: never; actionCode: string }>> {
  if (!Number.isInteger(input.maxPolls) || input.maxPolls < 1 || input.maxPolls > DEFAULT_MAX_POLLS) {
    throw new Error("PRODUCTION_LIVE_CONFIGURATION_INVALID");
  }
  for (let poll = 0; poll < input.maxPolls; poll += 1) {
    const analysis = parseAnalysis(await input.session.get<unknown>(`/api/analysis-runs/${input.runId}`), input.runId);
    if (analysis.run.status === "succeeded") return { value: analysis };
    if (analysis.run.status === "failed" || analysis.run.status === "cancelled") {
      throw new Error(stableExternalCode(analysis.run.errorCode) ?? "ANALYSIS_TERMINATED");
    }
    if (analysis.run.status === "waiting") {
      if (input.journey !== "website") throw new Error("ANALYSIS_WAIT_STATE_INVALID");
      const endpoint = analysis.websiteUserHandoff?.authentication?.endpoint;
      if (endpoint !== `/api/workflow-runs/${input.runId}/website-authentication`) {
        throw new Error("WEBSITE_AUTHENTICATION_HANDOFF_STATE_REQUIRED");
      }
      const handoff = parseAuthentication(await input.session.get<unknown>(endpoint));
      if (["expired", "failed", "cancelled"].includes(handoff.state)) {
        throw new Error(`WEBSITE_AUTHENTICATION_${handoff.state.toUpperCase()}`);
      }
      if (handoff.state === "resumed") {
        await input.delay(DEFAULT_POLL_INTERVAL_MS);
        continue;
      }
      if (!input.resumeAuthentication || handoff.state !== "ready") {
        return { actionCode: input.resumeAuthentication
          ? "WEBSITE_AUTHENTICATION_ACTION_REQUIRED"
          : "WEBSITE_WORKER_RESTART_AND_AUTHENTICATION_REQUIRED" };
      }
      const resumed = parseAuthentication(await input.session.post<unknown>(
        endpoint,
        { action: "check" },
        `website-authentication:resume:${input.runId}`,
      ));
      if (resumed.state !== "resumed") return { actionCode: "WEBSITE_AUTHENTICATION_ACTION_REQUIRED" };
    }
    await input.delay(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error("ANALYSIS_POLL_TIMEOUT");
}

function parseAnalysis(value: unknown, runId: string): AnalysisResponse {
  const record = plainRecord(value);
  const run = plainRecord(record?.run);
  if (!record || !run || run.id !== runId
    || !["queued", "running", "waiting", "succeeded", "failed", "cancelled"].includes(string(run.status))
    || !Array.isArray(record.capabilities) || record.capabilities.length > 100) {
    throw new Error("CONTROL_RESPONSE_INVALID");
  }
  const capabilities = record.capabilities.map((candidate) => {
    const capability = plainRecord(candidate);
    if (!capability || !UUID.test(string(capability.id))
      || !["R0", "R1", "R2", "R3"].includes(string(capability.riskTier))
      || !["proposed", "reviewed", "verified", "blocked"].includes(string(capability.status))
      || !Number.isSafeInteger(capability.version) || Number(capability.version) < 1) {
      throw new Error("CONTROL_RESPONSE_INVALID");
    }
    return capability as Capability;
  });
  return { ...record, run: run as AnalysisResponse["run"], capabilities } as AnalysisResponse;
}

function parseAuthentication(value: unknown): Readonly<{ state: string }> {
  const record = plainRecord(value);
  const authentication = plainRecord(record?.authentication);
  const state = string(authentication?.state);
  if (!authentication || !["waiting", "ready", "resumed", "expired", "failed", "cancelled"].includes(state)
    || typeof authentication.canAct !== "boolean") throw new Error("CONTROL_RESPONSE_INVALID");
  return { state };
}

function assertCompletedAnalysis(analysis: AnalysisResponse, journey: ProductionLiveJourney): void {
  const provenance = analysis.result?.providerProvenance;
  if (!provenance || provenance.mode !== journey || provenance.fixture !== false || analysis.capabilities.length < 1) {
    throw new Error("LIVE_ANALYSIS_EVIDENCE_REQUIRED");
  }
}

function parseCandidateVerification(value: unknown): Readonly<{ eligible: boolean; verificationMode?: string }> {
  const record = plainRecord(value);
  const verification = plainRecord(record?.verification);
  if (!verification || typeof verification.eligible !== "boolean"
    || verification.verificationMode !== undefined
      && !["live", "local_live", "hermetic"].includes(string(verification.verificationMode))) {
    throw new Error("CONTROL_RESPONSE_INVALID");
  }
  return { eligible: verification.eligible, ...(typeof verification.verificationMode === "string"
    ? { verificationMode: verification.verificationMode } : {}) };
}

function parsePublishedRelease(value: unknown, environment: Environment): PublishedRelease {
  const record = plainRecord(value);
  const release = plainRecord(record?.release);
  const installation = plainRecord(release?.installation);
  const hash = string(release?.contentHash);
  const expectedArtifactUrl = `${environment.PAGE2WEBMCP_PUBLIC_ORIGIN}/${hash}.js`;
  const expectedDownloadUrl = `${expectedArtifactUrl}?download=page2webmcp-${hash}.js`;
  if (!release || !installation || !UUID.test(string(release.id)) || !HASH.test(hash)
    || !SRI.test(string(release.sri)) || release.url !== expectedArtifactUrl
    || installation.artifactUrl !== expectedArtifactUrl || installation.downloadUrl !== expectedDownloadUrl
    || installation.contentHash !== hash || installation.integrity !== release.sri
    || installation.localOnly !== false
    || installation.targetOrigin !== targetOrigin(environment)
    || installation.verificationPageUrl !== verificationPageUrl(environment)
    || installation.moduleScriptTag !== `<script type="module" src="${expectedArtifactUrl}" integrity="${release.sri}" crossorigin="anonymous"></script>`) {
    throw new Error("PUBLISHED_RELEASE_IDENTITY_INVALID");
  }
  return release as PublishedRelease;
}

type PublishedByteIdentity = Readonly<{
  size: number;
  sha256: string;
  sri: string;
  mimeType: "application/javascript";
}>;

async function verifyPublishedBytes(transport: typeof fetch, release: PublishedRelease): Promise<PublishedByteIdentity> {
  const [hosted, named] = await Promise.all([
    readArtifact(transport, release.installation.artifactUrl),
    readArtifact(transport, release.installation.downloadUrl),
  ]);
  if (!hosted.bytes.equals(named.bytes) || sha256(hosted.bytes) !== release.contentHash
    || sha384(hosted.bytes) !== release.sri) {
    throw new Error("PUBLISHED_ARTIFACT_IDENTITY_INVALID");
  }
  // The receipt records the media type observed on both published responses.
  if (hosted.mediaType !== named.mediaType || hosted.mediaType !== JAVASCRIPT_MIME) {
    throw new Error("PUBLISHED_ARTIFACT_MIME_TYPE_INVALID");
  }
  return { size: hosted.bytes.byteLength, sha256: release.contentHash, sri: release.sri, mimeType: hosted.mediaType };
}

async function loadPersistedReceiptEvidence(
  journey: ProductionLiveJourney,
  selectedHash: string,
  environment: Environment,
): Promise<ProductionLivePersistedReceiptEvidence | undefined> {
  const application = createApplicationReadinessRepository({
    connectionString: environment.DATABASE_URL!, mode: "live",
  });
  const maintenance = createMaintenanceReadinessRepository({
    connectionString: environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL!, mode: "live",
  });
  const contextRepository = createProductionLiveReceiptContextRepository({
    connectionString: environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL!,
  });
  let websiteRepository: ReturnType<typeof createWebsiteLiveReceiptEvidenceRepository> | undefined;
  try {
    const applicationRole = await application.inspectApplicationRole();
    const provider = journey === "openapi"
      ? { mode: "openapi" as const, adapter: "bounded-openapi" as const, adapterVersion: 1 as const, fixture: false as const }
      : { mode: "website" as const, adapter: "browser-use-v4" as const, adapterVersion: 4 as const, fixture: false as const };
    const topology = await maintenance.inspectSelectedReleaseTopology(selectedHash, provider, false);
    if (!topology.migrationsCurrent || !topology.rlsVerified || !topology.selectedReleasePersisted
      || topology.sessionIdentityDigest === applicationRole.sessionIdentityDigest) return undefined;
    const context = await contextRepository.findSelected(selectedHash);
    if (!context || context.sourceType !== journey) return undefined;
    let website: ProductionLivePersistedReceiptEvidence["website"];
    if (journey === "website") {
      websiteRepository = createWebsiteLiveReceiptEvidenceRepository({
        connectionString: environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL!,
        mode: "live",
      });
      const selected = await websiteRepository.findSelected(selectedHash);
      if (!selected || !HASH.test(selected.ownershipDecisionDigest)) return undefined;
      website = selected;
    }
    return {
      context,
      applicationRoleDigest: applicationRole.sessionIdentityDigest,
      maintenanceRoleDigest: topology.sessionIdentityDigest,
      ...(website ? { website } : {}),
    };
  } finally {
    await Promise.allSettled([
      application.close(), maintenance.close(), contextRepository.close(), websiteRepository?.close(),
    ]);
  }
}

function buildReceipt(input: Readonly<{
  journey: ProductionLiveJourney;
  environment: Environment;
  deployment: ParsedDeploymentIdentity;
  projectId: string;
  analysisRunId: string;
  release: PublishedRelease;
  publishedBytes: PublishedByteIdentity;
  readiness: Readonly<{ status: "passed" | "failed" | "skipped"; code: string; liveSuccess: boolean }>;
  persisted: ProductionLivePersistedReceiptEvidence;
  signingKey: string;
}>): ProductionLiveReceiptV1 {
  const { context } = input.persisted;
  if (context.selectedReleaseHash !== input.release.contentHash
    || context.releaseIdDigest !== domainIdentity("release", input.release.id)
    || context.projectIdentityDigest !== domainIdentity("project", input.projectId)
    || context.analysisRunIdentityDigest !== domainIdentity("analysis", input.analysisRunId)
    || context.sourceType !== input.journey || context.provider.mode !== input.journey
    || context.targetOrigin !== targetOrigin(input.environment)
    || context.environment !== input.environment.PAGE2WEBMCP_E2E_ENVIRONMENT
    || context.artifactUrl !== input.release.installation.artifactUrl
    || context.downloadUrl !== input.release.installation.downloadUrl
    || context.artifactSizeBytes !== input.publishedBytes.size
    || context.artifactIntegrity !== input.publishedBytes.sri
    || context.selectedReleaseHash !== input.publishedBytes.sha256
    || !HASH.test(input.persisted.applicationRoleDigest)
    || !HASH.test(input.persisted.maintenanceRoleDigest)
    || input.persisted.applicationRoleDigest === input.persisted.maintenanceRoleDigest) {
    throw new Error("PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID");
  }
  const common = {
    deployment: {
      gitCommitSha: input.deployment.gitCommitSha,
      applicationReleaseId: input.deployment.applicationReleaseId,
      controlPlaneOrigin: input.deployment.controlPlaneOrigin,
      controlPlaneIdentityDigest: input.deployment.identityDigest,
      sourceTreeSha256: input.deployment.sourceTreeSha256,
    },
    database: {
      projectRef: "bimqgiedckdurqiywctl" as const,
      migrationRange: context.migrationRange,
      applicationRoleDigest: input.persisted.applicationRoleDigest,
      maintenanceRoleDigest: input.persisted.maintenanceRoleDigest,
    },
    project: {
      organizationIdentityDigest: context.organizationIdentityDigest,
      identityDigest: context.projectIdentityDigest,
    },
    source: {
      identityDigest: context.sourceIdentityDigest,
      documentIdentityDigest: context.sourceDocumentIdentityDigest,
    },
    target: {
      origin: context.targetOrigin,
      environment: context.environment,
      testPageIdentityDigest: context.testPageIdentityDigest,
      installPageIdentityDigest: context.installPageIdentityDigest,
    },
    release: {
      identityDigest: context.releaseIdDigest,
      releaseId: input.release.id,
      selectedHash: context.selectedReleaseHash,
    },
    artifact: {
      sha256: context.selectedReleaseHash,
      sri: context.artifactIntegrity,
      size: context.artifactSizeBytes,
      mimeType: input.publishedBytes.mimeType,
    },
    hostedObject: {
      projectRef: "bimqgiedckdurqiywctl" as const,
      bucket: "page2webmcp-releases" as const,
      path: `${context.selectedReleaseHash}.js`,
      identityDigest: context.hostedObjectIdentityDigest,
      sha256: context.selectedReleaseHash,
      size: context.artifactSizeBytes,
      mimeType: input.publishedBytes.mimeType,
    },
    namedDownload: {
      identityDigest: context.namedDownloadIdentityDigest,
      sha256: context.selectedReleaseHash,
      size: context.artifactSizeBytes,
      mimeType: input.publishedBytes.mimeType,
    },
    installation: {
      identityDigest: context.installationIdentityDigest,
      installedSha256: context.selectedReleaseHash,
      targetOrigin: context.targetOrigin,
      environment: context.environment,
      verifiedAt: context.installationVerifiedAt,
    },
    verifier: context.verifier,
    readiness: {
      status: "passed" as const,
      code: "LIVE_READINESS_PASSED" as const,
      evidenceDigest: canonicalJsonSha256({
        ...input.readiness,
        deploymentIdentityDigest: input.deployment.identityDigest,
        selectedReleaseHash: context.selectedReleaseHash,
        installationIdentityDigest: context.installationIdentityDigest,
        verifier: context.verifier,
      }),
    },
    liveSuccess: true,
  };
  if (input.journey === "openapi") {
    if (!context.openapiCleanupDigest || input.persisted.website) {
      throw new Error("PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID");
    }
    return buildOpenApiLiveJourneyReceipt({
      ...common,
      provider: { type: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
      cleanup: { status: "passed", revocationDigest: context.openapiCleanupDigest },
    }, input.signingKey);
  }
  const website = input.persisted.website;
  if (!website || website.selectedReleaseHash !== context.selectedReleaseHash
    || website.sourceIdentityHash !== context.sourceIdentityHash
    || website.analysisRunIdentityDigest !== sha256(Buffer.from(input.analysisRunId, "utf8"))
    || website.targetOriginDigest !== sha256(Buffer.from(context.targetOrigin, "utf8"))) {
    throw new Error("PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID");
  }
  const ttlSecretReferenceDigest = canonicalJsonSha256(website.ttlSecretDigestEvidence);
  const workerRestartDigest = canonicalJsonSha256({
    suspendedWorkerIdentityDigest: website.suspendedWorkerIdentityDigest,
    suspendedLeaseGeneration: website.suspendedLeaseGeneration,
    completionWorkerIdentityDigest: website.completionWorkerIdentityDigest,
    completionLeaseGeneration: website.completionLeaseGeneration,
  });
  const resumeDigest = canonicalJsonSha256({
    resumedWorkerIdentityDigest: website.resumedWorkerIdentityDigest,
    resumeLeaseGeneration: website.resumeLeaseGeneration,
    resumeClaimedAt: website.resumeClaimedAt,
    resultCheckpointHash: website.resultCheckpointHash,
    resultCheckpointWorkerIdentityDigest: website.resultCheckpointWorkerIdentityDigest,
    resultCheckpointLeaseGeneration: website.resultCheckpointLeaseGeneration,
    resultCheckpointedAt: website.resultCheckpointedAt,
    resumeAcknowledgedAt: website.resumeAcknowledgedAt,
  });
  const cleanupDigest = canonicalJsonSha256(website.cleanupResources);
  return buildWebsiteBrowserUseLiveJourneyReceipt({
    ...common,
    provider: { type: "website", adapter: "browser-use-v4", adapterVersion: 4 },
    browserUse: { sessionIdentityDigest: website.providerSessionIdentityDigest },
    ownership: { decisionDigest: website.ownershipDecisionDigest, verified: true },
    browserLease: { identityDigest: website.browserLeaseIdentityDigest },
    egress: {
      policyDigest: website.egressPolicyDigest,
      referenceDigest: website.egressPolicyReferenceDigest,
    },
    cdpObservation: { identityDigest: website.cdpReferenceDigest },
    authentication: {
      checkpointDigest: website.checkpointIdentityDigest,
      handoffDigest: website.authenticationEvidenceReferenceDigest!,
      completed: true,
      workerRestartDigest,
      resumeDigest,
      ttlSecretReferenceDigest,
    },
    cleanup: {
      status: "passed",
      revocationDigest: cleanupDigest,
      browserCleanupDigest: canonicalJsonSha256(website.cleanupResources.filter(({ resource }) =>
        ["browser_lease", "browser_session", "cdp_observation_lease"].includes(resource))),
      controlCleanupDigest: canonicalJsonSha256(website.cleanupResources.filter(({ resource }) =>
        !["browser_lease", "browser_session", "cdp_observation_lease"].includes(resource))),
    },
  }, input.signingKey);
}

function domainIdentity(domain: "release" | "project" | "analysis", id: string): string {
  return sha256(Buffer.from(`${domain}:${id}`, "utf8"));
}

type ObservedArtifact = Readonly<{ bytes: Buffer; mediaType: "application/javascript" }>;

async function readArtifact(transport: typeof fetch, url: string): Promise<ObservedArtifact> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("ARTIFACT_TIMEOUT")), 10_000);
  timer.unref?.();
  try {
    const response = await transport(url, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
    });
    const declared = response.headers.get("content-length");
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (response.status !== 200 || response.url !== url || response.redirected || response.headers.has("set-cookie")
      || mediaType !== JAVASCRIPT_MIME
      || declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_ARTIFACT_BYTES)
      || !response.body) throw new Error("PUBLISHED_ARTIFACT_IDENTITY_INVALID");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new Error("PUBLISHED_ARTIFACT_IDENTITY_INVALID");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    if (size < 1) throw new Error("PUBLISHED_ARTIFACT_IDENTITY_INVALID");
    return { bytes: Buffer.concat(chunks, size), mediaType };
  } finally { clearTimeout(timer); }
}

function parseInstallation(
  value: unknown,
  release: PublishedRelease,
  environment: Environment,
): Readonly<{ verified: boolean }> {
  const record = plainRecord(value);
  const installation = plainRecord(record?.installation);
  const attestation = plainRecord(installation?.attestation);
  const verifier = plainRecord(installation?.verifierIdentity);
  if (!installation || installation.status !== "verified"
    || installation.artifactContentHash !== release.contentHash
    || installation.targetOrigin !== targetOrigin(environment)
    || installation.webMcpImplementation !== "native" || verifier?.mode !== "live"
    || !attestation || attestation.executedContentHash !== release.contentHash
    || attestation.normalPageLoad !== true || attestation.routeInterception !== false
    || attestation.injectedRegistration !== false || attestation.syntheticHarness !== false) {
    return { verified: false };
  }
  return { verified: true };
}

function targetOrigin(environment: Environment): string {
  return environment.PAGE2WEBMCP_PROVIDER_MODE === "openapi"
    ? environment.PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN!
    : new URL(environment.PAGE2WEBMCP_E2E_SOURCE_URL!).origin;
}

function verificationPageUrl(environment: Environment): string {
  return environment.PAGE2WEBMCP_PROVIDER_MODE === "openapi"
    ? environment.PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL!
    : environment.PAGE2WEBMCP_E2E_SOURCE_URL!;
}

function idempotencyKey(
  operation: string,
  journey: ProductionLiveJourney,
  environment: Environment,
  releaseHash = "",
  attemptIdentity = "",
): string {
  const identity = [
    operation,
    journey,
    environment.PAGE2WEBMCP_E2E_SOURCE_URL,
    targetOrigin(environment),
    environment.PAGE2WEBMCP_E2E_INSTALL_PAGE_URL,
    environment.PAGE2WEBMCP_E2E_ENVIRONMENT,
    releaseHash,
  ];
  if (attemptIdentity) identity.push(attemptIdentity);
  const digest = createHash("sha256").update(identity.join("\0"), "utf8").digest("hex");
  return `production-live:${operation}:${digest}`.slice(0, 128);
}

function actionRequired(
  preflight: ProductionLiveCommandResultV1,
  completedOperations: readonly string[],
  code: string,
  details: Partial<ProductionLiveJourneyOutput>,
): ProductionLiveJourneyCliResult {
  return failed(preflight, completedOperations, code, 2, details);
}

function failed(
  preflight: ProductionLiveCommandResultV1,
  completedOperations: readonly string[],
  code: string,
  exitCode: 1 | 2,
  details: Partial<ProductionLiveJourneyOutput> = {},
): ProductionLiveJourneyCliResult {
  return {
    output: Object.freeze({
      ...preflight,
      ...details,
      status: "failed" as const,
      code,
      completedOperations: Object.freeze([...completedOperations]),
      liveSuccess: false,
    }),
    exitCode,
  };
}

function invalidArguments(): ProductionLiveJourneyCliResult {
  return {
    output: {
      schema: "ProductionLiveCommandResultV1",
      journey: "openapi",
      mode: "dry-run",
      status: "failed",
      code: "PRODUCTION_LIVE_ARGUMENTS_INVALID",
      missingControls: [],
      plannedOperations: [],
      completedOperations: [],
      liveSuccess: false,
    },
    exitCode: 2,
  };
}

function stableCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "PRODUCTION_LIVE_FAILED";
  return stableExternalCode(message) ?? "PRODUCTION_LIVE_FAILED";
}

function stableExternalCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    ? value as Record<string, unknown> : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha384(bytes: Buffer): string {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const result = await runProductionLiveJourneyCli(process.argv.slice(2), process.env);
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
