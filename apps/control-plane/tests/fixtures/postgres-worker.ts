import { createHash } from "node:crypto";
import type { CapabilityPlan } from "../../../../packages/capability-ir/src/plan.ts";
import { compileWebMcpRelease } from "../../../../packages/compiler/src/compiler.ts";
import type { AnalysisResult, ClaimedAnalysisRunRecord, ControlPlaneRepository } from "../../../../packages/database/src/control-plane.ts";
import { getControlPlaneRepository } from "../../../../packages/database/src/factory.ts";
import { processNextAnalysis } from "../../../worker/src/runner.ts";

const repository = getControlPlaneRepository();
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown.abort());

try {
  while (!shutdown.signal.aborted) {
    const processed = await processNextAnalysis(repository, { analyze: analyzeFixtureSource });
    if (!processed) await delay(50, shutdown.signal);
  }
} finally {
  const close = (repository as ControlPlaneRepository & { close?: () => Promise<void> }).close;
  if (typeof close === "function") await close.call(repository);
}

async function analyzeFixtureSource(source: ClaimedAnalysisRunRecord): Promise<AnalysisResult> {
  const targetOrigin = new URL(source.sourceUrl).origin;
  const content = JSON.stringify({ adapter: "generic-topology-fixture", sourceUrl: source.sourceUrl, version: 1 });
  const reference = `urn:sha256:${createHash("sha256").update(content).digest("hex")}`;
  const plan: CapabilityPlan = {
    version: 1,
    targetOrigin,
    tool: { name: "create_widget", title: "Create widget", description: "Create one reversible widget." },
    schemas: {
      input: {
        type: "object",
        properties: { label: { type: "string", minLength: 1, maxLength: 120 } },
        required: ["label"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { id: { type: "string" }, label: { type: "string" } },
        required: ["id", "label"],
        additionalProperties: false,
      },
    },
    annotations: { readOnly: false, untrusted: false },
    authentication: { mode: "same_origin_cookie", requiredScopes: [] },
    effects: {
      kind: "mutation",
      riskTier: "R1",
      reversible: true,
      summary: "Creates one reversible widget.",
      confirmation: "always",
    },
    idempotency: { strategy: "header", headerName: "Idempotency-Key", verified: true, retry: "safe_once" },
    request: {
      adapter: "json_api",
      method: "POST",
      pathTemplate: "/api/widgets",
      path: {},
      query: {},
      body: { label: "label" },
    },
    response: {
      adapter: "json_api",
      contentTypes: ["application/json"],
      projection: { kind: "identity" },
      errorMappings: { "401": "AUTHENTICATION_REQUIRED", "403": "FORBIDDEN", default: "TARGET_ERROR" },
    },
    success: { adapter: "json_api", statusCodes: [201], requiredOutputFields: ["id", "label"] },
    evidence: [{ source: "runtime", reference }],
  };
  const release = compileWebMcpRelease([plan]);
  return {
    capabilities: [{ plan, status: "proposed" }],
    diagnostics: [],
    evidence: [{ source: "runtime", content, reference }],
    release,
  };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
