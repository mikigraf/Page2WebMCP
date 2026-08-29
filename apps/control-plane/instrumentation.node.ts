export async function register(): Promise<void> {
  const { validateRuntimeConfiguration } = await import("./src/config.ts");
  validateRuntimeConfiguration();
  const { registerObservability } = await import("../../packages/observability/src/server.ts");
  await registerObservability();
}
