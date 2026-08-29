import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityPlanSchema, canonicalizeCapabilityPlans, type CapabilityPlan } from "./plan.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function readPlan(overrides: Record<string, unknown> = {}): CapabilityPlan {
  return {
    version: 1,
    targetOrigin: "https://widgets.example",
    tool: {
      name: "search_widgets",
      title: "Search widgets",
      description: "Search the current account's widgets.",
    },
    schemas: {
      input: {
        type: "object",
        properties: { query: { type: "string", minLength: 1, maxLength: 120 } },
        required: ["query"],
        additionalProperties: false,
      },
      output: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, label: { type: "string" } },
          required: ["id", "label"],
          additionalProperties: false,
        },
        maxItems: 100,
      },
    },
    annotations: { readOnly: true, untrusted: false },
    authentication: { mode: "same_origin_cookie", requiredScopes: [] },
    effects: {
      kind: "read",
      riskTier: "R0",
      reversible: true,
      summary: "Reads widget summaries without changing them.",
      confirmation: "none",
    },
    idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    request: {
      method: "GET",
      pathTemplate: "/api/widgets",
      path: {},
      query: { q: "query" },
      body: {},
    },
    response: {
      contentTypes: ["application/json"],
      projection: { kind: "array", fields: { id: "id", label: "label" } },
      errorMappings: {
        "401": "AUTHENTICATION_REQUIRED",
        "403": "FORBIDDEN",
        "429": "RATE_LIMITED",
        default: "TARGET_ERROR",
      },
    },
    success: { statusCodes: [200], requiredOutputFields: ["id", "label"] },
    evidence: [{ source: "runtime", reference: `urn:sha256:${HASH_A}` }],
    ...overrides,
  } as CapabilityPlan;
}

test("CapabilityPlan rejects unknown and unsupported schema fields", () => {
  assert.throws(() => CapabilityPlanSchema.parse({ ...readPlan(), surprise: true }), /unrecognized|unknown/i);
  assert.throws(() => CapabilityPlanSchema.parse({
    ...readPlan(),
    schemas: {
      ...readPlan().schemas,
      input: {
        ...readPlan().schemas.input,
        properties: { query: { type: "string", oneOf: [{ type: "string" }] } },
      },
    },
  }), /unrecognized|unknown/i);
});

test("CapabilityPlan rejects unsafe origins, paths, R3, and unstable CSRF selectors", () => {
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({ targetOrigin: "http://widgets.example" })]), /targetOrigin/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    request: { ...readPlan().request, pathTemplate: "//evil.example/widgets" },
  })]), /unsafe request path/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    effects: { ...readPlan().effects, riskTier: "R3" },
  })]), /R3/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    authentication: {
      mode: "same_origin_cookie",
      requiredScopes: [],
      csrf: {
        reviewed: true,
        headerName: "x-csrf-token",
        resolution: { kind: "dom", selector: "form > input:nth-child(2)", attribute: "value" },
      },
    },
  })]), /stable CSRF selector/i);
});

test("CapabilityPlan requires immutable evidence and required referenced fields", () => {
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({ evidence: [] })]), /evidence/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    evidence: [{ source: "runtime", reference: "https://logs.example/raw/secret" }],
  })]), /evidence/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    request: { ...readPlan().request, query: { q: "missing" } },
  })]), /unknown input field/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    schemas: {
      ...readPlan().schemas,
      input: { ...readPlan().schemas.input, required: [] },
    },
  })]), /optional input field/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    success: { ...readPlan().success, requiredOutputFields: ["missing"] },
  })]), /unknown output field/i);
});

test("CapabilityPlan rejects unsafe method/effect and mutation retry combinations", () => {
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    request: { ...readPlan().request, method: "POST" },
  })]), /read.*GET/i);
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    annotations: { readOnly: false, untrusted: false },
    effects: {
      kind: "mutation",
      riskTier: "R1",
      reversible: true,
      summary: "Creates a reversible widget draft.",
      confirmation: "always",
    },
    idempotency: { strategy: "header", headerName: "idempotency-key", verified: false, retry: "safe_once" },
    request: { ...readPlan().request, method: "POST", query: {}, body: { query: "query" } },
    success: { ...readPlan().success, statusCodes: [201] },
  })]), /verified idempotency/i);
});

test("CapabilityPlan canonicalization rejects duplicates and sorts unordered data", () => {
  assert.throws(() => canonicalizeCapabilityPlans([readPlan(), readPlan()]), /duplicate tool name/i);

  const second = readPlan({
    tool: { name: "get_widget", title: "Get widget", description: "Get a widget." },
    schemas: {
      input: {
        type: "object",
        properties: {
          locale: { type: "string", enum: ["de", "en"] },
          id: { type: "string" },
        },
        required: ["locale", "id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { label: { type: "string" }, id: { type: "string" } },
        required: ["label", "id"],
        additionalProperties: false,
      },
    },
    request: {
      method: "GET",
      pathTemplate: "/api/widgets/{widgetId}",
      path: { widgetId: "id" },
      query: { locale: "locale" },
      body: {},
    },
    response: {
      contentTypes: ["application/problem+json", "application/json"],
      projection: { kind: "object", fields: { label: "label", id: "id" } },
      errorMappings: { default: "TARGET_ERROR", "401": "AUTHENTICATION_REQUIRED" },
    },
    success: { statusCodes: [206, 200], requiredOutputFields: ["label", "id"] },
    evidence: [
      { source: "openapi", reference: `urn:sha256:${HASH_B}` },
      { source: "runtime", reference: `urn:sha256:${HASH_A}` },
    ],
  });
  const canonical = canonicalizeCapabilityPlans([readPlan(), second]);
  assert.deepEqual(canonical.map((plan) => plan.tool.name), ["get_widget", "search_widgets"]);
  assert.deepEqual(canonical[0]!.schemas.input.required, ["id", "locale"]);
  assert.deepEqual(canonical[0]!.response.contentTypes, ["application/json", "application/problem+json"]);
  assert.deepEqual(canonical[0]!.success.statusCodes, [200, 206]);
  assert.ok(Object.isFrozen(canonical[0]!.evidence));
});
