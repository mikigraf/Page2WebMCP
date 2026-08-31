import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function read(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, root), "utf8");
}

function requireLiterals(document: string, literals: readonly string[], label: string): void {
  for (const literal of literals) {
    assert.ok(document.includes(literal), `${label} must document ${literal}`);
  }
}

test("operator documentation records the pinned local-live topology without fixture conflation", async () => {
  const [readme, operations, packageJson] = await Promise.all([
    read("README.md"),
    read("docs/OPERATIONS.md"),
    read("package.json"),
  ]);
  const manifest = JSON.parse(packageJson) as { devDependencies?: Record<string, string> };
  assert.equal(manifest.devDependencies?.supabase, "2.116.0");

  requireLiterals(`${readme}\n${operations}`, [
    "Node.js 24",
    "pnpm 10.14.0",
    "Supabase CLI 2.116.0",
    "pnpm exec supabase --version",
    "pnpm local:up",
    "pnpm local:reset",
    "pnpm local:status",
    "pnpm local:down",
    "pnpm dev:local-live",
    "http://127.0.0.1:54321",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "http://127.0.0.1:54323",
    "http://127.0.0.1:54324",
    "page2webmcp_app_local",
    "page2webmcp_worker_local",
    "page2webmcp_maintenance_local",
  ], "local-live guide");

  assert.match(`${readme}\n${operations}`, /Acme[^\n]{0,160}(?:fixture|test-only)/i);
  assert.match(`${readme}\n${operations}`, /local-live[^\n]{0,240}liveSuccess[^\n]{0,40}false/i);
  assert.match(`${readme}\n${operations}`, /hermetic[^\n]{0,240}liveSuccess[^\n]{0,40}false/i);
});

test("operator surfaces enumerate all three real provider and verifier controls", async () => {
  const [environment, operations] = await Promise.all([
    read(".env.example"),
    read("docs/OPERATIONS.md"),
  ]);
  const operatorSurface = `${environment}\n${operations}`;
  requireLiterals(operatorSurface, [
    "PAGE2WEBMCP_PROVIDER_MODE=openapi",
    "PAGE2WEBMCP_PROVIDER_MODE=website",
    "PAGE2WEBMCP_PROVIDER_MODE=github",
    "PAGE2WEBMCP_BROWSER_USE_API_KEY",
    "PAGE2WEBMCP_BROWSER_USE_API_ORIGIN",
    "PAGE2WEBMCP_EGRESS_PROXY_ORIGIN",
    "PAGE2WEBMCP_EGRESS_PROXY_TOKEN",
    "PAGE2WEBMCP_EGRESS_POLICY_ORIGIN",
    "PAGE2WEBMCP_EGRESS_POLICY_TOKEN",
    "PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN",
    "PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN",
    "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID",
    "PAGE2WEBMCP_SECRET_STORE_ORIGIN",
    "PAGE2WEBMCP_SECRET_STORE_TOKEN",
    "PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN",
    "PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN",
    "PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN",
    "PAGE2WEBMCP_AUTH_HANDOFF_TOKEN",
    "PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN",
    "PAGE2WEBMCP_EVIDENCE_STORE_TOKEN",
    "PAGE2WEBMCP_CDP_OBSERVER_ORIGIN",
    "PAGE2WEBMCP_CDP_OBSERVER_TOKEN",
    "PAGE2WEBMCP_GITHUB_APP_ID",
    "PAGE2WEBMCP_GITHUB_PRIVATE_KEY_BASE64",
    "PAGE2WEBMCP_GITHUB_REPOSITORY_BINDINGS",
    "PAGE2WEBMCP_GITHUB_SANDBOX_ORIGIN",
    "PAGE2WEBMCP_GITHUB_SANDBOX_TOKEN",
    "PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN",
    "PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN",
    "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
    "PAGE2WEBMCP_READINESS_RELEASE_HASH",
  ], "provider guide");

  requireLiterals(operations, [
    "WEBSITE_LIVE_CONFIGURATION_REQUIRED",
    "GITHUB_LIVE_CONFIGURATION_REQUIRED",
    "OPENAPI_LIVE_CONFIGURATION_REQUIRED",
    "LIVE_INSTALLATION_EVIDENCE_REQUIRED",
    "browser-use-2.0",
    "idempotent draft PR",
    "Never merge",
  ], "fail-closed guide");
});

test("Storage and hosted-project documentation is exact and does not authorize another Supabase project", async () => {
  const [environment, operations] = await Promise.all([
    read(".env.example"),
    read("docs/OPERATIONS.md"),
  ]);
  const operatorSurface = `${environment}\n${operations}`;
  requireLiterals(operatorSurface, [
    "PAGE2WEBMCP_SUPABASE_URL",
    "PAGE2WEBMCP_SUPABASE_SECRET_KEY",
    "PAGE2WEBMCP_PUBLIC_ORIGIN",
    "page2webmcp-releases",
    "<sha256>.js",
    "bimqgiedckdurqiywctl",
    "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
  ], "Storage guide");
  assert.match(operations, /hosted[^\n]{0,180}credentials[^\n]{0,120}(?:required|absent|missing)/i);
  assert.match(operations, /Fullbeam[^\n]{0,120}(?:never|must not|do not)/i);
  assert.match(operations, /exact candidate bytes/i);
  assert.match(operations, /SHA-256[^\n]{0,120}SHA-384/i);
});

test("documentation explains exclusive readiness modes and truthful exit semantics", async () => {
  const operations = await read("docs/OPERATIONS.md");
  requireLiterals(operations, [
    "--hermetic",
    "--local-live",
    "--live",
    "HERMETIC_READINESS_PASSED",
    "LOCAL_LIVE_READINESS_PASSED",
    "LIVE_READINESS_PASSED",
    "LIVE_CONTROLS_REQUIRED",
    "LIVE_INSTALLATION_EVIDENCE_REQUIRED",
  ], "readiness guide");
  assert.match(operations, /exactly one[^\n]{0,120}--hermetic[^\n]{0,120}--local-live[^\n]{0,120}--live/i);
  assert.match(operations, /normal[^\n]{0,120}unintercepted[^\n]{0,120}native WebMCP/i);
  assert.match(operations, /--live[^\n]{0,240}ignores[^\n]{0,120}PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN/i);
});
