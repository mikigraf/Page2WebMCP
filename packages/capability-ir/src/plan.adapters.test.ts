import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeCapabilityPlans, type CapabilityPlan } from "./plan.ts";

const HASH = "c".repeat(64);

function commonPlan() {
  return {
    version: 1,
    targetOrigin: "https://catalog.example",
    tool: {
      name: "search_catalog",
      title: "Search catalog",
      description: "Search the current catalog.",
    },
    schemas: {
      input: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 80 },
          category: { type: "string", maxLength: 40 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          itemId: { type: "string", maxLength: 80 },
          label: { type: "string", maxLength: 200 },
        },
        required: ["itemId", "label"],
        additionalProperties: false,
      },
    },
    annotations: { readOnly: true, untrusted: true },
    authentication: { mode: "same_origin_cookie", requiredScopes: [] },
    effects: {
      kind: "read",
      riskTier: "R0",
      reversible: true,
      summary: "Reads catalog entries.",
      confirmation: "none",
    },
    idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    evidence: [{ source: "runtime", reference: `urn:sha256:${HASH}` }],
  } as const;
}

function formPlan(): CapabilityPlan {
  return {
    ...commonPlan(),
    request: {
      adapter: "html_form",
      form: { kind: "name", element: "form", name: "catalog_search" },
      action: "https://catalog.example/search",
      method: "GET",
      controls: {
        category: { inputField: "category", optional: true },
        query: { inputField: "query", optional: false },
      },
    },
    response: {
      adapter: "html_form",
      contentTypes: ["text/html"],
      projection: {
        kind: "semantic_object",
        fields: {
          label: {
            locator: { kind: "role", role: "heading", accessibleName: "Catalog result" },
            read: "text",
          },
          itemId: {
            locator: {
              kind: "stable_attribute",
              reviewed: true,
              element: "output",
              name: "data-catalog-key",
              value: "primary-result",
            },
            read: "value",
          },
        },
      },
      errorMappings: { "401": "AUTHENTICATION_REQUIRED", default: "TARGET_ERROR" },
    },
    success: {
      adapter: "html_form",
      statusCodes: [200],
      condition: {
        locator: { kind: "role", role: "status", accessibleName: "Search complete" },
        read: "text",
        equals: "Search complete",
      },
      requiredOutputFields: ["label", "itemId"],
    },
  } as unknown as CapabilityPlan;
}

function domMutationPlan(): CapabilityPlan {
  return {
    ...commonPlan(),
    tool: {
      name: "rename_catalog_draft",
      title: "Rename catalog draft",
      description: "Rename a reversible catalog draft.",
    },
    schemas: {
      input: {
        type: "object",
        properties: { label: { type: "string", minLength: 1, maxLength: 80 } },
        required: ["label"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          label: { type: "string", maxLength: 80 },
          state: { type: "string", enum: ["saved"] },
        },
        required: ["label", "state"],
        additionalProperties: false,
      },
    },
    annotations: { readOnly: false, untrusted: false },
    effects: {
      kind: "mutation",
      riskTier: "R1",
      reversible: true,
      summary: "Renames one draft and can be undone.",
      confirmation: "always",
      sourceNativeConfirmation: {
        reviewed: true,
        globalName: "__page2webmcpConfirmCatalog",
        evidenceReference: `urn:sha256:${HASH}`,
      },
    },
    idempotency: { strategy: "none", verified: false, retry: "none" },
    request: {
      adapter: "semantic_dom",
      scope: {
        kind: "stable_attribute",
        reviewed: true,
        element: "section",
        name: "data-catalog-bridge",
        value: "draft-editor",
      },
      inputs: {
        label: {
          locator: { kind: "label", element: "input", label: "Draft name" },
          optional: false,
        },
      },
      action: {
        kind: "click",
        target: { kind: "role", role: "button", accessibleName: "Save draft" },
      },
    },
    response: {
      adapter: "semantic_dom",
      projection: {
        kind: "semantic_object",
        fields: {
          state: {
            locator: { kind: "role", role: "status", accessibleName: "Draft saved" },
            read: "text",
          },
          label: {
            locator: { kind: "label", element: "input", label: "Draft name" },
            read: "value",
          },
        },
      },
    },
    success: {
      adapter: "semantic_dom",
      condition: {
        locator: { kind: "role", role: "status", accessibleName: "Draft saved" },
        read: "text",
        equals: "saved",
      },
      requiredOutputFields: ["state", "label"],
    },
  } as unknown as CapabilityPlan;
}

test("CapabilityPlan accepts strict HTML form and semantic DOM adapter branches", () => {
  const canonical = canonicalizeCapabilityPlans([formPlan(), domMutationPlan()]);
  assert.deepEqual(canonical.map(({ request }) => request.adapter), ["semantic_dom", "html_form"]);
  assert.deepEqual(Object.keys(canonical[1]!.request.adapter === "html_form" ? canonical[1]!.request.controls : {}), [
    "category",
    "query",
  ]);
});

test("browser adapters reject arbitrary, positional, transient, and private locators", () => {
  const invalidLocators = [
    { selector: "form > input:nth-child(2)" },
    { kind: "stable_attribute", reviewed: true, element: "section", name: "class", value: "panel-42" },
    { kind: "stable_attribute", reviewed: true, element: "section", name: "data-reactid", value: "root.4" },
    { kind: "stable_attribute", reviewed: true, element: "section", name: "data-testid", value: "catalog" },
    { kind: "stable_attribute", reviewed: true, element: "section", name: "data-catalog-key", value: "javascript:save" },
  ];
  for (const scope of invalidLocators) {
    assert.throws(() => canonicalizeCapabilityPlans([{
      ...domMutationPlan(),
      request: { ...domMutationPlan().request, scope },
    } as unknown as CapabilityPlan]), /locator|attribute|selector|stable|invalid|unrecognized/i);
  }
});

test("form adapters require an exact same-origin action and exact scalar optionality mappings", () => {
  assert.throws(() => canonicalizeCapabilityPlans([{
    ...formPlan(),
    request: { ...formPlan().request, action: "https://other.example/search" },
  } as CapabilityPlan]), /action|origin/i);

  assert.throws(() => canonicalizeCapabilityPlans([{
    ...formPlan(),
    request: {
      ...formPlan().request,
      controls: { query: { inputField: "query", optional: true } },
    },
  } as CapabilityPlan]), /optional|required|mapping/i);

  assert.throws(() => canonicalizeCapabilityPlans([{
    ...formPlan(),
    request: {
      ...formPlan().request,
      controls: { query: { inputField: "missing", optional: false } },
    },
  } as CapabilityPlan]), /unknown input|mapping/i);

  assert.throws(() => canonicalizeCapabilityPlans([{
    ...formPlan(),
    schemas: {
      ...formPlan().schemas,
      input: {
        type: "object",
        properties: {
          query: {
            type: "object",
            properties: { nested: { type: "string", maxLength: 20 } },
            required: ["nested"],
            additionalProperties: false,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    request: {
      ...formPlan().request,
      controls: { query: { inputField: "query", optional: false } },
    },
  } as CapabilityPlan]), /scalar|mapping/i);
});

test("adapter request, response, and success discriminators must agree", () => {
  assert.throws(() => canonicalizeCapabilityPlans([{
    ...formPlan(),
    success: { ...formPlan().success, adapter: "semantic_dom" },
  } as unknown as CapabilityPlan]), /adapter|match/i);
});

test("DOM mutations cannot retry and form safe-once requires reviewed field or header idempotency", () => {
  assert.throws(() => canonicalizeCapabilityPlans([{
    ...domMutationPlan(),
    idempotency: { strategy: "header", headerName: "idempotency-key", verified: true, retry: "safe_once" },
  } as CapabilityPlan]), /DOM|retry|idempotency/i);

  const formMutation = {
    ...formPlan(),
    tool: { name: "save_catalog", title: "Save catalog", description: "Save a reversible catalog draft." },
    annotations: { readOnly: false, untrusted: false },
    effects: {
      kind: "mutation",
      riskTier: "R1",
      reversible: true,
      summary: "Saves one reversible catalog draft.",
      confirmation: "always",
      sourceNativeConfirmation: {
        reviewed: true,
        globalName: "__page2webmcpConfirmCatalog",
        evidenceReference: `urn:sha256:${HASH}`,
      },
    },
    request: { ...formPlan().request, method: "POST" },
    idempotency: {
      strategy: "form_field",
      fieldName: "request_key",
      verified: true,
      retry: "safe_once",
    },
  } as CapabilityPlan;
  assert.doesNotThrow(() => canonicalizeCapabilityPlans([formMutation]));
  assert.throws(() => canonicalizeCapabilityPlans([{
    ...formMutation,
    idempotency: { ...formMutation.idempotency, verified: false },
  } as CapabilityPlan]), /verified idempotency|retry/i);
});

test("browser adapter canonicalization is locale-independent and insensitive to map/plan ordering", () => {
  const base = formPlan();
  assert.equal(base.response.adapter, "html_form");
  if (base.response.adapter !== "html_form") throw new Error("expected HTML form fixture");
  const reordered = {
    ...base,
    request: {
      ...base.request,
      controls: {
        query: { inputField: "query", optional: false },
        category: { inputField: "category", optional: true },
      },
    },
    response: {
      ...base.response,
      projection: {
        kind: "semantic_object",
        fields: {
          itemId: base.response.projection.fields.itemId,
          label: base.response.projection.fields.label,
        },
      },
      errorMappings: { default: "TARGET_ERROR", "401": "AUTHENTICATION_REQUIRED" },
    },
    success: { ...base.success, requiredOutputFields: ["itemId", "label"] },
  } as CapabilityPlan;
  assert.equal(
    JSON.stringify(canonicalizeCapabilityPlans([formPlan(), domMutationPlan()])),
    JSON.stringify(canonicalizeCapabilityPlans([domMutationPlan(), reordered])),
  );
});
