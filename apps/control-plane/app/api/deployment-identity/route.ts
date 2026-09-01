import {
  configuredDeploymentIdentity,
  type DeploymentIdentityDependencies,
} from "../../../src/deployment-identity.ts";

export const dynamic = "force-dynamic";

export function deploymentIdentityResponse(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: DeploymentIdentityDependencies = {},
): Promise<Response> {
  if (environment.PAGE2WEBMCP_LOCAL_STACK === "true") {
    return Promise.resolve(Response.json({
      schema: "DeploymentIdentityUnavailableV1",
      code: "LOCAL_ONLY",
      liveSuccess: false,
    }, { status: 404, headers: { "cache-control": "no-store" } }));
  }
  return Promise.resolve(Response.json(configuredDeploymentIdentity(environment, dependencies), {
    status: 200,
    headers: { "cache-control": "no-store" },
  }));
}

export async function GET(): Promise<Response> {
  return deploymentIdentityResponse(process.env);
}
