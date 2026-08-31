import type { OpenApiGroupingPort } from "../../../packages/openapi/src/compile.ts";
import type { OpenApiProviderControls } from "../../../packages/providers/src/openapi.ts";
import { createNodeOpenApiResolver, createNodeOpenApiTransport } from "./node-network.ts";
import { createOpenApiAnalysisAdapter, type AnalysisAdapter } from "./workflow.ts";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type OpenApiLiveDependencies = Readonly<{
  resolver?: OpenApiProviderControls["resolver"];
  transport?: OpenApiProviderControls["transport"];
  groupingPort?: OpenApiGroupingPort;
}>;

export function createConfiguredOpenApiAnalysisAdapter(
  environment: RuntimeEnvironment,
  dependencies: OpenApiLiveDependencies,
): AnalysisAdapter {
  if (!environment || environment.PAGE2WEBMCP_PROVIDER_MODE !== "openapi" || !dependencies
    || dependencies.resolver !== undefined && typeof dependencies.resolver.resolve !== "function"
    || dependencies.transport !== undefined && typeof dependencies.transport.request !== "function"
    || dependencies.groupingPort !== undefined && typeof dependencies.groupingPort.group !== "function") {
    throw new Error("OPENAPI_LIVE_CONFIGURATION_REQUIRED");
  }
  const resolver = dependencies.resolver ?? createNodeOpenApiResolver();
  const transport = dependencies.transport ?? createNodeOpenApiTransport();
  return createOpenApiAnalysisAdapter({
    provider: { resolver, transport },
    ...(dependencies.groupingPort ? { groupingPort: dependencies.groupingPort } : {}),
  });
}
