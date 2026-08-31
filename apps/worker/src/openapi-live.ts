import type { OpenApiGroupingPort } from "../../../packages/openapi/src/compile.ts";
import {
  fetchOpenApiSource,
  type OpenApiProviderControls,
} from "../../../packages/providers/src/openapi.ts";
import { createNodeOpenApiResolver, createNodeOpenApiTransport } from "./node-network.ts";
import { createOpenApiAnalysisAdapter, type AnalysisAdapter } from "./workflow.ts";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
const HOSTED_PUBLIC_ORIGIN =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const HASH = /^[0-9a-f]{64}$/;

export type OpenApiLiveDependencies = Readonly<{
  resolver?: OpenApiProviderControls["resolver"];
  transport?: OpenApiProviderControls["transport"];
  groupingPort?: OpenApiGroupingPort;
}>;

export type ConfiguredOpenApiProductionAdapter = Readonly<{
  analyze: AnalysisAdapter;
  probe(input: Readonly<{
    selectedReleaseHash: string;
    publicOrigin: string;
    signal: AbortSignal;
  }>): Promise<void>;
}>;

export function createConfiguredOpenApiProductionAdapter(
  environment: RuntimeEnvironment,
  dependencies: OpenApiLiveDependencies,
): ConfiguredOpenApiProductionAdapter {
  if (!environment || environment.PAGE2WEBMCP_PROVIDER_MODE !== "openapi" || !dependencies
    || dependencies.resolver !== undefined && typeof dependencies.resolver.resolve !== "function"
    || dependencies.transport !== undefined && typeof dependencies.transport.request !== "function"
    || dependencies.groupingPort !== undefined && typeof dependencies.groupingPort.group !== "function") {
    throw new Error("OPENAPI_LIVE_CONFIGURATION_REQUIRED");
  }
  const resolver = dependencies.resolver ?? createNodeOpenApiResolver();
  const transport = dependencies.transport ?? createNodeOpenApiTransport();
  const analyze = createOpenApiAnalysisAdapter({
    provider: { resolver, transport },
    ...(dependencies.groupingPort ? { groupingPort: dependencies.groupingPort } : {}),
  });
  return {
    analyze,
    async probe({ selectedReleaseHash, publicOrigin, signal }) {
      if (!HASH.test(selectedReleaseHash) || publicOrigin !== HOSTED_PUBLIC_ORIGIN || !(signal instanceof AbortSignal)) {
        throw new Error("OPENAPI_PROVIDER_PROBE_FAILED");
      }
      try {
        await fetchOpenApiSource(`${publicOrigin}/${selectedReleaseHash}.js`, {
          resolver,
          transport,
          maxBytes: 65_536,
          maxRedirects: 0,
          signal,
        });
      } catch (error) {
        // The immutable artifact is JavaScript, so reaching it through the
        // OpenAPI DNS/TLS policy must stop at the expected media-type gate.
        if (error instanceof Error && error.message === "OPENAPI_CONTENT_TYPE_BLOCKED") return;
        throw new Error("OPENAPI_PROVIDER_PROBE_FAILED");
      }
    },
  };
}

export function createConfiguredOpenApiAnalysisAdapter(
  environment: RuntimeEnvironment,
  dependencies: OpenApiLiveDependencies,
): AnalysisAdapter {
  return createConfiguredOpenApiProductionAdapter(environment, dependencies).analyze;
}
