import { loadWebsiteGatewayConfiguration, websiteGatewayMissingConfiguration } from "./config.ts";
import { createWebsiteGatewayServer } from "./server.ts";
import { createBrowserUseCloudUpstream } from "./upstream/browser-use-cloud.ts";
import { createOwnershipVerifier } from "./ownership/verifier.ts";
import { createAuthenticationObserver, createCdpObserver } from "./observer/cdp-observer.ts";
import type { GatewayDependencies } from "./dependencies.ts";

/**
 * Startup fails closed. The only thing written to stderr is the sorted list of
 * configuration names that are absent or malformed: never a value.
 */
export function main(environment: NodeJS.ProcessEnv = process.env): void {
  const missing = websiteGatewayMissingConfiguration(environment);
  if (missing.length > 0) {
    process.stderr.write(`WEBSITE_GATEWAY_CONFIGURATION_REQUIRED ${missing.join(" ")}\n`);
    process.exitCode = 78;
    return;
  }
  const configuration = loadWebsiteGatewayConfiguration(environment);
  const clock = () => new Date();
  const dependencies: GatewayDependencies = {
    clock,
    ownershipVerifier: createOwnershipVerifier(),
    cdpObserver: createCdpObserver(clock),
    authenticationObserver: createAuthenticationObserver(clock),
    ...(configuration.controls.has("browser-use-v4")
      && configuration.browserUseUpstreamOrigin && configuration.browserUseUpstreamApiKey
      ? {
        browserUseUpstream: createBrowserUseCloudUpstream(
          configuration.browserUseUpstreamOrigin,
          configuration.browserUseUpstreamApiKey,
        ),
      }
      : {}),
  };
  const server = createWebsiteGatewayServer(configuration, dependencies);
  server.listen(configuration.port, configuration.bindAddress, () => {
    process.stdout.write(`website-gateway listening controls=${[...configuration.controls].sort().join(",")}\n`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close());
  }
}

main();
