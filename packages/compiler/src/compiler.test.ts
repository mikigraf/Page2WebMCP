import test from "node:test";
import assert from "node:assert/strict";
import { compileWebMcpRelease } from "./compiler.ts";

test("compiler emits current imperative WebMCP registration without cross-origin exposure", () => {
  const release = compileWebMcpRelease([{ name: "find_order", description: "Find an order", readOnly: true }], "https://acme.example");
  assert.match(release.code, /document\.modelContext\.registerTool/);
  assert.match(release.code, /"additionalProperties":false/);
  assert.match(release.code, /signal: controller\.signal/);
  assert.doesNotMatch(release.code, /exposedTo/);
  assert.doesNotMatch(release.code, /navigator\.modelContext/);
});

test("compiler emits a self-hosted same-origin installer with immutable release metadata", () => {
  const release = compileWebMcpRelease([{ name: "create_support_ticket", description: "Create a ticket", readOnly: false, inputSchema: { type: "object", properties: { orderId: { type: "string" }, title: { type: "string" } }, required: ["orderId", "title"], additionalProperties: false } }], "https://acme.example");
  assert.match(release.code, /export const releaseManifest/);
  assert.match(release.code, /new URL\(path, window\.location\.origin\)/);
  assert.match(release.code, /credentials: "same-origin"/);
  assert.match(release.code, /registerPage2WebMCPTools/);
  assert.match(release.code, /"orderId"/);
  assert.match(release.code, /requiresConfirmation: true/);
  assert.match(release.contentHash, /^[a-f0-9]{64}$/);
});
