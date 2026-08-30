import { createHash } from "node:crypto";
import type { AnalysisResult, ClaimedAnalysisRunRecord } from "../../../packages/database/src/control-plane.ts";
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
  awaitWebsiteAuthentication,
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

export type OpenApiAnalysisConfiguration = Readonly<{
  targetOrigin: string;
  testPageUrl: string;
  environment: "test" | "staging" | "production";
  provider: Omit<OpenApiProviderControls, "signal">;
  groupingPort?: OpenApiGroupingPort;
}>;

type AnalysisSource = Pick<ClaimedAnalysisRunRecord, "sourceType" | "sourceUrl">
  & Partial<Pick<ClaimedAnalysisRunRecord, "id" | "organizationId" | "projectId">>;
export type AnalysisAdapter = (source: AnalysisSource, signal: AbortSignal) => Promise<AnalysisResult>;

export type WebsiteAnalysisConfiguration = Readonly<{
  clock?: () => Date;
  provider: Omit<WebsiteProviderControls, "signal">;
  ownership: Readonly<{
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

function assertVerificationContext(configuration: OpenApiAnalysisConfiguration): void {
  if (!configuration) throw new Error("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
  let origin: URL;
  let page: URL;
  try {
    origin = new URL(configuration.targetOrigin);
    page = new URL(configuration.testPageUrl);
  } catch {
    throw new Error("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
  }
  if (origin.protocol !== "https:" || origin.origin !== configuration.targetOrigin || origin.username || origin.password
    || page.protocol !== "https:" || page.origin !== origin.origin || page.username || page.password
    || !["test", "staging", "production"].includes(configuration.environment)) {
    throw new Error("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
  }
}

function evidenceContent(
  sourceDigest: string,
  openApiVersion: string,
  configuration: Pick<OpenApiAnalysisConfiguration, "targetOrigin" | "testPageUrl" | "environment">,
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

/**
 * Creates the production OpenAPI adapter only when every network and verification
 * control is supplied explicitly. There is intentionally no implicit live fetcher.
 */
export function createOpenApiAnalysisAdapter(configuration: OpenApiAnalysisConfiguration): AnalysisAdapter {
  assertVerificationContext(configuration);
  if (!configuration?.provider?.resolver || !configuration.provider.transport) {
    throw new Error("OPENAPI_PROVIDER_CONTROLS_REQUIRED");
  }
  return async (source, signal) => {
    if (source.sourceType !== "openapi") throw new Error("SOURCE_TYPE_UNSUPPORTED");
    const fetched = await fetchOpenApiSource(source.sourceUrl, { ...configuration.provider, signal });
    const document = await validateOpenApiSource(fetched.source, fetched.format);
    const content = evidenceContent(fetched.evidenceReference, document.openapi, configuration);
    const reference = `urn:sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    const compiled = await compileOpenApiWithGrouping(document, {
      targetOrigin: configuration.targetOrigin,
      testPageUrl: configuration.testPageUrl,
      environment: configuration.environment,
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

function assertWebsiteControls(configuration: WebsiteAnalysisConfiguration): void {
  if (!configuration?.provider?.resolver || typeof configuration.provider.resolver.resolve !== "function"
    || typeof configuration.provider.resolver.resolveTxt !== "function" || !configuration.provider.transport
    || typeof configuration.provider.transport.request !== "function" || !configuration.provider.hostedScriptOrigin
    || !configuration.ownership?.challenges || typeof configuration.ownership.challenges.load !== "function"
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
    const organizationId = source.organizationId;
    const projectId = source.projectId;
    const runId = source.id;
    const preflight = await preflightWebsiteSource(source.sourceUrl, { ...configuration.provider, signal });
    const ownershipChallenge = await configuration.ownership.challenges.load({
      organizationId,
      projectId,
      runId,
      targetOrigin: preflight.targetOrigin,
    });
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
      let authEvidence: Awaited<ReturnType<typeof awaitWebsiteAuthentication>> | undefined;
      let second: Awaited<ReturnType<WebsiteAnalysisConfiguration["explorer"]["observe"]>> | undefined;
      if (first.requiresAuthentication) {
        if (!configuration.authentication?.store) throw new Error("AUTH_HANDOFF_CONTROLS_REQUIRED");
        authEvidence = await awaitWebsiteAuthentication({
          organizationId,
          projectId,
          runId,
          targetOrigin: preflight.targetOrigin,
          liveReference: session.liveReference,
          expiresAt: session.expiresAt,
        }, { store: configuration.authentication.store, clock: configuration.clock, signal: sessionSignal });
        second = await configuration.explorer.observe({
          phase: "authenticated",
          targetOrigin: preflight.targetOrigin,
          sourceUrl: preflight.finalUrl,
          cdpReference: session.cdpReference,
          firewall,
          signal: sessionSignal,
        });
        if (!second || !second.observations || typeof second.requiresAuthentication !== "boolean") {
          throw new Error("WEBSITE_EXPLORER_RESPONSE_INVALID");
        }
        if (second.requiresAuthentication) throw new Error("AUTH_STATE_UNVERIFIED");
      }
      const evidence = await captureWebsiteEvidence({
        organizationId,
        projectId,
        runId,
        targetOrigin: preflight.targetOrigin,
        provider: { apiVersion: session.apiVersion, model: session.model, policyDigest: session.policyDigest },
        observations: mergedObservations(first.observations, second?.observations),
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
          ...(authEvidence ? [{ source: authEvidence.source, content: authEvidence.content, reference: authEvidence.reference }] : []),
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
