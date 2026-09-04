type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The browser demo is deliberately hermetic. It is available only when the
 * caller opts into the local fixture provider and ephemeral storage; the
 * production configuration validator rejects this combination.
 */
export function localFixtureRuntimeEnabled(
  environment: RuntimeEnvironment = process.env,
): boolean {
  return environment.NODE_ENV !== "production"
    && environment.PAGE2WEBMCP_PROVIDER_MODE === "local"
    && (environment.PAGE2WEBMCP_STORAGE_MODE ?? "memory") === "memory"
    && environment.PAGE2WEBMCP_TEST_MODE === "true"
    && environment.PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE === "true";
}
