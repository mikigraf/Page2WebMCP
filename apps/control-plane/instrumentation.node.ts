import { validateRuntimeConfiguration } from "./src/config.ts";
import { DeploymentIdentityConfigurationError } from "./src/deployment-identity.ts";
import { registerObservability } from "../../packages/observability/src/server.ts";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

type InstrumentationDependencies = Readonly<{
  validateConfiguration?: (environment: RuntimeEnvironment) => void;
  registerObservability?: () => Promise<void>;
  logError?: (line: string) => void;
}>;

export async function register(
  environment: RuntimeEnvironment = process.env,
  dependencies: InstrumentationDependencies = {},
): Promise<void> {
  try {
    (dependencies.validateConfiguration ?? validateRuntimeConfiguration)(environment);
  } catch (error) {
    if (error instanceof DeploymentIdentityConfigurationError) {
      (dependencies.logError ?? console.error)(JSON.stringify({
        level: "error",
        event: "control_plane_startup_failed",
        code: error.message,
        missingEnvironment: error.missingEnvironment,
      }));
    }
    throw error;
  }
  await (dependencies.registerObservability ?? registerObservability)();
}
