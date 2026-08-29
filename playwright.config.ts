import { defineConfig } from "@playwright/test";

const controlPlanePort = validPort(process.env.PAGE2WEBMCP_E2E_CONTROL_PORT, 3100);
const acmePort = validPort(process.env.PAGE2WEBMCP_E2E_ACME_PORT, 3200);
const controlPlaneUrl = `http://127.0.0.1:${controlPlanePort}`;
const acmeUrl = `http://127.0.0.1:${acmePort}`;
const production = process.env.CI === "true" || process.env.PAGE2WEBMCP_E2E_PRODUCTION === "true";
const ownerPassword = process.env.PAGE2WEBMCP_OWNER_PASSWORD ?? "page2webmcp-e2e-owner-password-2026";
const editorPassword = process.env.PAGE2WEBMCP_EDITOR_PASSWORD ?? "page2webmcp-e2e-editor-password-2026";
process.env.PAGE2WEBMCP_E2E_CONTROL_URL = controlPlaneUrl;
process.env.PAGE2WEBMCP_E2E_ACME_URL = acmeUrl;
process.env.PAGE2WEBMCP_OWNER_PASSWORD = ownerPassword;
process.env.PAGE2WEBMCP_EDITOR_PASSWORD = editorPassword;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: acmeUrl,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command: `pnpm exec next ${production ? "start" : "dev"} --port ${acmePort}`,
      cwd: "apps/acme-support",
      env: { ...process.env, PAGE2WEBMCP_ACME_PUBLIC_ORIGIN: acmeUrl },
      url: acmeUrl,
      reuseExistingServer: false,
      timeout: 90_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 }
    },
    {
      command: `pnpm exec next ${production ? "start" : "dev"} --port ${controlPlanePort}`,
      cwd: "apps/control-plane",
      env: {
        ...process.env,
        PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE: "true",
        PAGE2WEBMCP_TEST_MODE: "true",
        PAGE2WEBMCP_SESSION_SECRET: "page2webmcp-e2e-session-secret-2026",
        PAGE2WEBMCP_OWNER_PASSWORD: ownerPassword,
        PAGE2WEBMCP_EDITOR_PASSWORD: editorPassword,
        PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: controlPlaneUrl,
        PAGE2WEBMCP_STORAGE_MODE: "memory"
      },
      url: controlPlaneUrl,
      reuseExistingServer: false,
      timeout: 90_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 }
    }
  ]
});

function validPort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error("INVALID_E2E_PORT");
  return port;
}
