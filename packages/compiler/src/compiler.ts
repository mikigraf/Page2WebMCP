import { createHash } from "node:crypto";

export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
export type CompilableCapability = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema?: JsonSchema;
  untrustedContent?: boolean;
  requiresConfirmation?: boolean;
};
export type CompiledRelease = { code: string; contentHash: string; allowedOrigin: string };

export function compileWebMcpRelease(capabilities: CompilableCapability[], allowedOrigin: string): CompiledRelease {
  const definitions = capabilities.map((capability) => `
  await document.modelContext.registerTool({
    name: ${JSON.stringify(capability.name)},
    description: ${JSON.stringify(capability.description)},
    inputSchema: ${JSON.stringify(capability.inputSchema ?? { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false })},
    annotations: { readOnlyHint: ${capability.readOnly}, untrustedContentHint: ${capability.untrustedContent ?? false} },
    execute: async (input, { signal }) => execute(${JSON.stringify(capability.name)}, input, signal, { requiresConfirmation: ${capability.requiresConfirmation ?? !capability.readOnly} })
  }, { signal: controller.signal });`).join("\n");
  const manifest = { version: 1, allowedOrigin, tools: capabilities.map(({ name, readOnly, requiresConfirmation = !readOnly }) => ({ name, readOnly, requiresConfirmation })) };
  const code = `"use strict";
export const releaseManifest = Object.freeze(${JSON.stringify(manifest)});
const controllers = new Map();
export async function executeSameOrigin(path, init = {}) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("ORIGIN_LOCKED");
  const response = await fetch(url, { ...init, credentials: "same-origin" });
  if (!response.ok) throw new Error("TOOL_REQUEST_FAILED");
  return response.json();
}
export async function registerPage2WebMCPTools(execute) {
  if (!document.modelContext) return { supported: false, reason: "WEBMCP_UNAVAILABLE" };
  const controller = new AbortController();
  controllers.set("${createHash("sha256").update(allowedOrigin).digest("hex")}", controller);${definitions}
  return { supported: true };
}
export function unregisterPage2WebMCPTools() {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
}`;
  return { code, contentHash: createHash("sha256").update(code).digest("hex"), allowedOrigin };
}
