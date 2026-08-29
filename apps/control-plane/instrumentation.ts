export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { register } = await import("./instrumentation.node.ts");
    await register();
  }
}
