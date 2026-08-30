import { createHash } from "node:crypto";
import type { AnalysisResult, ClaimedAnalysisRunRecord } from "../../../packages/database/src/control-plane.ts";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import {
  compileOpenApiWithGrouping,
  validateOpenApiSource,
  type OpenApiGroupingPort,
} from "../../../packages/openapi/src/compile.ts";
import { fetchOpenApiSource, type OpenApiProviderControls } from "../../../packages/providers/src/openapi.ts";

export type OpenApiAnalysisConfiguration = Readonly<{
  targetOrigin: string;
  testPageUrl: string;
  environment: "test" | "staging" | "production";
  provider: Omit<OpenApiProviderControls, "signal">;
  groupingPort?: OpenApiGroupingPort;
}>;

type AnalysisSource = Pick<ClaimedAnalysisRunRecord, "sourceType" | "sourceUrl">;
export type AnalysisAdapter = (source: AnalysisSource, signal: AbortSignal) => Promise<AnalysisResult>;

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
