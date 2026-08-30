import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseWebMcpReleaseScript } from "../app/webmcp-release-script.tsx";

const hash = "a".repeat(64);
const integrity = `sha384-${Buffer.alloc(48, 7).toString("base64")}`;

test("Acme accepts only the common immutable release URL, exact SHA-256, SRI, and target origin", () => {
  assert.deepEqual(parseWebMcpReleaseScript({
    PAGE2WEBMCP_ACME_RELEASE_URL: `https://control.example/api/releases/${hash}.js`,
    PAGE2WEBMCP_ACME_RELEASE_CONTENT_HASH: hash,
    PAGE2WEBMCP_ACME_RELEASE_INTEGRITY: integrity,
    PAGE2WEBMCP_ACME_PUBLIC_ORIGIN: "https://acme.example",
  }), {
    src: `https://control.example/api/releases/${hash}.js`,
    integrity,
    contentHash: hash,
    targetOrigin: "https://acme.example",
  });
});

test("Acme release script fails closed for absent, mutable, corrupt, or cross-target metadata", () => {
  const valid = {
    PAGE2WEBMCP_ACME_RELEASE_URL: `https://control.example/api/releases/${hash}.js`,
    PAGE2WEBMCP_ACME_RELEASE_CONTENT_HASH: hash,
    PAGE2WEBMCP_ACME_RELEASE_INTEGRITY: integrity,
    PAGE2WEBMCP_ACME_PUBLIC_ORIGIN: "https://acme.example",
  };
  const cases = [
    {},
    { ...valid, PAGE2WEBMCP_ACME_RELEASE_URL: "https://control.example/api/releases/latest.js" },
    { ...valid, PAGE2WEBMCP_ACME_RELEASE_URL: `${valid.PAGE2WEBMCP_ACME_RELEASE_URL}?token=secret` },
    { ...valid, PAGE2WEBMCP_ACME_RELEASE_CONTENT_HASH: "0".repeat(64) },
    { ...valid, PAGE2WEBMCP_ACME_RELEASE_INTEGRITY: "sha384-corrupt*" },
    { ...valid, PAGE2WEBMCP_ACME_PUBLIC_ORIGIN: "https://other.example/path" },
  ];
  for (const environment of cases) assert.throws(() => parseWebMcpReleaseScript(environment), /WEBMCP_RELEASE_CONFIG_INVALID/);
});

test("Acme contains no blob loader, manual registration, or fixture compilation path", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const component = await readFile(new URL("../app/webmcp-release-script.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(`${layout}\n${component}`, /registerPage2WebMCPTools|unregisterPage2WebMCPTools|createObjectURL|Blob\(|webpackIgnore|compileWebMcpRelease/);
  assert.match(component, /type="module"/);
  assert.match(component, /crossOrigin="anonymous"/);
});
