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

function mutationPlan(overrides: Record<string, unknown> = {}): CapabilityPlan {
  const base = readPlan();
  return {
    ...base,
    tool: { name: "create_widget", title: "Create widget", description: "Create a reversible widget." },
    annotations: { readOnly: false, untrusted: false },
    effects: {
      kind: "mutation",
      riskTier: "R1",
      reversible: true,
      summary: "Creates one reversible widget.",
      confirmation: "always",
    },
    idempotency: { strategy: "header", headerName: "Idempotency-Key", verified: true, retry: "safe_once" },
    request: { method: "POST", pathTemplate: "/api/widgets", path: {}, query: {}, body: { query: "query" } },
    success: { ...base.success, statusCodes: [201] },
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
  })]), /CSRF|discriminator|unrecognized/i);
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
          id: { type: "string", maxLength: 128 },
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

test("CapabilityPlan uses structured non-credential CSRF locators", () => {
  assert.throws(() => canonicalizeCapabilityPlans([mutationPlan({
    authentication: {
      mode: "same_origin_cookie",
      requiredScopes: [],
      csrf: {
        reviewed: true,
        headerName: "x-csrf-token",
        resolution: { kind: "dom", selector: "input[name=\"password\"]", attribute: "value" },
      },
    },
  })]), /csrf|credential|unrecognized/i);

  for (const credentialName of ["csrf-password", "csrf-otp"]) {
    assert.throws(() => canonicalizeCapabilityPlans([mutationPlan({
      authentication: {
        mode: "same_origin_cookie",
        requiredScopes: [],
        csrf: {
          reviewed: true,
          headerName: "x-csrf-token",
          resolution: { kind: "hidden_input", name: credentialName, attribute: "value" },
        },
      },
    })]), /csrf|credential/i);
  }

  assert.doesNotThrow(() => canonicalizeCapabilityPlans([mutationPlan({
    authentication: {
      mode: "same_origin_cookie",
      requiredScopes: [],
      csrf: {
        reviewed: true,
        headerName: "X-CSRF-Token",
        resolution: { kind: "hidden_input", name: "csrf-token", attribute: "value" },
      },
    },
  })]));
});

test("CapabilityPlan canonicalization is locale-independent for Unicode schema properties", () => {
  const unicodePlan = readPlan({
    schemas: {
      ...readPlan().schemas,
      input: {
        type: "object",
        properties: {
          z: { type: "string", maxLength: 8 },
          "ä": { type: "string", maxLength: 8 },
        },
        required: ["z", "ä"],
        additionalProperties: false,
      },
    },
    request: { ...readPlan().request, query: {} },
  });
  const original = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = function localeCompareGerman(other: string) {
      const left = String(this);
      if (new Set([left, other]).size === 2 && [left, other].every((value) => value === "z" || value === "ä")) {
        return left === "ä" ? -1 : 1;
      }
      return original.call(left, other);
    };
    const german = JSON.stringify(canonicalizeCapabilityPlans([unicodePlan]));
    String.prototype.localeCompare = function localeCompareSwedish(other: string) {
      const left = String(this);
      if (new Set([left, other]).size === 2 && [left, other].every((value) => value === "z" || value === "ä")) {
        return left === "ä" ? 1 : -1;
      }
      return original.call(left, other);
    };
    const swedish = JSON.stringify(canonicalizeCapabilityPlans([unicodePlan]));
    assert.equal(german, swedish);
  } finally {
    String.prototype.localeCompare = original;
  }
});

test("CapabilityPlan bounds input schemas and requires scalar path/query mappings", () => {
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    schemas: {
      ...readPlan().schemas,
      input: {
        ...readPlan().schemas.input,
        properties: { query: { type: "string", minLength: 1 } },
      },
    },
  })]), /bounded|maxLength/i);

  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    schemas: {
      ...readPlan().schemas,
      input: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: { value: { type: "string", maxLength: 8 } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        required: ["filter"],
        additionalProperties: false,
      },
    },
    request: { ...readPlan().request, query: { filter: "filter" } },
  })]), /scalar/i);

  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    schemas: {
      ...readPlan().schemas,
      input: {
        type: "object",
        properties: {
          matrix: {
            type: "array",
            maxItems: 1_000,
            items: { type: "array", maxItems: 1_000, items: { type: "boolean" } },
          },
        },
        required: ["matrix"],
        additionalProperties: false,
      },
    },
    request: { ...readPlan().request, query: {} },
  })]), /input|bound|validation/i);

  assert.throws(() => canonicalizeCapabilityPlans([mutationPlan({
    schemas: {
      ...mutationPlan().schemas,
      input: {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: { value: { type: "string", maxLength: 8 } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        required: ["payload"],
        additionalProperties: false,
      },
    },
    request: { ...mutationPlan().request, body: { payload: "payload" } },
  })]), /body.*scalar|scalar.*body/i);
});

test("CapabilityPlan canonicalizes safe header names and rejects reserved or colliding headers", () => {
  const canonical = canonicalizeCapabilityPlans([mutationPlan()]);
  assert.equal(canonical[0]!.idempotency.headerName, "idempotency-key");

  assert.throws(() => canonicalizeCapabilityPlans([mutationPlan({
    idempotency: { strategy: "header", headerName: "Content-Type", verified: true, retry: "safe_once" },
  })]), /reserved|header/i);

  assert.throws(() => canonicalizeCapabilityPlans([mutationPlan({
    authentication: {
      mode: "same_origin_cookie",
      requiredScopes: [],
      csrf: {
        reviewed: true,
        headerName: "X-Operation-Key",
        resolution: { kind: "meta", name: "csrf-token", attribute: "content" },
      },
    },
    idempotency: { strategy: "header", headerName: "x-operation-key", verified: true, retry: "safe_once" },
  })]), /collid|header/i);
});

test("CapabilityPlan rejects poison JSON keys instead of changing reviewed semantics", () => {
  const poisonProperties = JSON.parse('{"query":{"type":"string","maxLength":120},"__proto__":{"type":"string","maxLength":8}}');
  assert.throws(() => canonicalizeCapabilityPlans([readPlan({
    schemas: {
      ...readPlan().schemas,
      input: {
        type: "object",
        properties: poisonProperties,
        required: ["query"],
        additionalProperties: false,
      },
    },
  })]), /poison|unsafe|__proto__/i);
});

test("CapabilityPlan excludes no-content success statuses from its JSON response adapter", () => {
  for (const statusCode of [204, 205]) {
    assert.throws(() => canonicalizeCapabilityPlans([readPlan({
      success: { ...readPlan().success, statusCodes: [statusCode] },
    })]), /204|205|no-content|json/i);
  }
});

test("CapabilityPlan binds source-native confirmation to an exact reviewed evidence reference", () => {
  assert.throws(() => canonicalizeCapabilityPlans([mutationPlan({
    effects: {
      ...mutationPlan().effects,
      sourceNativeConfirmation: {
        reviewed: true,
        globalName: "__page2webmcpConfirmWidget",
        evidenceReference: `urn:sha256:${HASH_B}`,
      },
    },
  })]), /evidence|unrecognized/i);

  assert.doesNotThrow(() => canonicalizeCapabilityPlans([mutationPlan({
    effects: {
      ...mutationPlan().effects,
      sourceNativeConfirmation: {
        reviewed: true,
        globalName: "__page2webmcpConfirmWidget",
        evidenceReference: `urn:sha256:${HASH_A}`,
      },
    },
  })]));
});
