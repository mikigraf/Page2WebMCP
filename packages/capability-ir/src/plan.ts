import { z } from "zod";

export const CAPABILITY_PLAN_VERSION = 1 as const;

export type JsonSchema =
  | { type: "string"; minLength?: number; maxLength?: number; enum?: string[] }
  | { type: "boolean" }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "array"; items: JsonSchema; minItems?: number; maxItems?: number }
  | { type: "object"; properties: Record<string, JsonSchema>; required: string[]; additionalProperties: false };

export type ObjectJsonSchema = Extract<JsonSchema, { type: "object" }>;

export type SemanticElement =
  | "form"
  | "input"
  | "textarea"
  | "select"
  | "button"
  | "output"
  | "div"
  | "span"
  | "p"
  | "section"
  | "article"
  | "h1"
  | "h2"
  | "h3"
  | "a";

export type SemanticLocator =
  | { kind: "role"; role: "button" | "form" | "textbox" | "checkbox" | "combobox" | "status" | "alert" | "region" | "heading" | "link"; accessibleName: string }
  | { kind: "label"; element: "input" | "textarea" | "select"; label: string }
  | { kind: "name"; element: SemanticElement; name: string }
  | { kind: "stable_attribute"; reviewed: true; element: SemanticElement; name: string; value: string };

export type SemanticClickLocator =
  | { kind: "role"; element: "button" | "input"; role: "button"; accessibleName: string }
  | { kind: "name"; element: "button" | "input"; name: string }
  | { kind: "stable_attribute"; reviewed: true; element: "button" | "input"; name: string; value: string };

export type SemanticValue = {
  locator: SemanticLocator;
  read: "text" | "value" | "checked";
};

export type SemanticCondition = SemanticValue & { equals: string | boolean };

export type JsonApiRequest = {
  adapter: "json_api";
  method: "GET" | "POST";
  pathTemplate: string;
  path: Record<string, string>;
  query: Record<string, string>;
  body: Record<string, string>;
};

export type HtmlFormRequest = {
  adapter: "html_form";
  form: SemanticLocator;
  action: string;
  method: "GET" | "POST";
  controls: Record<string, { inputField: string; optional: boolean }>;
};

export type SemanticDomRequest = {
  adapter: "semantic_dom";
  scope: SemanticLocator;
  inputs: Record<string, { locator: SemanticLocator; optional: boolean }>;
  action: { kind: "read" } | { kind: "click"; target: SemanticClickLocator };
};

export type JsonApiResponse = {
  adapter: "json_api";
  contentTypes: string[];
  projection:
    | { kind: "identity" }
    | { kind: "object"; fields: Record<string, string> }
    | { kind: "array"; fields: Record<string, string> };
  errorMappings: Record<string, CapabilityErrorCode>;
};

export type HtmlFormResponse = {
  adapter: "html_form";
  contentTypes: string[];
  projection: { kind: "semantic_object"; fields: Record<string, SemanticValue> };
  errorMappings: Record<string, CapabilityErrorCode>;
};

export type SemanticDomResponse = {
  adapter: "semantic_dom";
  projection: { kind: "semantic_object"; fields: Record<string, SemanticValue> };
};

export type JsonApiSuccess = {
  adapter: "json_api";
  statusCodes: number[];
  requiredOutputFields: string[];
};

export type HtmlFormSuccess = {
  adapter: "html_form";
  statusCodes: number[];
  condition: SemanticCondition;
  requiredOutputFields: string[];
};

export type SemanticDomSuccess = {
  adapter: "semantic_dom";
  condition: SemanticCondition;
  requiredOutputFields: string[];
};

export type CapabilityPlan = {
  version: typeof CAPABILITY_PLAN_VERSION;
  targetOrigin: string;
  tool: {
    name: string;
    title: string;
    description: string;
  };
  schemas: {
    input: ObjectJsonSchema;
    output: JsonSchema;
  };
  annotations: {
    readOnly: boolean;
    untrusted: boolean;
  };
  authentication: {
    mode: "public" | "same_origin_cookie" | "browser_oauth";
    requiredScopes: string[];
    csrf?: {
      reviewed: true;
      headerName: string;
      resolution:
        | { kind: "meta"; name: string; attribute: "content" }
        | { kind: "hidden_input"; name: string; attribute: "value" };
    };
  };
  effects: {
    kind: "read" | "mutation";
    riskTier: "R0" | "R1" | "R2" | "R3";
    reversible: boolean;
    summary: string;
    confirmation: "none" | "always";
    sourceNativeConfirmation?: {
      reviewed: true;
      globalName: string;
      evidenceReference: string;
    };
  };
  idempotency: {
    strategy: "none" | "header" | "form_field";
    headerName?: string;
    fieldName?: string;
    verified: boolean;
    retry: "none" | "safe_once";
  };
  request: JsonApiRequest | HtmlFormRequest | SemanticDomRequest;
  response: JsonApiResponse | HtmlFormResponse | SemanticDomResponse;
  success: JsonApiSuccess | HtmlFormSuccess | SemanticDomSuccess;
  evidence: Array<{
    source: "runtime" | "openapi" | "github" | "owner_review";
    reference: string;
  }>;
};

export type CapabilityErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "STALE_TARGET"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "TARGET_ERROR";

const JsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({
    type: z.literal("string"),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    enum: z.array(z.string().max(4096)).min(1).max(100).optional(),
  }).strict(),
  z.object({ type: z.literal("boolean") }).strict(),
  z.object({
    type: z.literal("number"),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  }).strict(),
  z.object({
    type: z.literal("integer"),
    minimum: z.number().int().optional(),
    maximum: z.number().int().optional(),
  }).strict(),
  z.object({
    type: z.literal("array"),
    items: JsonSchemaSchema,
    minItems: z.number().int().min(0).optional(),
    maxItems: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), JsonSchemaSchema),
    required: z.array(z.string()).max(100),
    additionalProperties: z.literal(false),
  }).strict(),
]));

const ObjectJsonSchemaSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), JsonSchemaSchema),
  required: z.array(z.string()).max(100),
  additionalProperties: z.literal(false),
}).strict();

const FieldMapSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_.~-]{0,127}$/),
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
);

const SemanticElementSchema = z.enum([
  "form", "input", "textarea", "select", "button", "output", "div", "span", "p", "section", "article", "h1", "h2", "h3", "a",
]);

const SemanticLocatorSchema: z.ZodType<SemanticLocator> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    role: z.enum(["button", "form", "textbox", "checkbox", "combobox", "status", "alert", "region", "heading", "link"]),
    accessibleName: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal("label"),
    element: z.enum(["input", "textarea", "select"]),
    label: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal("name"),
    element: SemanticElementSchema,
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/),
  }).strict(),
  z.object({
    kind: z.literal("stable_attribute"),
    reviewed: z.literal(true),
    element: SemanticElementSchema,
    name: z.string().regex(/^data-[a-z][a-z0-9-]{0,63}$/),
    value: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/),
  }).strict(),
]);

const SemanticClickLocatorSchema: z.ZodType<SemanticClickLocator> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("role"),
    element: z.enum(["button", "input"]),
    role: z.literal("button"),
    accessibleName: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal("name"),
    element: z.enum(["button", "input"]),
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/),
  }).strict(),
  z.object({
    kind: z.literal("stable_attribute"),
    reviewed: z.literal(true),
    element: z.enum(["button", "input"]),
    name: z.string().regex(/^data-[a-z][a-z0-9-]{0,63}$/),
    value: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/),
  }).strict(),
]);

const SemanticValueSchema: z.ZodType<SemanticValue> = z.object({
  locator: SemanticLocatorSchema,
  read: z.enum(["text", "value", "checked"]),
}).strict();

const SemanticConditionSchema: z.ZodType<SemanticCondition> = z.object({
  locator: SemanticLocatorSchema,
  read: z.enum(["text", "value", "checked"]),
  equals: z.union([z.string().max(4096), z.boolean()]),
}).strict();

const SemanticProjectionSchema = z.object({
  kind: z.literal("semantic_object"),
  fields: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), SemanticValueSchema),
}).strict();

const ErrorCodeSchema = z.enum([
  "AUTHENTICATION_REQUIRED",
  "FORBIDDEN",
  "STALE_TARGET",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "TARGET_ERROR",
]);

const CapabilityPlanStructureSchema = z.object({
  version: z.literal(CAPABILITY_PLAN_VERSION),
  targetOrigin: z.string().min(1).max(2048),
  tool: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(600),
  }).strict(),
  schemas: z.object({ input: ObjectJsonSchemaSchema, output: JsonSchemaSchema }).strict(),
  annotations: z.object({ readOnly: z.boolean(), untrusted: z.boolean() }).strict(),
  authentication: z.object({
    mode: z.enum(["public", "same_origin_cookie", "browser_oauth"]),
    requiredScopes: z.array(z.string().regex(/^[A-Za-z0-9:._/-]{1,160}$/)).max(100),
    csrf: z.object({
      reviewed: z.literal(true),
      headerName: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/),
      resolution: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("meta"),
          name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/),
          attribute: z.literal("content"),
        }).strict(),
        z.object({
          kind: z.literal("hidden_input"),
          name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/),
          attribute: z.literal("value"),
        }).strict(),
      ]),
    }).strict().optional(),
  }).strict(),
  effects: z.object({
    kind: z.enum(["read", "mutation"]),
    riskTier: z.enum(["R0", "R1", "R2", "R3"]),
    reversible: z.boolean(),
    summary: z.string().trim().min(1).max(300),
    confirmation: z.enum(["none", "always"]),
    sourceNativeConfirmation: z.object({
      reviewed: z.literal(true),
      globalName: z.string().regex(/^__page2webmcp[A-Za-z0-9_]{1,100}$/),
      evidenceReference: z.string().regex(/^urn:sha256:[a-f0-9]{64}$/),
    }).strict().optional(),
  }).strict(),
  idempotency: z.object({
    strategy: z.enum(["none", "header", "form_field"]),
    headerName: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/).optional(),
    fieldName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/).optional(),
    verified: z.boolean(),
    retry: z.enum(["none", "safe_once"]),
  }).strict(),
  request: z.discriminatedUnion("adapter", [
    z.object({
      adapter: z.literal("json_api"),
      method: z.enum(["GET", "POST"]),
      pathTemplate: z.string().min(1).max(2048),
      path: FieldMapSchema,
      query: FieldMapSchema,
      body: FieldMapSchema,
    }).strict(),
    z.object({
      adapter: z.literal("html_form"),
      form: SemanticLocatorSchema,
      action: z.string().min(1).max(2048),
      method: z.enum(["GET", "POST"]),
      controls: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/), z.object({
        inputField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
        optional: z.boolean(),
      }).strict()),
    }).strict(),
    z.object({
      adapter: z.literal("semantic_dom"),
      scope: SemanticLocatorSchema,
      inputs: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), z.object({
        locator: SemanticLocatorSchema,
        optional: z.boolean(),
      }).strict()),
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("read") }).strict(),
        z.object({ kind: z.literal("click"), target: SemanticClickLocatorSchema }).strict(),
      ]),
    }).strict(),
  ]),
  response: z.discriminatedUnion("adapter", [
    z.object({
      adapter: z.literal("json_api"),
      contentTypes: z.array(z.string().min(1).max(128)).min(1).max(20),
      projection: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("identity") }).strict(),
        z.object({ kind: z.literal("object"), fields: FieldMapSchema }).strict(),
        z.object({ kind: z.literal("array"), fields: FieldMapSchema }).strict(),
      ]),
      errorMappings: z.record(z.string(), ErrorCodeSchema),
    }).strict(),
    z.object({
      adapter: z.literal("html_form"),
      contentTypes: z.array(z.literal("text/html")).length(1),
      projection: SemanticProjectionSchema,
      errorMappings: z.record(z.string(), ErrorCodeSchema),
    }).strict(),
    z.object({
      adapter: z.literal("semantic_dom"),
      projection: SemanticProjectionSchema,
    }).strict(),
  ]),
  success: z.discriminatedUnion("adapter", [
    z.object({
      adapter: z.literal("json_api"),
      statusCodes: z.array(z.number().int().min(200).max(299)).min(1).max(100),
      requiredOutputFields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)).max(200),
    }).strict(),
    z.object({
      adapter: z.literal("html_form"),
      statusCodes: z.array(z.number().int().min(200).max(299)).min(1).max(100),
      condition: SemanticConditionSchema,
      requiredOutputFields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)).max(200),
    }).strict(),
    z.object({
      adapter: z.literal("semantic_dom"),
      condition: SemanticConditionSchema,
      requiredOutputFields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)).max(200),
    }).strict(),
  ]),
  evidence: z.array(z.object({
    source: z.enum(["runtime", "openapi", "github", "owner_review"]),
    reference: z.string().regex(/^urn:sha256:[a-f0-9]{64}$/),
  }).strict()).min(1).max(500),
}).strict();

const ValidatedCapabilityPlanSchema = CapabilityPlanStructureSchema.superRefine((plan, context) => {
  try {
    validateCapabilityPlan(plan);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid CapabilityPlan" });
  }
});

export const CapabilityPlanSchema: z.ZodType<CapabilityPlan> = z.preprocess((input) => {
  rejectPoisonKeys(input);
  return input;
}, ValidatedCapabilityPlanSchema);

const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function rejectPoisonKeys(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (POISON_KEYS.has(key)) throw new Error(`unsafe poison key: ${key}`);
    rejectPoisonKeys((value as Record<string, unknown>)[key], seen);
  }
}

function validateExactOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("targetOrigin must be an exact safe HTTP(S) origin");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp)
    || url.origin !== value
    || url.username.length > 0
    || url.password.length > 0) {
    throw new Error("targetOrigin must be an exact safe HTTP(S) origin");
  }
}

function assertUnique(values: readonly unknown[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_PROPERTIES = 100;
const MAX_INPUT_STRING_LENGTH = 4096;
const MAX_INPUT_ARRAY_ITEMS = 1000;
const MAX_REQUEST_BODY_BYTES = 32768;
const MAX_REQUEST_URL_BYTES = 8192;
const MAX_INPUT_VALIDATION_UNITS = 32768;

type SchemaBudget = { properties: number };

function validateSchema(
  schema: JsonSchema,
  label: string,
  options: { input: boolean; depth: number; budget: SchemaBudget },
): void {
  if (options.depth > MAX_SCHEMA_DEPTH) throw new Error(`${label} exceeds schema depth bound`);
  if (schema.type === "string") {
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
      throw new Error(`${label} has incompatible string bounds`);
    }
    if (schema.enum) assertUnique(schema.enum, `${label}.enum`);
    if (options.input && schema.maxLength === undefined && schema.enum === undefined) {
      throw new Error(`${label} must have a bounded maxLength`);
    }
    if (schema.maxLength !== undefined && schema.maxLength > MAX_INPUT_STRING_LENGTH) {
      throw new Error(`${label} maxLength exceeds the supported bound`);
    }
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
      throw new Error(`${label} has incompatible numeric bounds`);
    }
    return;
  }
  if (schema.type === "array") {
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
      throw new Error(`${label} has incompatible array bounds`);
    }
    if (options.input && schema.maxItems === undefined) throw new Error(`${label} must have bounded maxItems`);
    if (schema.maxItems !== undefined && schema.maxItems > MAX_INPUT_ARRAY_ITEMS) {
      throw new Error(`${label} maxItems exceeds the supported bound`);
    }
    validateSchema(schema.items, `${label}.items`, { ...options, depth: options.depth + 1 });
    return;
  }
  if (schema.type === "object") {
    options.budget.properties += Object.keys(schema.properties).length;
    if (options.budget.properties > MAX_SCHEMA_PROPERTIES) throw new Error(`${label} exceeds the schema property bound`);
    assertUnique(schema.required, `${label}.required`);
    for (const field of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, field)) throw new Error(`${label} requires an unknown property`);
    }
    for (const [field, property] of Object.entries(schema.properties)) {
      validateSchema(property, `${label}.${field}`, { ...options, depth: options.depth + 1 });
    }
  }
}

function validCsrfTokenName(name: string): boolean {
  const credentialMarker = /(?:^|[-_])(?:password|passwd|passcode|otp|one[-_]?time|credential|secret|session|cookie|authorization|bearer)(?:$|[-_])/i;
  return !credentialMarker.test(name) && /(?:^|[-_])(?:csrf|xsrf)(?:[-_]?token)?(?:$|[-_])/i.test(name);
}

function validateRequestPath(plan: CapabilityPlan, request: JsonApiRequest): void {
  const path = request.pathTemplate;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new Error(`unsafe request path for ${plan.tool.name}`);
  }
  if (!path.startsWith("/")
    || path.startsWith("//")
    || /[?#\\\0]/.test(path)
    || /%2f|%5c/i.test(path)
    || decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`unsafe request path for ${plan.tool.name}`);
  }
  const placeholders = Array.from(path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (match) => match[1]!);
  if (path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "").includes("{")
    || path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "").includes("}")) {
    throw new Error(`unsafe request path for ${plan.tool.name}`);
  }
  assertUnique(placeholders, `${plan.tool.name}.request.path placeholders`);
  const mapped = Object.keys(request.path);
  if (placeholders.length !== mapped.length || placeholders.some((placeholder) => !mapped.includes(placeholder))) {
    throw new Error(`request path mappings do not match the path template for ${plan.tool.name}`);
  }
}

function validateFormAction(plan: CapabilityPlan, request: HtmlFormRequest): void {
  let url: URL;
  try {
    url = new URL(request.action);
  } catch {
    throw new Error(`form action must be an exact same-origin URL for ${plan.tool.name}`);
  }
  if (url.href !== request.action
    || url.origin !== plan.targetOrigin
    || url.username.length > 0
    || url.password.length > 0
    || url.hash.length > 0) {
    throw new Error(`form action must be an exact same-origin URL for ${plan.tool.name}`);
  }
  const formLocator = request.form;
  const locatesForm = formLocator.kind === "role"
    ? formLocator.role === "form"
    : formLocator.kind !== "label" && formLocator.element === "form";
  if (!locatesForm) throw new Error(`form locator must identify a form for ${plan.tool.name}`);
}

function validateSemanticLocator(locator: SemanticLocator, label: string): void {
  if (locator.kind !== "stable_attribute") return;
  if (/(?:^|-)(?:testid|reactid|react|vue|angular|ember|session|temporary|transient|random|uuid)(?:-|$)/i.test(locator.name)) {
    throw new Error(`${label} uses a transient or private framework attribute`);
  }
}

function visitSemanticLocators(plan: CapabilityPlan, visit: (locator: SemanticLocator, label: string) => void): void {
  const request = plan.request;
  if (request.adapter === "html_form") visit(request.form, `${plan.tool.name}.request.form`);
  if (request.adapter === "semantic_dom") {
    visit(request.scope, `${plan.tool.name}.request.scope`);
    for (const [field, mapping] of Object.entries(request.inputs)) {
      visit(mapping.locator, `${plan.tool.name}.request.inputs.${field}`);
    }
    if (request.action.kind === "click") visit(request.action.target, `${plan.tool.name}.request.action.target`);
  }
  if (plan.response.adapter !== "json_api") {
    for (const [field, projection] of Object.entries(plan.response.projection.fields)) {
      visit(projection.locator, `${plan.tool.name}.response.projection.${field}`);
    }
  }
  if (plan.success.adapter !== "json_api") visit(plan.success.condition.locator, `${plan.tool.name}.success.condition`);
}

function referencedOutputSchema(plan: CapabilityPlan): ObjectJsonSchema | undefined {
  const output = plan.schemas.output;
  if (output.type === "object") return output;
  if (output.type === "array" && output.items.type === "object") return output.items;
  return undefined;
}

function maximumScalarJsonBytes(schema: JsonSchema): number {
  if (schema.type === "string") {
    if (schema.enum) return Math.max(...schema.enum.map((value) => utf8Bytes(JSON.stringify(value))));
    return (schema.maxLength ?? MAX_INPUT_STRING_LENGTH) * 6 + 2;
  }
  if (schema.type === "boolean") return 5;
  if (schema.type === "number" || schema.type === "integer") return 64;
  return Number.POSITIVE_INFINITY;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function maximumScalarUrlBytes(schema: JsonSchema): number {
  if (schema.type === "string") {
    const maximumLength = schema.enum
      ? Math.max(...schema.enum.map((value) => Array.from(value).length))
      : schema.maxLength ?? MAX_INPUT_STRING_LENGTH;
    return maximumLength * 12;
  }
  if (schema.type === "boolean") return 5;
  if (schema.type === "number" || schema.type === "integer") return 64;
  return Number.POSITIVE_INFINITY;
}

function maximumValidationUnits(schema: JsonSchema): number {
  if (schema.type === "string") {
    if (schema.enum) return 1 + Math.max(...schema.enum.map((value) => Array.from(value).length));
    return 1 + (schema.maxLength ?? MAX_INPUT_STRING_LENGTH);
  }
  if (schema.type === "boolean" || schema.type === "number" || schema.type === "integer") return 1;
  if (schema.type === "array") return 1 + (schema.maxItems ?? MAX_INPUT_ARRAY_ITEMS) * maximumValidationUnits(schema.items);
  return 1 + Object.values(schema.properties)
    .reduce((total, property) => total + maximumValidationUnits(property), 0);
}

function validateCapabilityPlan(plan: CapabilityPlan): void {
  validateExactOrigin(plan.targetOrigin);
  validateSchema(plan.schemas.input, `${plan.tool.name}.schemas.input`, {
    input: true,
    depth: 1,
    budget: { properties: 0 },
  });
  validateSchema(plan.schemas.output, `${plan.tool.name}.schemas.output`, {
    input: false,
    depth: 1,
    budget: { properties: 0 },
  });
  if (maximumValidationUnits(plan.schemas.input) > MAX_INPUT_VALIDATION_UNITS) {
    throw new Error(`input validation bound exceeds the supported limit for ${plan.tool.name}`);
  }
  if (plan.request.adapter !== plan.response.adapter || plan.request.adapter !== plan.success.adapter) {
    throw new Error(`request, response, and success adapters must match for ${plan.tool.name}`);
  }
  visitSemanticLocators(plan, validateSemanticLocator);
  if (plan.request.adapter === "json_api") validateRequestPath(plan, plan.request);
  if (plan.request.adapter === "html_form") validateFormAction(plan, plan.request);

  if (plan.effects.riskTier === "R3") throw new Error(`R3 capability ${plan.tool.name} cannot be compiled`);
  if (plan.effects.kind === "read") {
    if (!plan.annotations.readOnly || plan.effects.riskTier !== "R0" || plan.effects.confirmation !== "none") {
      throw new Error(`read effects require read-only R0 annotations for ${plan.tool.name}`);
    }
    if (plan.request.adapter === "json_api"
      && (plan.request.method !== "GET" || Object.keys(plan.request.body).length > 0)) {
      throw new Error(`read capability must use GET without a body for ${plan.tool.name}`);
    }
    if (plan.request.adapter === "html_form" && plan.request.method !== "GET") {
      throw new Error(`read form capability must use GET for ${plan.tool.name}`);
    }
    if (plan.request.adapter === "semantic_dom" && plan.request.action.kind !== "read") {
      throw new Error(`read DOM capability must use a read action for ${plan.tool.name}`);
    }
    if (plan.effects.sourceNativeConfirmation) {
      throw new Error(`read capability cannot declare source-native confirmation for ${plan.tool.name}`);
    }
  } else {
    if (plan.annotations.readOnly || plan.effects.riskTier === "R0" || plan.effects.confirmation !== "always") {
      throw new Error(`mutation effects require mutation annotations and confirmation for ${plan.tool.name}`);
    }
    if (plan.effects.riskTier === "R1" && !plan.effects.reversible) {
      throw new Error(`R1 mutation must be reversible for ${plan.tool.name}`);
    }
    if (plan.request.adapter !== "semantic_dom" && plan.request.method !== "POST") {
      throw new Error(`mutation capability must use POST for ${plan.tool.name}`);
    }
    if (plan.request.adapter === "semantic_dom" && plan.request.action.kind !== "click") {
      throw new Error(`mutation DOM capability must use a click action for ${plan.tool.name}`);
    }
  }

  if (plan.idempotency.strategy === "none") {
    if (plan.idempotency.headerName !== undefined || plan.idempotency.fieldName !== undefined || plan.idempotency.verified) {
      throw new Error(`idempotency strategy none cannot declare verification for ${plan.tool.name}`);
    }
  } else if (plan.idempotency.strategy === "header") {
    if (!plan.idempotency.headerName || plan.idempotency.fieldName !== undefined) {
      throw new Error(`header idempotency requires only a header name for ${plan.tool.name}`);
    }
  } else if (!plan.idempotency.fieldName || plan.idempotency.headerName !== undefined) {
    throw new Error(`form-field idempotency requires only a field name for ${plan.tool.name}`);
  }
  if (plan.effects.kind === "mutation" && plan.idempotency.retry === "safe_once"
    && (!plan.idempotency.verified
      || (plan.request.adapter === "json_api" && plan.idempotency.strategy !== "header")
      || (plan.request.adapter === "html_form" && !["header", "form_field"].includes(plan.idempotency.strategy))
      || plan.request.adapter === "semantic_dom")) {
    throw new Error(`mutation retry requires verified idempotency for ${plan.tool.name}`);
  }
  if (plan.request.adapter === "semantic_dom"
    && (plan.idempotency.strategy !== "none" || plan.idempotency.retry !== "none")) {
    throw new Error(`DOM mutations cannot declare retry or idempotency for ${plan.tool.name}`);
  }
  if (plan.idempotency.strategy === "form_field" && plan.request.adapter !== "html_form") {
    throw new Error(`form-field idempotency requires an HTML form adapter for ${plan.tool.name}`);
  }

  if (plan.authentication.mode === "public" && plan.authentication.requiredScopes.length > 0) {
    throw new Error(`public authentication cannot require scopes for ${plan.tool.name}`);
  }
  assertUnique(plan.authentication.requiredScopes, `${plan.tool.name}.authentication.requiredScopes`);
  if (plan.authentication.csrf) {
    const csrfHeader = plan.authentication.csrf.headerName.toLowerCase();
    if (!/^(?:x-)?(?:csrf|xsrf)-?token$/.test(csrfHeader)) {
      throw new Error(`non-credential CSRF header required for ${plan.tool.name}`);
    }
    if (!validCsrfTokenName(plan.authentication.csrf.resolution.name)) {
      throw new Error(`non-credential CSRF token locator required for ${plan.tool.name}`);
    }
  }

  const requiredInputs = new Set(plan.schemas.input.required);
  const inputProperties = plan.schemas.input.properties;
  const inputMappings: Array<{ field: string; optional: boolean; target: string }> = [];
  if (plan.request.adapter === "json_api") {
    for (const [target, field] of Object.entries(plan.request.path)) inputMappings.push({ target, field, optional: false });
    for (const [target, field] of Object.entries(plan.request.query)) inputMappings.push({ target, field, optional: false });
    for (const [target, field] of Object.entries(plan.request.body)) inputMappings.push({ target, field, optional: false });
  } else if (plan.request.adapter === "html_form") {
    for (const [target, mapping] of Object.entries(plan.request.controls)) {
      inputMappings.push({ target, field: mapping.inputField, optional: mapping.optional });
    }
  } else {
    for (const [field, mapping] of Object.entries(plan.request.inputs)) {
      inputMappings.push({ target: field, field, optional: mapping.optional });
    }
  }
  if (inputMappings.length > 100) throw new Error(`input mapping count exceeds the supported bound for ${plan.tool.name}`);
  assertUnique(inputMappings.map(({ field }) => field), `${plan.tool.name}.input mappings`);
  for (const { field, optional } of inputMappings) {
    if (!Object.prototype.hasOwnProperty.call(inputProperties, field)) {
      throw new Error(`request plan references an unknown input field for ${plan.tool.name}`);
    }
    if (optional === requiredInputs.has(field)) {
      if (plan.request.adapter === "json_api") {
        throw new Error(`request plan references an optional input field for ${plan.tool.name}`);
      }
      throw new Error(`request mapping optionality does not match the input schema for ${plan.tool.name}`);
    }
    const schema = inputProperties[field]!;
    if (schema.type === "object" || schema.type === "array") {
      if (plan.request.adapter === "json_api" && Object.values(plan.request.body).includes(field)) {
        throw new Error(`request body mappings require scalar input fields for ${plan.tool.name}`);
      }
      throw new Error(`browser and request mappings require scalar input fields for ${plan.tool.name}`);
    }
  }
  if (plan.request.adapter === "json_api") {
    let maximumBodyBytes = 2;
    for (const [target, field] of Object.entries(plan.request.body)) {
      maximumBodyBytes += utf8Bytes(JSON.stringify(target)) + 1 + maximumScalarJsonBytes(inputProperties[field]!) + 1;
    }
    if (maximumBodyBytes > MAX_REQUEST_BODY_BYTES) {
      throw new Error(`request body exceeds the supported bound for ${plan.tool.name}`);
    }
    let maximumUrlBytes = utf8Bytes(plan.targetOrigin) + utf8Bytes(plan.request.pathTemplate);
    for (const field of Object.values(plan.request.path)) maximumUrlBytes += maximumScalarUrlBytes(inputProperties[field]!);
    for (const [target, field] of Object.entries(plan.request.query)) {
      maximumUrlBytes += utf8Bytes(target) + 2 + maximumScalarUrlBytes(inputProperties[field]!);
    }
    if (maximumUrlBytes > MAX_REQUEST_URL_BYTES) {
      throw new Error(`request URL exceeds the supported bound for ${plan.tool.name}`);
    }
  } else if (plan.request.adapter === "html_form") {
    let maximumEncodedBytes = utf8Bytes(plan.request.action);
    for (const { target, field } of inputMappings) {
      maximumEncodedBytes += utf8Bytes(target) + 2 + maximumScalarUrlBytes(inputProperties[field]!);
    }
    if (maximumEncodedBytes > (plan.request.method === "GET" ? MAX_REQUEST_URL_BYTES : MAX_REQUEST_BODY_BYTES)) {
      throw new Error(`form request exceeds the supported bound for ${plan.tool.name}`);
    }
  }

  const reservedHeaders = new Set([
    "authorization", "connection", "content-length", "content-type", "cookie", "host", "origin", "proxy-authorization",
    "referer", "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  const idempotencyHeader = plan.idempotency.headerName?.toLowerCase();
  const idempotencyField = plan.idempotency.fieldName;
  const csrfHeader = plan.authentication.csrf?.headerName.toLowerCase();
  if (idempotencyHeader && (reservedHeaders.has(idempotencyHeader) || idempotencyHeader.startsWith("sec-")
    || idempotencyHeader.startsWith("proxy-") || !/^(?:x-)?idempotency(?:-key)?$/.test(idempotencyHeader))) {
    throw new Error(`reserved or unsupported idempotency header for ${plan.tool.name}`);
  }
  if (csrfHeader && reservedHeaders.has(csrfHeader)) throw new Error(`reserved CSRF header for ${plan.tool.name}`);
  if (csrfHeader && idempotencyHeader && csrfHeader === idempotencyHeader) {
    throw new Error(`CSRF and idempotency headers collide for ${plan.tool.name}`);
  }
  if (idempotencyField && !/^(?:idempotency(?:[-_.]?key)?|request[-_.]?key)$/i.test(idempotencyField)) {
    throw new Error(`unsupported form idempotency field for ${plan.tool.name}`);
  }
  if (idempotencyField && plan.request.adapter === "html_form"
    && Object.prototype.hasOwnProperty.call(plan.request.controls, idempotencyField)) {
    throw new Error(`idempotency field collides with a mapped form control for ${plan.tool.name}`);
  }

  if (plan.response.adapter !== "semantic_dom") {
    assertUnique(plan.response.contentTypes, `${plan.tool.name}.response.contentTypes`);
    for (const contentType of plan.response.contentTypes) {
      if (plan.response.adapter === "json_api"
        && (contentType !== contentType.toLowerCase() || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType))) {
        throw new Error(`unsupported response content type for ${plan.tool.name}`);
      }
    }
    for (const status of Object.keys(plan.response.errorMappings)) {
      if (status !== "default" && !/^[45][0-9]{2}$/.test(status)) throw new Error(`invalid error status mapping for ${plan.tool.name}`);
    }
    if (!Object.prototype.hasOwnProperty.call(plan.response.errorMappings, "default")) {
      throw new Error(`default error mapping is required for ${plan.tool.name}`);
    }
  }
  if (plan.success.adapter !== "semantic_dom") {
    assertUnique(plan.success.statusCodes, `${plan.tool.name}.success.statusCodes`);
    if (plan.success.statusCodes.some((status) => status === 204 || status === 205)) {
      throw new Error(`204 and 205 are unsupported by document response adapters for ${plan.tool.name}`);
    }
  }
  assertUnique(plan.success.requiredOutputFields, `${plan.tool.name}.success.requiredOutputFields`);

  const outputSchema = referencedOutputSchema(plan);
  const referencedOutputs = [
    ...plan.success.requiredOutputFields,
    ...(plan.response.projection.kind === "identity" ? [] : Object.keys(plan.response.projection.fields)),
  ];
  if (referencedOutputs.length > 0 && !outputSchema) {
    throw new Error(`response plan references output fields on a non-object schema for ${plan.tool.name}`);
  }
  if (outputSchema) {
    const requiredOutputs = new Set(outputSchema.required);
    for (const field of referencedOutputs) {
      if (!Object.prototype.hasOwnProperty.call(outputSchema.properties, field)) {
        throw new Error(`response plan references an unknown output field for ${plan.tool.name}`);
      }
      if (!requiredOutputs.has(field)) throw new Error(`response plan references an optional output field for ${plan.tool.name}`);
    }
    if (plan.response.adapter === "json_api" && plan.response.projection.kind !== "identity") {
      const expectedKind = plan.schemas.output.type === "array" ? "array" : "object";
      if (plan.response.projection.kind !== expectedKind) throw new Error(`response projection kind does not match output schema for ${plan.tool.name}`);
      for (const field of requiredOutputs) {
        if (!Object.prototype.hasOwnProperty.call(plan.response.projection.fields, field)) {
          throw new Error(`response projection omits required output field for ${plan.tool.name}`);
        }
      }
    } else if (plan.response.adapter !== "json_api") {
      if (plan.schemas.output.type !== "object") {
        throw new Error(`semantic projection requires an object output schema for ${plan.tool.name}`);
      }
      for (const field of requiredOutputs) {
        if (!Object.prototype.hasOwnProperty.call(plan.response.projection.fields, field)) {
          throw new Error(`semantic response projection omits required output field for ${plan.tool.name}`);
        }
      }
      for (const [field, projection] of Object.entries(plan.response.projection.fields)) {
        const schema = outputSchema.properties[field]!;
        if ((projection.read === "checked") !== (schema.type === "boolean")) {
          throw new Error(`semantic projection source type does not match output field for ${plan.tool.name}`);
        }
        if (projection.read !== "checked" && schema.type !== "string") {
          throw new Error(`semantic text/value projection requires a string output field for ${plan.tool.name}`);
        }
      }
    }
  }
  if (plan.success.adapter !== "json_api") {
    const condition = plan.success.condition;
    if ((condition.read === "checked") !== (typeof condition.equals === "boolean")) {
      throw new Error(`semantic success condition type does not match its source for ${plan.tool.name}`);
    }
  }

  const evidenceKeys = plan.evidence.map(({ source, reference }) => `${source}:${reference}`);
  assertUnique(evidenceKeys, `${plan.tool.name}.evidence`);
  if (plan.effects.sourceNativeConfirmation
    && !plan.evidence.some(({ reference }) => reference === plan.effects.sourceNativeConfirmation!.evidenceReference)) {
    throw new Error(`source-native confirmation evidence is missing for ${plan.tool.name}`);
  }
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareStrings(left, right)));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalSchema(schema: JsonSchema): JsonSchema {
  if (schema.type === "string") return { ...schema, ...(schema.enum ? { enum: [...schema.enum].sort(compareStrings) } : {}) };
  if (schema.type === "array") return { ...schema, items: canonicalSchema(schema.items) };
  if (schema.type === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(schema.properties)
          .sort(([left], [right]) => compareStrings(left, right))
          .map(([field, property]) => [field, canonicalSchema(property)]),
      ),
      required: [...schema.required].sort(compareStrings),
      additionalProperties: false,
    };
  }
  return { ...schema };
}

function canonicalRequest(request: CapabilityPlan["request"]): CapabilityPlan["request"] {
  if (request.adapter === "json_api") {
    return {
      ...request,
      path: sortedRecord(request.path),
      query: sortedRecord(request.query),
      body: sortedRecord(request.body),
    };
  }
  if (request.adapter === "html_form") return { ...request, controls: sortedRecord(request.controls) };
  return { ...request, inputs: sortedRecord(request.inputs) };
}

function canonicalResponse(response: CapabilityPlan["response"]): CapabilityPlan["response"] {
  if (response.adapter === "semantic_dom") {
    return { ...response, projection: { ...response.projection, fields: sortedRecord(response.projection.fields) } };
  }
  if (response.adapter === "html_form") {
    return {
      ...response,
      contentTypes: [...response.contentTypes].sort(compareStrings),
      projection: { ...response.projection, fields: sortedRecord(response.projection.fields) },
      errorMappings: sortedRecord(response.errorMappings),
    };
  }
  return {
    ...response,
    contentTypes: [...response.contentTypes].sort(compareStrings),
    projection: response.projection.kind === "identity"
      ? { kind: "identity" }
      : { ...response.projection, fields: sortedRecord(response.projection.fields) },
    errorMappings: sortedRecord(response.errorMappings),
  };
}

function canonicalSuccess(success: CapabilityPlan["success"]): CapabilityPlan["success"] {
  return {
    ...success,
    ...(success.adapter === "semantic_dom" ? {} : { statusCodes: [...success.statusCodes].sort((left, right) => left - right) }),
    requiredOutputFields: [...success.requiredOutputFields].sort(compareStrings),
  };
}

function canonicalPlan(plan: CapabilityPlan): CapabilityPlan {
  return {
    ...plan,
    schemas: { input: canonicalSchema(plan.schemas.input) as ObjectJsonSchema, output: canonicalSchema(plan.schemas.output) },
    authentication: {
      ...plan.authentication,
      requiredScopes: [...plan.authentication.requiredScopes].sort(compareStrings),
      ...(plan.authentication.csrf ? {
        csrf: {
          ...plan.authentication.csrf,
          headerName: plan.authentication.csrf.headerName.toLowerCase(),
        },
      } : {}),
    },
    idempotency: {
      ...plan.idempotency,
      ...(plan.idempotency.headerName ? { headerName: plan.idempotency.headerName.toLowerCase() } : {}),
    },
    request: canonicalRequest(plan.request),
    response: canonicalResponse(plan.response),
    success: canonicalSuccess(plan.success),
    evidence: [...plan.evidence].sort((left, right) =>
      compareStrings(left.reference, right.reference) || compareStrings(left.source, right.source)),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function canonicalizeCapabilityPlans(plans: readonly CapabilityPlan[]): readonly CapabilityPlan[] {
  if (!Array.isArray(plans)) throw new Error("CapabilityPlan array is required");
  if (plans.length === 0) throw new Error("at least one CapabilityPlan is required");
  if (plans.length > 100) throw new Error("at most 100 CapabilityPlans may be compiled");
  const parsed = plans.map((plan) => CapabilityPlanSchema.parse(plan));
  const names = parsed.map((plan) => plan.tool.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) throw new Error(`duplicate tool name: ${duplicate}`);
  const origins = new Set(parsed.map((plan) => plan.targetOrigin));
  if (origins.size !== 1) throw new Error("all CapabilityPlans must agree on exact targetOrigin");
  return deepFreeze(parsed.map(canonicalPlan).sort((left, right) => compareStrings(left.tool.name, right.tool.name)));
}
