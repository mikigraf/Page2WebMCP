import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CapabilityPlan } from "../../capability-ir/src/plan.ts";
import { compileWebMcpRelease, verifyWebMcpReleaseBytes } from "./compiler.ts";

const HASH = "a".repeat(64);

function plan(): CapabilityPlan {
  return {
    version: 1,
    targetOrigin: "https://integrity.example",
    tool: { name: "integrity_probe", title: "Integrity probe", description: "Read one integrity probe." },
    schemas: {
      input: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 20 } },
        required: ["query"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    annotations: { readOnly: true, untrusted: false },
    authentication: { mode: "same_origin_cookie", requiredScopes: [] },
    effects: { kind: "read", riskTier: "R0", reversible: true, summary: "Reads one probe.", confirmation: "none" },
    idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    request: { adapter: "json_api", method: "GET", pathTemplate: "/probe", path: {}, query: { q: "query" }, body: {} },
    response: {
      adapter: "json_api",
      contentTypes: ["application/json"],
      projection: { kind: "identity" },
      errorMappings: { default: "TARGET_ERROR" },
    },
    success: { adapter: "json_api", statusCodes: [200], requiredOutputFields: ["value"] },
    evidence: [{ source: "runtime", reference: `urn:sha256:${HASH}` }],
  };
}

test("compiler emits mandatory pre-evaluation integrity and runtime-renderer identity metadata", () => {
  const release = compileWebMcpRelease([plan()]);
  assert.equal(release.integrityRequired, true);
  assert.match(release.manifest.rendererId, /^[a-f0-9]{64}$/);
  assert.deepEqual(release.manifest.integrityPolicy, {
    enforcement: "trusted-loader-required",
    algorithms: ["sha256", "sha384"],
  });
  assert.equal(verifyWebMcpReleaseBytes(release.code, release), true);
});

test("duplicate-registration identity changes between renderer revisions for identical plans", () => {
  const release = compileWebMcpRelease([plan()]);
  const identity = (rendererId: string) => createHash("sha256").update(JSON.stringify({
    version: 3,
    rendererId,
    targetOrigin: release.manifest.targetOrigin,
    plans: release.manifest.plans,
  })).digest("hex");

  assert.equal(release.manifest.releaseId, identity(release.manifest.rendererId));
  assert.notEqual(release.manifest.releaseId, identity("0".repeat(64)));
});

test("trusted installation verification rejects a still-parseable altered artifact", () => {
  const release = compileWebMcpRelease([plan()]);
  const altered = release.code.replace("Read one integrity probe.", "Read one integrity Probe.");
  assert.notEqual(altered, release.code);
  assert.doesNotThrow(() => new Function(altered.replaceAll(/^export /gm, "")));
  assert.equal(verifyWebMcpReleaseBytes(altered, release), false);
});

test("compiler rejects an artifact larger than the persistence boundary", () => {
  const oversizedPlans = Array.from({ length: 40 }, (_, index) => ({
    ...plan(),
    tool: { ...plan().tool, name: `integrity_probe_${index}` },
  }));
  assert.throws(() => compileWebMcpRelease(oversizedPlans), /release|artifact|byte|large/i);
});
