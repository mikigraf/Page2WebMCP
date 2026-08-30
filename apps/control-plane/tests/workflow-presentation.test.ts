import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityPlan } from "../../../packages/capability-ir/src/plan.ts";
import {
  capabilityReviewPresentation,
  workflowPresentation,
} from "../src/workflow-presentation.ts";

const plan: CapabilityPlan = {
  version: 1,
  targetOrigin: "https://widgets.example",
  tool: { name: "create_widget", title: "Create widget", description: "Create one widget." },
  schemas: {
    input: {
      type: "object",
      properties: { title: { type: "string", minLength: 3, maxLength: 120 } },
      required: ["title"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { id: { type: "string", maxLength: 64 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  annotations: { readOnly: false, untrusted: false },
  authentication: { mode: "same_origin_cookie", requiredScopes: ["widgets:write"] },
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
    body: { title: "title" },
  },
  response: {
    adapter: "json_api",
    contentTypes: ["application/json"],
    projection: { kind: "object", fields: { id: "id" } },
    errorMappings: { "401": "AUTHENTICATION_REQUIRED", "422": "VALIDATION_FAILED" },
  },
  success: { adapter: "json_api", statusCodes: [201], requiredOutputFields: ["id"] },
  evidence: [{ source: "github", reference: `urn:sha256:${"a".repeat(64)}` }],
};

test("capability review presents the exact reviewed schema, auth, effects, request, and provenance", () => {
  const presented = capabilityReviewPresentation({
    id: "capability-1",
    stableName: "create_widget",
    riskTier: "R1",
    status: "proposed",
    version: 7,
    plan,
    planDigest: "b".repeat(64),
  });

  assert.deepEqual(presented, {
    title: "Create widget",
    stableName: "create_widget",
    version: 7,
    planDigest: "b".repeat(64),
    risk: { tier: "R1", effect: "mutation", reversible: true, confirmation: "always", summary: "Creates one reversible widget." },
    authentication: { mode: "same_origin_cookie", requiredScopes: ["widgets:write"], csrf: false },
    request: { adapter: "json_api", method: "POST", target: "/api/widgets", idempotency: "header / safe_once / verified" },
    schemas: { input: plan.schemas.input, output: plan.schemas.output },
    provenance: [{ source: "github", reference: `urn:sha256:${"a".repeat(64)}` }],
  });
});

test("workflow presentation exposes durable ownership, browser auth, review, cancellation, retry, and conflict states", () => {
  const ownership = workflowPresentation({
    sourceType: "website",
    run: { id: "workflow-1", status: "waiting", currentPhase: "ownership", version: 3 },
    tasks: [{ phase: "ownership", status: "waiting", waitReason: "ownership_proof" }],
    diagnostics: [],
  });
  assert.equal(ownership.state, "ownership_required");
  assert.deepEqual(ownership.actions.map(({ id, enabled }) => [id, enabled]), [
    ["resume", true], ["cancel", true], ["retry", false],
  ]);

  const auth = workflowPresentation({
    sourceType: "website",
    run: { id: "workflow-2", status: "waiting", currentPhase: "browser_auth", version: 4 },
    tasks: [{ phase: "browser_auth", status: "waiting", waitReason: "live_auth_handoff" }],
    diagnostics: [],
  });
  assert.equal(auth.state, "browser_auth_required");

  const review = workflowPresentation({
    sourceType: "openapi",
    run: { id: "workflow-3", status: "waiting", currentPhase: "review_wait", version: 5 },
    tasks: [{ phase: "review_wait", status: "waiting", waitReason: "owner_review" }],
    diagnostics: [],
  });
  assert.equal(review.state, "review_required");

  const failed = workflowPresentation({
    sourceType: "github",
    run: { id: "workflow-4", status: "failed", currentPhase: "publish", version: 8, errorCode: "GITHUB_REVOKED" },
    tasks: [{ phase: "publish", status: "failed", errorCode: "GITHUB_REVOKED" }],
    diagnostics: [],
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.actions.find(({ id }) => id === "retry")?.enabled, true);

  const conflict = workflowPresentation({
    sourceType: "website",
    run: { id: "workflow-5", status: "waiting", currentPhase: "review_wait", version: 9 },
    tasks: [{ phase: "review_wait", status: "waiting" }],
    diagnostics: [],
    versionConflict: { expected: 8, actual: 9 },
  });
  assert.equal(conflict.state, "version_conflict");
  assert.equal(conflict.actions.find(({ id }) => id === "refresh")?.enabled, true);
});

test("unsupported and high-risk diagnostics never present publish or install as ready", () => {
  const presented = workflowPresentation({
    sourceType: "openapi",
    diagnostics: [
      { code: "SERVER_ADAPTER_REQUIRED", operationKey: "POST /admin" },
      { code: "HIGH_RISK_ACTION", operationKey: "DELETE /accounts/{id}" },
    ],
  });

  assert.equal(presented.state, "unsupported");
  assert.equal(presented.productionReady, false);
  assert.equal(presented.actions.find(({ id }) => id === "publish")?.enabled, false);
  assert.equal(presented.actions.find(({ id }) => id === "install")?.enabled, false);
  assert.deepEqual(presented.diagnostics.map(({ code }) => code), ["HIGH_RISK_ACTION", "SERVER_ADAPTER_REQUIRED"]);
});

test("verified releases expose truthful copy, download, self-host, and installed-check actions", () => {
  const presented = workflowPresentation({
    sourceType: "website",
    run: { id: "workflow-6", status: "succeeded", currentPhase: "install_verify", version: 12 },
    tasks: [{ phase: "install_verify", status: "succeeded" }],
    diagnostics: [],
    verification: { eligible: true, checks: [{ name: "trusted_loader", status: "passed" }] },
    release: {
      url: "https://control.example/api/releases/abc.js",
      downloadUrl: "https://control.example/api/releases/abc.js?download=1",
      selfHostRequired: true,
    },
    installation: { status: "pending_self_host" },
  });

  assert.equal(presented.state, "self_host_required");
  assert.deepEqual(presented.actions.filter(({ enabled }) => enabled).map(({ id }) => id), [
    "copy_script", "download", "self_host", "installed_check",
  ]);
  assert.equal(presented.productionReady, false);
});
