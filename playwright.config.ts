import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3200", headless: true },
  webServer: [
    { command: "pnpm exec next dev --port 3200", cwd: "apps/acme-support", url: "http://127.0.0.1:3200", reuseExistingServer: false, timeout: 60_000, gracefulShutdown: { signal: "SIGTERM", timeout: 0 } },
    { command: "pnpm exec next dev --port 3100", cwd: "apps/control-plane", url: "http://127.0.0.1:3100", reuseExistingServer: false, timeout: 60_000, gracefulShutdown: { signal: "SIGTERM", timeout: 0 } }
  ]
});
