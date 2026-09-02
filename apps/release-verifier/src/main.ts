import { loadVerifierConfig } from "./config.ts";
import { logEvent } from "./logging.ts";
import { startVerifierServer } from "./server.ts";

/**
 * Entry point. Configuration is validated before the socket is opened, so a misconfigured
 * deployment fails closed at startup with the sorted list of missing variable names rather than
 * answering requests it cannot honestly verify.
 */
async function main(): Promise<void> {
  const config = loadVerifierConfig(process.env);
  const server = await startVerifierServer(config);
  logEvent("release_verifier_started", {
    mode: config.mode,
    targetOrigins: config.allowedTargetOrigins.length,
    durableReplayStore: config.replayStorePath !== "",
    headless: config.browser.headless,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void server.close().then(() => {
        logEvent("release_verifier_stopped", { signal });
        process.exit(0);
      });
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "RELEASE_VERIFIER_STARTUP_FAILED"}\n`);
  process.exit(1);
});
