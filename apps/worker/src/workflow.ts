import { createHash } from "node:crypto";
import {
  parsePersistedSourceConfiguration,
  type AnalysisResult,
  type ClaimedAnalysisRunRecord,
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
  withBrowserUseCloudV4Session,
  type BrowserUseCloudV4Controls,
  type WebsiteAuthControls,
} from "../../../packages/providers/src/browser-use-v4.ts";
import {
  captureWebsiteEvidence,
  proposeWebsiteCapabilityPlans,
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
    "id" | "organizationId" | "projectId" | "sourceConfiguration" | "leaseGeneration">>
  & Readonly<{ sourceIdentityHash?: string }>;
export type AnalysisAdapter = (source: AnalysisSource, signal: AbortSignal) => Promise<AnalysisResult>;

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
    controls: Omit<BrowserUseCloudV4Controls, "signal">;
  }>;
  authentication?: Readonly<{ store: WebsiteAuthControls["store"] }>;
  explorer: {
    observe(input: Readonly<{
      phase: "public" | "authenticated";
      targetOrigin: string;
      sourceUrl: string;
      cdpReference: string;
      firewall: ReturnType<typeof createDiscoveryFirewall>;
      signal: AbortSignal;
    }>): Promise<Readonly<{ observations: WebsiteObservationInput; requiresAuthentication: boolean }>>;
  };
  evidenceStore: WebsiteEvidenceStore;
}>;

type OpenApiVerificationConfiguration = Extract<ClaimedAnalysisRunRecord["sourceConfiguration"], { kind: "openapi" }>;

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
      };
    }
    const release = compileWebMcpRelease(compiled.plans);
    return {
      capabilities: release.manifest.plans.map((plan) => ({ plan, status: "proposed" as const })),
      diagnostics: compiled.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      evidence: [{ source: "openapi", content, reference }],
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
    || !configuration.explorer || typeof configuration.explorer.observe !== "function"
    || !configuration.evidenceStore || typeof configuration.evidenceStore.put !== "function") {
    throw new Error("WEBSITE_ANALYSIS_CONTROLS_REQUIRED");
  }
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

/**
 * Creates the website analysis adapter only from explicit network, ownership,
 * browser, durable-auth, explorer, and immutable-evidence ports. No live
 * Browser Use or DNS implementation is selected implicitly.
 */
export function createWebsiteAnalysisAdapter(configuration: WebsiteAnalysisConfiguration): AnalysisAdapter {
  assertWebsiteControls(configuration);
  return async (source, signal) => {
    if (source.sourceType !== "website") throw new Error("SOURCE_TYPE_UNSUPPORTED");
    if (!source.organizationId || !source.projectId || !source.id) throw new Error("WEBSITE_SOURCE_OWNERSHIP_REQUIRED");
    if (!source.sourceIdentityHash || !/^[0-9a-f]{64}$/.test(source.sourceIdentityHash)) {
      throw new Error("WEBSITE_SOURCE_ATTESTATION_REQUIRED");
    }
    const organizationId = source.organizationId;
    const projectId = source.projectId;
    const runId = source.id;
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
    const preflightContent = preflightEvidenceContent(source.sourceUrl, preflight);
    const preflightReference = `urn:sha256:${createHash("sha256").update(preflightContent, "utf8").digest("hex")}`;
    const firewall = createDiscoveryFirewall([preflight.targetOrigin]);
    return withBrowserUseCloudV4Session({
      organizationId,
      projectId,
      runId,
      targetOrigin: preflight.targetOrigin,
      expiresAt: configuration.browser.expiresAt,
      proxyPolicyReference: configuration.browser.proxyPolicyReference,
    }, { ...configuration.browser.controls, signal }, async (session, sessionSignal) => {
      const first = await configuration.explorer.observe({
        phase: "public",
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
        // The current analysis job is monolithic and cannot release its worker
        // lease/browser session at a durable human boundary. Fail closed until
        // authentication is a checkpointed workflow phase; never expose a
        // short-lived URL that the control plane cannot safely resume.
        throw new Error("WEBSITE_DURABLE_AUTHENTICATION_HANDOFF_REQUIRED");
      }
      const evidence = await captureWebsiteEvidence({
        organizationId,
        projectId,
        runId,
        targetOrigin: preflight.targetOrigin,
        provider: { apiVersion: session.apiVersion, model: session.model, policyDigest: session.policyDigest },
        observations: mergedObservations(first.observations),
      }, configuration.evidenceStore);
      const proposed = proposeWebsiteCapabilityPlans(evidence);
      const release = proposed.plans.length > 0 ? compileWebMcpRelease([...proposed.plans]) : undefined;
      const diagnostics = [
        ...proposed.diagnostics.map((diagnostic) => ({ ...diagnostic })),
        ...(!preflight.csp.allowsHostedScript
          ? [{ code: "HOSTED_SCRIPT_CSP_BLOCKED", operationKey: source.sourceUrl, reason: "script_origin_not_allowed" }]
          : []),
      ];
      return {
        capabilities: release?.manifest.plans.map((plan) => ({ plan, status: "proposed" as const })) ?? [],
        diagnostics,
        evidence: [
          { source: ownership.source, content: ownership.content, reference: ownership.reference },
          evidence,
          { source: "source" as const, content: preflightContent, reference: preflightReference },
        ],
        ...(release ? {
          release: {
            code: release.code,
            contentHash: release.contentHash,
            allowedOrigin: release.allowedOrigin,
            manifest: release.manifest,
          },
        } : {}),
      };
    });
  };
}
