import { createHash } from "node:crypto";
import {
  advanceWebsiteCleanupResources,
  parsePersistedSourceConfiguration,
  type AnalysisResult,
  type ClaimedAnalysisRunRecord,
  type WebsiteAuthenticationSuspensionEvidence,
  type WebsiteAuthenticationSuspensionProjection,
  type WebsiteAuthenticationCleanupResourceEvidence,
  type WebsiteLiveReceiptEvidence,
} from "../../../packages/database/src/control-plane.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import {
  compileOpenApiWithGrouping,
  validateOpenApiSource,
  type OpenApiGroupingPort,
} from "../../../packages/openapi/src/compile.ts";
import { fetchOpenApiSource, type OpenApiProviderControls } from "../../../packages/providers/src/openapi.ts";
import {
  preflightWebsiteSource,
  verifyWebsiteOwnership,
  type OwnershipReplayStore,
  type WebsiteOwnershipChallenge,
  type WebsiteProviderControls,
} from "../../../packages/providers/src/website.ts";
import {
  assertBrowserUseResumeAttestation,
  withBrowserUseCloudV4Session,
  type BrowserUseCloudV4Controls,
  type BrowserUseSuspensionAttestation,
} from "../../../packages/providers/src/browser-use-v4.ts";
import {
  captureWebsiteEvidence,
  proposeWebsiteCapabilityPlans,
  readWebsiteEvidence,
  websiteObservationsFromEvidence,
  type WebsiteEvidenceStore,
  type WebsiteObservationInput,
} from "../../../packages/providers/src/website-evidence.ts";
import { createDiscoveryFirewall } from "../../../packages/security/src/security.ts";
import {
  captureGitHubSourceSnapshot,
  withGitHubAppSession,
  type GitHubRepositorySelection,
  type GitHubSnapshotPort,
  type GitHubTokenPort,
} from "../../../packages/providers/src/github.ts";
import {
  analyzeGitHubSourceSnapshot,
  generateSourceNativeChange,
} from "../../../packages/source-analyzer/src/analyze.ts";

export type OpenApiAnalysisConfiguration = Readonly<{
  provider: Omit<OpenApiProviderControls, "signal">;
  groupingPort?: OpenApiGroupingPort;
}>;

export type AnalysisSource = Pick<ClaimedAnalysisRunRecord, "sourceType" | "sourceUrl">
  & Partial<Pick<ClaimedAnalysisRunRecord,
    "id" | "organizationId" | "projectId" | "sourceConfiguration" | "leaseGeneration"
    | "sourceSnapshotId" | "authenticationCheckpoint">>
  & Readonly<{ sourceIdentityHash?: string; liveReceiptEvidence?: WebsiteLiveReceiptEvidence }>;

export type WebsiteAuthenticationWaitingOutcome = Readonly<{
  disposition: "waiting_for_authentication";
  capabilities: [];
  diagnostics: [];
  evidence: [];
  release?: undefined;
  draftPullRequest?: undefined;
  providerProvenance?: undefined;
  checkpointReference: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  expiresAt: string;
  suspensionEvidence?: WebsiteAuthenticationSuspensionProjection;
}>;

export type AnalysisAdapterOutcome = AnalysisResult | WebsiteAuthenticationWaitingOutcome;

const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_REFERENCE = /^urn:sha256:[0-9a-f]{64}$/;
const SECRET_REFERENCE = /^secretref:[A-Za-z0-9._:-]{1,200}$/;
const RECEIPT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function projectBrowserUseSuspensionEvidence(
  attestation: BrowserUseSuspensionAttestation,
  ownershipDecisionDigest: string,
): WebsiteAuthenticationSuspensionProjection {
  const expectedKeys = [
    "authenticationCheckpointProtocolVersion", "browserPolicyDigest", "cdpReference", "checkpointReference",
    "egressPolicyDigest", "egressPolicyReference", "expiresAt", "leaseId", "liveReference", "organizationId",
    "projectId", "providerSessionIdDigest", "publicEvidenceReference", "runId", "sourceIdentityHash",
    "sourceSnapshotId", "suspended", "targetOriginDigest",
  ].sort();
  const actualKeys = attestation && typeof attestation === "object" && !Array.isArray(attestation)
    ? Object.keys(attestation).sort() : [];
  const expiry = Date.parse(attestation?.expiresAt);
  if (actualKeys.join("\0") !== expectedKeys.join("\0")
    || attestation.authenticationCheckpointProtocolVersion !== 1 || attestation.suspended !== true
    || !CONTENT_REFERENCE.test(attestation.checkpointReference)
    || !CONTENT_REFERENCE.test(attestation.publicEvidenceReference)
    || ![attestation.organizationId, attestation.projectId, attestation.runId, attestation.sourceSnapshotId,
      attestation.leaseId].every((value) => RECEIPT_IDENTIFIER.test(value))
    || ![attestation.providerSessionIdDigest, attestation.sourceIdentityHash, attestation.targetOriginDigest,
      attestation.egressPolicyDigest, attestation.browserPolicyDigest].every((value) => SHA256.test(value))
    || !SECRET_REFERENCE.test(attestation.liveReference) || !SECRET_REFERENCE.test(attestation.cdpReference)
    || !SECRET_REFERENCE.test(attestation.egressPolicyReference)
    || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== attestation.expiresAt) {
    throw new Error("WEBSITE_SUSPENSION_EVIDENCE_INVALID");
  }
  if (!SHA256.test(ownershipDecisionDigest)) throw new Error("WEBSITE_SUSPENSION_EVIDENCE_INVALID");
  const referenceDigest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  return {
    schemaVersion: 1,
    ownershipDecisionDigest,
    providerSessionIdentityDigest: attestation.providerSessionIdDigest,
    browserUse: {
      adapter: "browser-use-v4", adapterVersion: 4, apiVersion: "v4", model: "browser-use-2.0",
      policyDigest: attestation.browserPolicyDigest,
    },
    browserLease: { identityDigest: referenceDigest(attestation.leaseId), expiresAt: attestation.expiresAt },
    egressPolicy: {
      referenceDigest: referenceDigest(attestation.egressPolicyReference),
      policyDigest: attestation.egressPolicyDigest,
    },
    cdpReferenceDigest: referenceDigest(attestation.cdpReference),
    publicEvidenceReference: attestation.publicEvidenceReference,
    ttlSecrets: [
      { purpose: "browser_cdp_url", referenceDigest: referenceDigest(attestation.cdpReference), expiresAt: attestation.expiresAt },
      { purpose: "browser_live_url", referenceDigest: referenceDigest(attestation.liveReference), expiresAt: attestation.expiresAt },
    ],
    checkpoint: {
      checkpointReference: attestation.checkpointReference,
      sourceSnapshotId: attestation.sourceSnapshotId,
      sourceIdentityHash: attestation.sourceIdentityHash,
      targetOriginDigest: attestation.targetOriginDigest,
      expiresAt: attestation.expiresAt,
    },
  };
}

export function bindWebsiteSuspensionToWorker(
  projection: WebsiteAuthenticationSuspensionProjection,
  workerId: string,
  leaseGeneration: number,
): WebsiteAuthenticationSuspensionEvidence {
  if (!RECEIPT_IDENTIFIER.test(workerId) || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
    throw new Error("WEBSITE_SUSPENSION_EVIDENCE_INVALID");
  }
  return {
    ...structuredClone(projection),
    suspendedWorkerIdentityDigest: createHash("sha256").update(workerId, "utf8").digest("hex"),
    suspendedLeaseGeneration: leaseGeneration,
  };
}
export type AnalysisAdapter = ((source: AnalysisSource, signal: AbortSignal) => Promise<AnalysisAdapterOutcome>) & {
  finalizeAuthenticationCheckpoint?(
    source: AnalysisSource,
    signal: AbortSignal,
  ): Promise<readonly WebsiteAuthenticationCleanupResourceEvidence[] | void>;
  reconcileAuthenticationCheckpoint?(
    source: AnalysisSource,
    waiting: WebsiteAuthenticationWaitingOutcome,
    signal: AbortSignal,
    outcome?: "failed" | "cancelled",
  ): Promise<readonly WebsiteAuthenticationCleanupResourceEvidence[] | void>;
};

export type GitHubAnalysisConfiguration = Readonly<{
  targetOrigin: string;
  clock: () => Date;
  installation: Readonly<{
    resolve(input: Readonly<{
      sourceUrl: string;
      organizationId: string;
      projectId: string;
      runId: string;
      signal: AbortSignal;
    }>): Promise<GitHubRepositorySelection>;
  }>;
  tokens: GitHubTokenPort;
  snapshot: GitHubSnapshotPort;
}>;

export type WebsiteAnalysisConfiguration = Readonly<{
  clock?: () => Date;
  provider: Omit<WebsiteProviderControls, "signal">;
  ownership: Readonly<{
    attestations: {
      consume(input: Readonly<{
        organizationId: string;
        projectId: string;
        runId: string;
        sourceIdentityHash: string;
        sourceUrl: string;
        targetOrigin: string;
      }>): Promise<Readonly<{ bound: true; challengeDigest: string }>>;
    };
    challenges: {
      load(input: Readonly<{
        organizationId: string;
        projectId: string;
        runId: string;
        targetOrigin: string;
      }>): Promise<WebsiteOwnershipChallenge>;
    };
    replayStore: OwnershipReplayStore;
  }>;
  browser: Readonly<{
    expiresAt: string;
    proxyPolicyReference: Readonly<{ reference: string; expiresAt: string }>;
    egressPolicyDigest: string;
    controls: Omit<BrowserUseCloudV4Controls, "signal">;
  }>;
  authentication: Readonly<{
    status(input: WebsiteAuthenticationCheckpointRequest): Promise<Readonly<WebsiteAuthenticationCheckpointRequest & {
      status: "ready";
    }>>;
    resume(input: WebsiteAuthenticationCheckpointRequest & Readonly<{
      authenticationEvidenceReference: string;
    }>): Promise<Readonly<WebsiteAuthenticationCheckpointRequest & {
      authenticationEvidenceReference: string;
      resumed: true;
      cdpReference: string;
      publicEvidenceReference: string;
      suspensionAttestation: BrowserUseSuspensionAttestation;
      authentication: Readonly<{
        authenticatedOrigin: string;
        observedAt: string;
        signals: readonly string[];
      }>;
    }>>;
    finalize(input: WebsiteAuthenticationTerminalRequest): Promise<Readonly<{
      finalized: true;
      cleanupResources?: readonly WebsiteAuthenticationCleanupResourceEvidence[];
    }>>;
    reconcile(input: WebsiteAuthenticationTerminalRequest): Promise<Readonly<{
      reconciled: true;
      terminated: true;
      cleanupResources?: readonly WebsiteAuthenticationCleanupResourceEvidence[];
    }>>;
  }>;
  explorer: {
    observe(input: Readonly<{
      // The gateway observation contract: "public" names an observed
      // authentication result, never a request phase.
      phase: "unauthenticated" | "authenticated";
      targetOrigin: string;
      sourceUrl: string;
      cdpReference: string;
      firewall: ReturnType<typeof createDiscoveryFirewall>;
      signal: AbortSignal;
    }>): Promise<Readonly<{ observations: WebsiteObservationInput; requiresAuthentication: boolean }>>;
  };
  evidenceStore: WebsiteEvidenceStore;
}>;

type WebsiteAuthenticationCheckpointRequest = Readonly<{
  checkpointReference: string;
  organizationId: string;
  projectId: string;
  runId: string;
  sourceSnapshotId: string;
  sourceIdentityHash: string;
  targetOriginDigest: string;
  expiresAt: string;
}>;

type WebsiteAuthenticationTerminalRequest = WebsiteAuthenticationCheckpointRequest & Readonly<{
  outcome: "completed" | "failed" | "cancelled";
}>;

type OpenApiVerificationConfiguration = Extract<ClaimedAnalysisRunRecord["sourceConfiguration"], { kind: "openapi" }>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function verificationContext(source: AnalysisSource): OpenApiVerificationConfiguration {
  return parsePersistedSourceConfiguration("openapi", source.sourceConfiguration) as OpenApiVerificationConfiguration;
}

function evidenceContent(
  sourceDigest: string,
  openApiVersion: string,
  configuration: OpenApiVerificationConfiguration,
): string {
  return JSON.stringify({
    adapter: "bounded-openapi",
    adapterVersion: 1,
    environment: configuration.environment,
    openApiVersion,
    sourceDigest,
    targetOrigin: configuration.targetOrigin,
    testPageUrl: configuration.testPageUrl,
  });
}

/** Creates an OpenAPI adapter from bounded transport controls; verification context is claimed per run. */
export function createOpenApiAnalysisAdapter(configuration: OpenApiAnalysisConfiguration): AnalysisAdapter {
  if (!configuration?.provider?.resolver || !configuration.provider.transport) {
    throw new Error("OPENAPI_PROVIDER_CONTROLS_REQUIRED");
  }
  return async (source, signal) => {
    if (source.sourceType !== "openapi") throw new Error("SOURCE_TYPE_UNSUPPORTED");
    const context = verificationContext(source);
    const fetched = await fetchOpenApiSource(source.sourceUrl, { ...configuration.provider, signal });
    const contentHash = fetched.evidenceReference.slice("urn:sha256:".length);
    const sourceArtifact = {
      contentHash,
      artifactReference: fetched.evidenceReference,
      finalUrl: fetched.finalUrl ?? source.sourceUrl,
      mimeType: fetched.contentType,
      sizeBytes: fetched.sizeBytes,
    } as const;
    const document = await validateOpenApiSource(fetched.source, fetched.format);
    const content = evidenceContent(fetched.evidenceReference, document.openapi, context);
    const reference = `urn:sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    const compiled = await compileOpenApiWithGrouping(document, {
      targetOrigin: context.targetOrigin,
      testPageUrl: context.testPageUrl,
      environment: context.environment,
      evidenceReference: reference,
    }, configuration.groupingPort);
    if (compiled.plans.length === 0) {
      if (compiled.diagnostics.length === 0) throw new Error("NO_BROWSER_SAFE_CAPABILITIES");
      return {
        capabilities: [],
        diagnostics: compiled.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        evidence: [{ source: "openapi", content, reference }],
        sourceArtifact,
      };
    }
    const release = compileWebMcpRelease(compiled.plans);
    return {
      capabilities: release.manifest.plans.map((plan) => ({ plan, status: "proposed" as const })),
      diagnostics: compiled.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      evidence: [{ source: "openapi", content, reference }],
      sourceArtifact,
      release: {
        code: release.code,
        contentHash: release.contentHash,
        allowedOrigin: release.allowedOrigin,
        manifest: release.manifest,
      },
    };
  };
}

function githubSourceIdentity(sourceUrl: string): Readonly<{ owner: string; repository: string }> {
  let url: URL;
  try { url = new URL(sourceUrl); } catch { throw new Error("GITHUB_SOURCE_URL_INVALID"); }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password
    || url.search || url.hash || parts.length !== 2
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(parts[0]!)
    || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]!)) throw new Error("GITHUB_SOURCE_URL_INVALID");
  return { owner: parts[0]!, repository: parts[1]! };
}

function sourceNativeEvidenceContent(
  snapshot: Awaited<ReturnType<typeof captureGitHubSourceSnapshot>>,
  change: ReturnType<typeof generateSourceNativeChange>,
): string {
  return JSON.stringify({
    adapter: "github-source-native-change",
    adapterVersion: 1,
    baseCommitSha: change.baseCommitSha,
    files: change.files.map(({ path, contentHash }) => ({ path, contentHash })),
    patchDigest: change.patchDigest,
    releaseContentHash: change.release.contentHash,
    snapshotReference: snapshot.reference,
  });
}

/**
 * Creates the read-only GitHub analysis adapter from explicit GitHub App
 * installation, ephemeral-token, and immutable-snapshot ports. Draft PR,
 * checks, sandbox, webhook, and preview operations are Task 5 side effects and
 * are deliberately absent from this compatibility analysis adapter.
 */
export function createGitHubAnalysisAdapter(configuration: GitHubAnalysisConfiguration): AnalysisAdapter {
  if (!configuration?.installation || typeof configuration.installation.resolve !== "function"
    || !configuration.tokens || typeof configuration.tokens.issue !== "function" || typeof configuration.tokens.revoke !== "function"
    || !configuration.snapshot || typeof configuration.snapshot.resolveRef !== "function" || typeof configuration.snapshot.readTree !== "function"
    || typeof configuration.clock !== "function" || typeof configuration.targetOrigin !== "string") {
    throw new Error("GITHUB_ANALYSIS_CONTROLS_REQUIRED");
  }
  return async (source, signal) => {
    if (source.sourceType !== "github") throw new Error("SOURCE_TYPE_UNSUPPORTED");
    if (!source.id || !source.organizationId || !source.projectId) throw new Error("GITHUB_SOURCE_OWNERSHIP_REQUIRED");
    const requested = githubSourceIdentity(source.sourceUrl);
    const selection = await configuration.installation.resolve({
      sourceUrl: source.sourceUrl,
      organizationId: source.organizationId,
      projectId: source.projectId,
      runId: source.id,
      signal,
    });
    if (selection.owner !== requested.owner || selection.repository !== requested.repository) {
      throw new Error("GITHUB_SOURCE_SELECTION_MISMATCH");
    }
    return withGitHubAppSession(selection, {
      clock: configuration.clock,
      tokens: configuration.tokens,
      signal,
    }, async (session) => {
      const snapshot = await captureGitHubSourceSnapshot(session, configuration.snapshot);
      const analysis = analyzeGitHubSourceSnapshot(snapshot, { targetOrigin: configuration.targetOrigin });
      if (analysis.plans.length === 0) {
        return {
          capabilities: [],
          diagnostics: analysis.diagnostics.map((diagnostic) => ({ ...diagnostic })),
          evidence: [analysis.evidence],
        };
      }
      const change = generateSourceNativeChange(snapshot, analysis);
      const changeContent = sourceNativeEvidenceContent(snapshot, change);
      const changeReference = `urn:sha256:${createHash("sha256").update(changeContent, "utf8").digest("hex")}`;
      return {
        capabilities: change.release.manifest.plans.map((plan) => ({ plan, status: "proposed" as const })),
        diagnostics: analysis.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        evidence: [analysis.evidence, { source: "source" as const, content: changeContent, reference: changeReference }],
        release: {
          code: change.release.code,
          contentHash: change.release.contentHash,
          allowedOrigin: change.release.allowedOrigin,
          manifest: change.release.manifest,
        },
      };
    });
  };
}

function assertWebsiteControls(configuration: WebsiteAnalysisConfiguration): void {
  if (!configuration?.provider?.resolver || typeof configuration.provider.resolver.resolve !== "function"
    || typeof configuration.provider.resolver.resolveTxt !== "function" || !configuration.provider.transport
    || typeof configuration.provider.transport.request !== "function" || !configuration.provider.hostedScriptOrigin
    || !configuration.ownership?.attestations || typeof configuration.ownership.attestations.consume !== "function"
    || !configuration.ownership.challenges || typeof configuration.ownership.challenges.load !== "function"
    || !configuration.ownership.replayStore || typeof configuration.ownership.replayStore.consume !== "function"
    || !configuration.browser?.controls || !configuration.browser.proxyPolicyReference || !configuration.browser.expiresAt
    || !/^[a-f0-9]{64}$/.test(configuration.browser.egressPolicyDigest ?? "")
    || !configuration.authentication || typeof configuration.authentication.status !== "function"
    || typeof configuration.authentication.resume !== "function" || typeof configuration.authentication.finalize !== "function"
    || typeof configuration.authentication.reconcile !== "function"
    || !configuration.explorer || typeof configuration.explorer.observe !== "function"
    || !configuration.evidenceStore || typeof configuration.evidenceStore.put !== "function"
    || typeof configuration.evidenceStore.get !== "function") {
    throw new Error("WEBSITE_ANALYSIS_CONTROLS_REQUIRED");
  }
}

function websiteTargetOriginDigest(targetOrigin: string): string {
  return createHash("sha256").update(targetOrigin, "utf8").digest("hex");
}

function checkpointRequest(
  source: AnalysisSource,
  targetOrigin: string,
): WebsiteAuthenticationCheckpointRequest {
  const checkpoint = source.authenticationCheckpoint;
  if (!checkpoint || !source.id || !source.organizationId || !source.projectId || !source.sourceSnapshotId
    || source.sourceSnapshotId !== checkpoint.sourceSnapshotId
    || source.sourceIdentityHash !== checkpoint.sourceIdentityHash
    || checkpoint.targetOriginDigest !== websiteTargetOriginDigest(targetOrigin)
    || !/^urn:sha256:[a-f0-9]{64}$/.test(checkpoint.checkpointReference)
    || !/^urn:sha256:[a-f0-9]{64}$/.test(checkpoint.authenticationEvidenceReference)
    || !Number.isFinite(Date.parse(checkpoint.expiresAt))) {
    throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_INVALID");
  }
  return {
    checkpointReference: checkpoint.checkpointReference,
    organizationId: source.organizationId,
    projectId: source.projectId,
    runId: source.id,
    sourceSnapshotId: checkpoint.sourceSnapshotId,
    sourceIdentityHash: checkpoint.sourceIdentityHash,
    targetOriginDigest: checkpoint.targetOriginDigest,
    expiresAt: checkpoint.expiresAt,
  };
}

export function assertWebsiteAuthenticationSignal(
  value: Readonly<{ authenticatedOrigin: string; observedAt: string; signals: readonly string[] }>,
  targetOrigin: string,
  expiresAt: string,
  now: Date,
): WebsiteObservationInput["authSignals"][number] {
  const allowed = new Set(["account_control", "authenticated_status", "logout_control"]);
  const exactKeys = ["authenticatedOrigin", "observedAt", "signals"];
  const observedAt = Date.parse(value?.observedAt);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== exactKeys.sort().join("\0")
    || value.authenticatedOrigin !== targetOrigin || !Number.isFinite(observedAt)
    || observedAt < now.getTime() - 5 * 60_000 || observedAt > Date.parse(expiresAt)
    || !Array.isArray(value.signals) || value.signals.length < 1 || value.signals.length > 3
    || value.signals.some((signal) => typeof signal !== "string" || !allowed.has(signal))
    || /authorization|bearer|cookie|password|token|secret|csrf|otp|session|credential|api[-_]?key|prompt/i
      .test(JSON.stringify(value))) {
    throw new Error("AUTH_STATE_UNVERIFIED");
  }
  return {
    origin: targetOrigin,
    observedAt: value.observedAt,
    signals: [...new Set(value.signals)].sort(),
  };
}

function assertAuthenticationCheckpointUnexpired(
  request: WebsiteAuthenticationCheckpointRequest,
  clock: () => Date,
): Date {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || Date.parse(request.expiresAt) <= now.getTime()) {
    throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_EXPIRED");
  }
  return now;
}

function compileWebsiteAnalysis(
  evidence: Awaited<ReturnType<typeof captureWebsiteEvidence>>,
  beforeEvidence: AnalysisResult["evidence"],
  sourceUrl: string,
  hostedScriptAllowed = true,
  afterEvidence: AnalysisResult["evidence"] = [],
): AnalysisResult {
  const proposed = proposeWebsiteCapabilityPlans(evidence);
  const release = proposed.plans.length > 0 ? compileWebMcpRelease([...proposed.plans]) : undefined;
  const diagnostics = [
    ...proposed.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    ...(!hostedScriptAllowed
      ? [{ code: "HOSTED_SCRIPT_CSP_BLOCKED", operationKey: sourceUrl, reason: "script_origin_not_allowed" }]
      : []),
  ];
  return {
    capabilities: release?.manifest.plans.map((plan) => ({ plan, status: "proposed" as const })) ?? [],
    diagnostics,
    evidence: [...beforeEvidence, evidence, ...afterEvidence],
    ...(release ? {
      release: {
        code: release.code,
        contentHash: release.contentHash,
        allowedOrigin: release.allowedOrigin,
        manifest: release.manifest,
      },
    } : {}),
  };
}

function mergedObservations(
  first: WebsiteObservationInput,
  second?: WebsiteObservationInput,
): WebsiteObservationInput {
  if (!second) return first;
  return {
    navigations: [...first.navigations, ...second.navigations],
    semanticTargets: [...first.semanticTargets, ...second.semanticTargets],
    network: [...first.network, ...second.network],
    forms: [...first.forms, ...second.forms],
    dom: [...first.dom, ...second.dom],
    authSignals: [...first.authSignals, ...second.authSignals],
    blockedMutations: [...first.blockedMutations, ...second.blockedMutations],
    stateTransitions: [...first.stateTransitions, ...second.stateTransitions],
  };
}

function preflightEvidenceContent(sourceUrl: string, preflight: Awaited<ReturnType<typeof preflightWebsiteSource>>): string {
  return JSON.stringify({
    adapter: "bounded-website-preflight",
    adapterVersion: 1,
    contentReference: preflight.contentReference,
    contentType: preflight.contentType,
    csp: preflight.csp,
    finalUrl: preflight.finalUrl,
    redirects: preflight.redirects,
    sourceUrl,
    targetOrigin: preflight.targetOrigin,
  });
}

export type WebsiteAuthenticationResumeConfiguration = Pick<
  WebsiteAnalysisConfiguration,
  "clock" | "authentication" | "explorer" | "evidenceStore"
>;

export async function resumeWebsiteAuthenticationAnalysis(
  source: AnalysisSource,
  signal: AbortSignal,
  configuration: WebsiteAuthenticationResumeConfiguration,
): Promise<AnalysisResult> {
  if (source.sourceType !== "website" || !source.organizationId || !source.projectId || !source.id
    || !source.sourceIdentityHash || !/^[a-f0-9]{64}$/.test(source.sourceIdentityHash)
    || !source.authenticationCheckpoint || typeof configuration?.authentication?.status !== "function"
    || typeof configuration.authentication.resume !== "function" || typeof configuration.authentication.finalize !== "function"
    || typeof configuration.authentication.reconcile !== "function" || typeof configuration.explorer?.observe !== "function"
    || typeof configuration.evidenceStore?.get !== "function" || typeof configuration.evidenceStore.put !== "function") {
    throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_INVALID");
  }
  let parsedSource: URL;
  try { parsedSource = new URL(source.sourceUrl); } catch { throw new Error("WEBSITE_URL_BLOCKED"); }
  const targetOrigin = parsedSource.origin;
  const request = checkpointRequest(source, targetOrigin);
  const clock = configuration.clock ?? (() => new Date());
  let outcome: WebsiteAuthenticationTerminalRequest["outcome"] = "failed";
  try {
    assertAuthenticationCheckpointUnexpired(request, clock);
    const status = await configuration.authentication.status(request);
    assertAuthenticationCheckpointUnexpired(request, clock);
    if (status.status !== "ready" || canonicalJson(status) !== canonicalJson({ ...request, status: "ready" })) {
      throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_INVALID");
    }
    const resumeInput = {
      ...request,
      authenticationEvidenceReference: source.authenticationCheckpoint.authenticationEvidenceReference,
    };
    const resumed = await configuration.authentication.resume({
      ...resumeInput,
    });
    const resumeNow = assertAuthenticationCheckpointUnexpired(request, clock);
    const exactResumeKeys = [
      ...Object.keys(resumeInput),
      "resumed",
      "cdpReference",
      "publicEvidenceReference",
      "suspensionAttestation",
      "authentication",
    ].sort();
    if (resumed.resumed !== true || resumed.checkpointReference !== request.checkpointReference
      || resumed.authenticationEvidenceReference !== source.authenticationCheckpoint.authenticationEvidenceReference
      || !/^secretref:[A-Za-z0-9._:-]{1,200}$/.test(resumed.cdpReference)
      || !/^urn:sha256:[a-f0-9]{64}$/.test(resumed.publicEvidenceReference)
      || Object.keys(resumed).sort().join("\0") !== exactResumeKeys.join("\0")
      || Object.entries(request).some(([key, value]) => canonicalJson(resumed[key as keyof typeof resumed]) !== canonicalJson(value))) {
      throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_INVALID");
    }
    let suspensionAttestation: BrowserUseSuspensionAttestation;
    try {
      suspensionAttestation = assertBrowserUseResumeAttestation(resumed.suspensionAttestation, request);
    } catch {
      throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_INVALID");
    }
    if (suspensionAttestation.cdpReference !== resumed.cdpReference
      || suspensionAttestation.publicEvidenceReference !== resumed.publicEvidenceReference) {
      throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_INVALID");
    }
    const authentication = assertWebsiteAuthenticationSignal(resumed.authentication, targetOrigin, request.expiresAt, resumeNow);
    const publicEvidence = await readWebsiteEvidence({
      reference: resumed.publicEvidenceReference,
      organizationId: source.organizationId,
      projectId: source.projectId,
      analysisRunId: source.id,
    }, configuration.evidenceStore);
    assertAuthenticationCheckpointUnexpired(request, clock);
    const authenticated = await configuration.explorer.observe({
      phase: "authenticated",
      targetOrigin,
      sourceUrl: source.sourceUrl,
      cdpReference: resumed.cdpReference,
      firewall: createDiscoveryFirewall([targetOrigin]),
      signal,
    });
    assertAuthenticationCheckpointUnexpired(request, clock);
    if (!authenticated || !authenticated.observations || authenticated.requiresAuthentication !== false) {
      throw new Error("WEBSITE_EXPLORER_RESPONSE_INVALID");
    }
    const authenticatedObservations: WebsiteObservationInput = {
      ...authenticated.observations,
      authSignals: [...authenticated.observations.authSignals, authentication],
    };
    const provider = JSON.parse(publicEvidence.content).provider as Record<string, unknown>;
    if (provider.apiVersion !== "v4" || provider.model !== "browser-use-2.0"
      || typeof provider.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(provider.policyDigest)) {
      throw new Error("WEBSITE_EVIDENCE_PROVIDER_INVALID");
    }
    const evidence = await captureWebsiteEvidence({
      organizationId: source.organizationId,
      projectId: source.projectId,
      runId: source.id,
      targetOrigin,
      provider: { apiVersion: "v4", model: "browser-use-2.0", policyDigest: provider.policyDigest },
      observations: mergedObservations(websiteObservationsFromEvidence(publicEvidence), authenticatedObservations),
    }, configuration.evidenceStore);
    assertAuthenticationCheckpointUnexpired(request, clock);
    outcome = "completed";
    return compileWebsiteAnalysis(evidence, [publicEvidence], source.sourceUrl);
  } catch (error) {
    if (signal.aborted) outcome = "cancelled";
    throw error;
  } finally {
    if (outcome !== "completed") {
      await finalizeWebsiteAuthentication(
        configuration,
        { ...request, outcome },
        source.authenticationCheckpoint.liveReceiptEvidence,
      );
    }
  }
}

/**
 * Creates the website analysis adapter only from explicit network, ownership,
 * browser, durable-auth, explorer, and immutable-evidence ports. No live
 * Browser Use or DNS implementation is selected implicitly.
 */
export function createWebsiteAnalysisAdapter(configuration: WebsiteAnalysisConfiguration): AnalysisAdapter {
  assertWebsiteControls(configuration);
  const analyze: AnalysisAdapter = async (source: AnalysisSource, signal: AbortSignal): Promise<AnalysisAdapterOutcome> => {
    if (source.sourceType !== "website") throw new Error("SOURCE_TYPE_UNSUPPORTED");
    if (!source.organizationId || !source.projectId || !source.id) throw new Error("WEBSITE_SOURCE_OWNERSHIP_REQUIRED");
    if (!source.sourceIdentityHash || !/^[0-9a-f]{64}$/.test(source.sourceIdentityHash)) {
      throw new Error("WEBSITE_SOURCE_ATTESTATION_REQUIRED");
    }
    const organizationId = source.organizationId;
    const projectId = source.projectId;
    const runId = source.id;
    if (source.authenticationCheckpoint) {
      return resumeWebsiteAuthenticationAnalysis(source, signal, configuration);
    }

    const preflight = await preflightWebsiteSource(source.sourceUrl, { ...configuration.provider, signal });
    const attestation = await configuration.ownership.attestations.consume({
      organizationId,
      projectId,
      runId,
      sourceIdentityHash: source.sourceIdentityHash,
      sourceUrl: source.sourceUrl,
      targetOrigin: preflight.targetOrigin,
    });
    if (attestation?.bound !== true || !/^[0-9a-f]{64}$/.test(attestation.challengeDigest)) {
      throw new Error("WEBSITE_SOURCE_ATTESTATION_REQUIRED");
    }
    const ownershipChallenge = await configuration.ownership.challenges.load({
      organizationId,
      projectId,
      runId,
      targetOrigin: preflight.targetOrigin,
    });
    if (createHash("sha256").update(ownershipChallenge.token, "utf8").digest("hex")
      !== attestation.challengeDigest) throw new Error("WEBSITE_SOURCE_ATTESTATION_MISMATCH");
    if (ownershipChallenge.targetOrigin !== preflight.targetOrigin) throw new Error("OWNERSHIP_ORIGIN_MISMATCH");
    const ownership = await verifyWebsiteOwnership(ownershipChallenge, {
      ...configuration.provider,
      replayStore: configuration.ownership.replayStore,
      clock: configuration.clock,
      signal,
    });
    if (!CONTENT_REFERENCE.test(ownership.reference)) throw new Error("WEBSITE_OWNERSHIP_EVIDENCE_INVALID");
    const preflightContent = preflightEvidenceContent(source.sourceUrl, preflight);
    const preflightReference = `urn:sha256:${createHash("sha256").update(preflightContent, "utf8").digest("hex")}`;
    const firewall = createDiscoveryFirewall([preflight.targetOrigin]);
    const browserResult = await withBrowserUseCloudV4Session({
      organizationId,
      projectId,
      runId,
      targetOrigin: preflight.targetOrigin,
      expiresAt: configuration.browser.expiresAt,
      proxyPolicyReference: configuration.browser.proxyPolicyReference,
    }, { ...configuration.browser.controls, signal }, async (session, sessionSignal) => {
      const first = await configuration.explorer.observe({
        phase: "unauthenticated",
        targetOrigin: preflight.targetOrigin,
        sourceUrl: preflight.finalUrl,
        cdpReference: session.cdpReference,
        firewall,
        signal: sessionSignal,
      });
      if (!first || !first.observations || typeof first.requiresAuthentication !== "boolean") {
        throw new Error("WEBSITE_EXPLORER_RESPONSE_INVALID");
      }
      if (first.requiresAuthentication) {
        if (!source.sourceSnapshotId) throw new Error("WEBSITE_SOURCE_SNAPSHOT_REQUIRED");
        const publicEvidence = await captureWebsiteEvidence({
          organizationId,
          projectId,
          runId,
          targetOrigin: preflight.targetOrigin,
          provider: { apiVersion: session.apiVersion, model: session.model, policyDigest: session.policyDigest },
          observations: first.observations,
        }, configuration.evidenceStore);
        const suspended = await session.suspend({
          sourceSnapshotId: source.sourceSnapshotId!,
          sourceIdentityHash: source.sourceIdentityHash!,
          targetOriginDigest: websiteTargetOriginDigest(preflight.targetOrigin),
          publicEvidenceReference: publicEvidence.reference,
          egressPolicyReference: configuration.browser.proxyPolicyReference.reference,
          egressPolicyDigest: configuration.browser.egressPolicyDigest,
        });
        return suspended;
      }
      const evidence = await captureWebsiteEvidence({
        organizationId,
        projectId,
        runId,
        targetOrigin: preflight.targetOrigin,
        provider: { apiVersion: session.apiVersion, model: session.model, policyDigest: session.policyDigest },
        observations: mergedObservations(first.observations),
      }, configuration.evidenceStore);
      return compileWebsiteAnalysis(evidence, [
        { source: ownership.source, content: ownership.content, reference: ownership.reference },
      ], source.sourceUrl, preflight.csp.allowsHostedScript, [
        { source: "source" as const, content: preflightContent, reference: preflightReference },
      ]);
    });
    if ("disposition" in browserResult && browserResult.disposition === "suspended") {
      const checkpoint = browserResult.checkpoint;
      return {
        disposition: "waiting_for_authentication",
        capabilities: [],
        diagnostics: [],
        evidence: [],
        checkpointReference: checkpoint.checkpointReference,
        sourceSnapshotId: checkpoint.sourceSnapshotId,
        sourceIdentityHash: checkpoint.sourceIdentityHash,
        targetOriginDigest: checkpoint.targetOriginDigest,
        expiresAt: checkpoint.expiresAt,
        suspensionEvidence: projectBrowserUseSuspensionEvidence(
          checkpoint,
          ownership.reference.slice("urn:sha256:".length),
        ),
      };
    }
    return browserResult as AnalysisResult;
  };
  analyze.finalizeAuthenticationCheckpoint = async (source) => {
    if (!source.organizationId || !source.projectId || !source.id || !source.sourceSnapshotId
      || !source.sourceIdentityHash || !source.authenticationCheckpoint) {
      throw new Error("WEBSITE_AUTHENTICATION_CHECKPOINT_INVALID");
    }
    return finalizeWebsiteAuthentication(configuration, {
      checkpointReference: source.authenticationCheckpoint.checkpointReference,
      organizationId: source.organizationId,
      projectId: source.projectId,
      runId: source.id,
      sourceSnapshotId: source.sourceSnapshotId,
      sourceIdentityHash: source.sourceIdentityHash,
      targetOriginDigest: source.authenticationCheckpoint.targetOriginDigest,
      expiresAt: source.authenticationCheckpoint.expiresAt,
      outcome: "completed",
    }, source.authenticationCheckpoint.liveReceiptEvidence);
  };
  analyze.reconcileAuthenticationCheckpoint = async (source, waiting, _signal, outcome = "failed") => {
    if (!source.organizationId || !source.projectId || !source.id) throw new Error("WEBSITE_SOURCE_OWNERSHIP_REQUIRED");
    const request: WebsiteAuthenticationTerminalRequest = {
      checkpointReference: waiting.checkpointReference,
      organizationId: source.organizationId,
      projectId: source.projectId,
      runId: source.id,
      sourceSnapshotId: waiting.sourceSnapshotId,
      sourceIdentityHash: waiting.sourceIdentityHash,
      targetOriginDigest: waiting.targetOriginDigest,
      expiresAt: waiting.expiresAt,
      outcome,
    };
    const reconciled = await configuration.authentication.reconcile(request);
    if (reconciled.reconciled !== true || reconciled.terminated !== true) {
      throw new Error("WEBSITE_AUTHENTICATION_RECONCILE_FAILED");
    }
    return attestedCleanupUpdates(
      source.liveReceiptEvidence ?? source.authenticationCheckpoint?.liveReceiptEvidence,
      [reconciled.cleanupResources],
    );
  };
  return analyze;
}

async function finalizeWebsiteAuthentication(
  configuration: WebsiteAuthenticationResumeConfiguration,
  terminal: WebsiteAuthenticationTerminalRequest,
  expected?: WebsiteLiveReceiptEvidence,
): Promise<readonly WebsiteAuthenticationCleanupResourceEvidence[]> {
  const errors: unknown[] = [];
  let finalizedCleanup: readonly WebsiteAuthenticationCleanupResourceEvidence[] | undefined;
  let reconciledCleanup: readonly WebsiteAuthenticationCleanupResourceEvidence[] | undefined;
  try {
    const finalized = await configuration.authentication.finalize(terminal);
    if (finalized.finalized !== true) errors.push(new Error("WEBSITE_AUTHENTICATION_FINALIZE_FAILED"));
    finalizedCleanup = finalized.cleanupResources;
  } catch (error) { errors.push(error); }
  try {
    const reconciled = await configuration.authentication.reconcile(terminal);
    if (reconciled.reconciled !== true || reconciled.terminated !== true) {
      errors.push(new Error("WEBSITE_AUTHENTICATION_RECONCILE_FAILED"));
    }
    reconciledCleanup = reconciled.cleanupResources;
  } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new Error("WEBSITE_AUTHENTICATION_CLEANUP_FAILED");
  return attestedCleanupUpdates(expected, [finalizedCleanup, reconciledCleanup]);
}

function attestedCleanupUpdates(
  expected: WebsiteLiveReceiptEvidence | undefined,
  outcomes: readonly (readonly WebsiteAuthenticationCleanupResourceEvidence[] | undefined)[],
): readonly WebsiteAuthenticationCleanupResourceEvidence[] {
  const present = outcomes.filter((outcome): outcome is readonly WebsiteAuthenticationCleanupResourceEvidence[] =>
    outcome !== undefined);
  if (present.length === 0) return [];
  if (!expected) throw new Error("WEBSITE_AUTHENTICATION_CLEANUP_EVIDENCE_INVALID");
  let advanced = [...expected.cleanupResources];
  try {
    for (const updates of present) advanced = advanceWebsiteCleanupResources(advanced, updates);
  } catch {
    throw new Error("WEBSITE_AUTHENTICATION_CLEANUP_EVIDENCE_INVALID");
  }
  const stored = new Map(expected.cleanupResources.map((item) => [item.resource, JSON.stringify(item)]));
  return advanced.filter((item) => stored.get(item.resource) !== JSON.stringify(item));
}
