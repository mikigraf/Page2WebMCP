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
        | { kind: "meta"; selector: string; attribute: "content" }
        | { kind: "dom"; selector: string; attribute: string };
    };
  };
  effects: {
    kind: "read" | "mutation";
    riskTier: "R0" | "R1" | "R2" | "R3";
    reversible: boolean;
    summary: string;
    confirmation: "none" | "always";
  };
  idempotency: {
    strategy: "none" | "header";
    headerName?: string;
    verified: boolean;
    retry: "none" | "safe_once";
  };
  request: {
    method: "GET" | "POST";
    pathTemplate: string;
    path: Record<string, string>;
    query: Record<string, string>;
    body: Record<string, string>;
  };
  response: {
    contentTypes: string[];
    projection:
      | { kind: "identity" }
      | { kind: "object"; fields: Record<string, string> }
      | { kind: "array"; fields: Record<string, string> };
    errorMappings: Record<string, CapabilityErrorCode>;
  };
  success: {
    statusCodes: number[];
    requiredOutputFields: string[];
  };
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
    enum: z.array(z.string()).min(1).optional(),
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
    required: z.array(z.string()),
    additionalProperties: z.literal(false),
  }).strict(),
]));

const ObjectJsonSchemaSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), JsonSchemaSchema),
  required: z.array(z.string()),
  additionalProperties: z.literal(false),
}).strict();

const FieldMapSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_.~-]{0,127}$/),
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
);

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
        z.object({ kind: z.literal("meta"), selector: z.string().min(1).max(256), attribute: z.literal("content") }).strict(),
        z.object({
          kind: z.literal("dom"),
          selector: z.string().min(1).max(256),
          attribute: z.string().regex(/^(?:value|data-[a-z0-9-]{1,100})$/),
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
  }).strict(),
  idempotency: z.object({
    strategy: z.enum(["none", "header"]),
    headerName: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/).optional(),
    verified: z.boolean(),
    retry: z.enum(["none", "safe_once"]),
  }).strict(),
  request: z.object({
    method: z.enum(["GET", "POST"]),
    pathTemplate: z.string().min(1).max(2048),
    path: FieldMapSchema,
    query: FieldMapSchema,
    body: FieldMapSchema,
  }).strict(),
  response: z.object({
    contentTypes: z.array(z.string().min(1).max(128)).min(1).max(20),
    projection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("identity") }).strict(),
      z.object({ kind: z.literal("object"), fields: FieldMapSchema }).strict(),
      z.object({ kind: z.literal("array"), fields: FieldMapSchema }).strict(),
    ]),
    errorMappings: z.record(z.string(), ErrorCodeSchema),
  }).strict(),
  success: z.object({
    statusCodes: z.array(z.number().int().min(200).max(299)).min(1).max(100),
    requiredOutputFields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)).max(200),
  }).strict(),
  evidence: z.array(z.object({
    source: z.enum(["runtime", "openapi", "github", "owner_review"]),
    reference: z.string().regex(/^urn:sha256:[a-f0-9]{64}$/),
  }).strict()).min(1).max(500),
}).strict();

export const CapabilityPlanSchema: z.ZodType<CapabilityPlan> = CapabilityPlanStructureSchema.superRefine((plan, context) => {
  try {
    validateCapabilityPlan(plan);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid CapabilityPlan" });
  }
});

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

function validateSchema(schema: JsonSchema, label: string): void {
  if (schema.type === "string") {
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
      throw new Error(`${label} has incompatible string bounds`);
    }
    if (schema.enum) assertUnique(schema.enum, `${label}.enum`);
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
    validateSchema(schema.items, `${label}.items`);
    return;
  }
  if (schema.type === "object") {
    assertUnique(schema.required, `${label}.required`);
    for (const field of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, field)) throw new Error(`${label} requires an unknown property`);
    }
    for (const [field, property] of Object.entries(schema.properties)) validateSchema(property, `${label}.${field}`);
  }
}

function stableCsrfSelector(resolution: NonNullable<CapabilityPlan["authentication"]["csrf"]>["resolution"]): boolean {
  if (resolution.kind === "meta") return /^meta\[name=(?:"[A-Za-z0-9_.:-]+"|[A-Za-z0-9_.:-]+)\]$/.test(resolution.selector);
  return /^(?:#[A-Za-z][A-Za-z0-9_:.-]{0,127}|[a-z][a-z0-9-]*\[(?:name|data-[a-z0-9-]+)="[A-Za-z0-9_.:-]+"\])$/.test(resolution.selector);
}

function validateRequestPath(plan: CapabilityPlan): void {
  const path = plan.request.pathTemplate;
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
  const mapped = Object.keys(plan.request.path);
  if (placeholders.length !== mapped.length || placeholders.some((placeholder) => !mapped.includes(placeholder))) {
    throw new Error(`request path mappings do not match the path template for ${plan.tool.name}`);
  }
}

function referencedOutputSchema(plan: CapabilityPlan): ObjectJsonSchema | undefined {
  const output = plan.schemas.output;
  if (output.type === "object") return output;
  if (output.type === "array" && output.items.type === "object") return output.items;
  return undefined;
}

function validateCapabilityPlan(plan: CapabilityPlan): void {
  validateExactOrigin(plan.targetOrigin);
  validateSchema(plan.schemas.input, `${plan.tool.name}.schemas.input`);
  validateSchema(plan.schemas.output, `${plan.tool.name}.schemas.output`);
  validateRequestPath(plan);

  if (plan.effects.riskTier === "R3") throw new Error(`R3 capability ${plan.tool.name} cannot be compiled`);
  if (plan.effects.kind === "read") {
    if (!plan.annotations.readOnly || plan.effects.riskTier !== "R0" || plan.effects.confirmation !== "none") {
      throw new Error(`read effects require read-only R0 annotations for ${plan.tool.name}`);
    }
    if (plan.request.method !== "GET" || Object.keys(plan.request.body).length > 0) {
      throw new Error(`read capability must use GET without a body for ${plan.tool.name}`);
    }
  } else {
    if (plan.annotations.readOnly || plan.effects.riskTier === "R0" || plan.effects.confirmation !== "always") {
      throw new Error(`mutation effects require mutation annotations and confirmation for ${plan.tool.name}`);
    }
    if (plan.effects.riskTier === "R1" && !plan.effects.reversible) {
      throw new Error(`R1 mutation must be reversible for ${plan.tool.name}`);
    }
    if (plan.request.method !== "POST") throw new Error(`mutation capability must use POST for ${plan.tool.name}`);
  }

  if (plan.idempotency.strategy === "none") {
    if (plan.idempotency.headerName !== undefined || plan.idempotency.verified) {
      throw new Error(`idempotency strategy none cannot declare verification for ${plan.tool.name}`);
    }
  } else if (!plan.idempotency.headerName) {
    throw new Error(`header idempotency requires a header name for ${plan.tool.name}`);
  }
  if (plan.effects.kind === "mutation" && plan.idempotency.retry === "safe_once"
    && (plan.idempotency.strategy !== "header" || !plan.idempotency.verified)) {
    throw new Error(`mutation retry requires verified idempotency for ${plan.tool.name}`);
  }

  if (plan.authentication.mode === "public" && plan.authentication.requiredScopes.length > 0) {
    throw new Error(`public authentication cannot require scopes for ${plan.tool.name}`);
  }
  assertUnique(plan.authentication.requiredScopes, `${plan.tool.name}.authentication.requiredScopes`);
  if (plan.authentication.csrf && !stableCsrfSelector(plan.authentication.csrf.resolution)) {
    throw new Error(`stable CSRF selector required for ${plan.tool.name}`);
  }

  const requiredInputs = new Set(plan.schemas.input.required);
  const inputProperties = plan.schemas.input.properties;
  const referencedInputs = [
    ...Object.values(plan.request.path),
    ...Object.values(plan.request.query),
    ...Object.values(plan.request.body),
  ];
  for (const field of referencedInputs) {
    if (!Object.prototype.hasOwnProperty.call(inputProperties, field)) {
      throw new Error(`request plan references an unknown input field for ${plan.tool.name}`);
    }
    if (!requiredInputs.has(field)) throw new Error(`request plan references an optional input field for ${plan.tool.name}`);
  }

  assertUnique(plan.response.contentTypes, `${plan.tool.name}.response.contentTypes`);
  for (const contentType of plan.response.contentTypes) {
    if (contentType !== contentType.toLowerCase() || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType)) {
      throw new Error(`unsupported response content type for ${plan.tool.name}`);
    }
  }
  assertUnique(plan.success.statusCodes, `${plan.tool.name}.success.statusCodes`);
  assertUnique(plan.success.requiredOutputFields, `${plan.tool.name}.success.requiredOutputFields`);
  for (const status of Object.keys(plan.response.errorMappings)) {
    if (status !== "default" && !/^[45][0-9]{2}$/.test(status)) throw new Error(`invalid error status mapping for ${plan.tool.name}`);
  }
  if (!Object.prototype.hasOwnProperty.call(plan.response.errorMappings, "default")) {
    throw new Error(`default error mapping is required for ${plan.tool.name}`);
  }

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
    if (plan.response.projection.kind !== "identity") {
      const expectedKind = plan.schemas.output.type === "array" ? "array" : "object";
      if (plan.response.projection.kind !== expectedKind) throw new Error(`response projection kind does not match output schema for ${plan.tool.name}`);
      for (const field of requiredOutputs) {
        if (!Object.prototype.hasOwnProperty.call(plan.response.projection.fields, field)) {
          throw new Error(`response projection omits required output field for ${plan.tool.name}`);
        }
      }
    }
  }

  const evidenceKeys = plan.evidence.map(({ source, reference }) => `${source}:${reference}`);
  assertUnique(evidenceKeys, `${plan.tool.name}.evidence`);
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareStrings(left, right)));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalSchema(schema: JsonSchema): JsonSchema {
  if (schema.type === "string") return { ...schema, ...(schema.enum ? { enum: [...schema.enum].sort() } : {}) };
  if (schema.type === "array") return { ...schema, items: canonicalSchema(schema.items) };
  if (schema.type === "object") {
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(schema.properties)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([field, property]) => [field, canonicalSchema(property)]),
      ),
      required: [...schema.required].sort(),
      additionalProperties: false,
    };
  }
  return { ...schema };
}

function canonicalPlan(plan: CapabilityPlan): CapabilityPlan {
  return {
    ...plan,
    schemas: { input: canonicalSchema(plan.schemas.input) as ObjectJsonSchema, output: canonicalSchema(plan.schemas.output) },
    authentication: {
      ...plan.authentication,
      requiredScopes: [...plan.authentication.requiredScopes].sort(),
    },
    request: {
      ...plan.request,
      path: sortedRecord(plan.request.path),
      query: sortedRecord(plan.request.query),
      body: sortedRecord(plan.request.body),
    },
    response: {
      contentTypes: [...plan.response.contentTypes].sort(),
      projection: plan.response.projection.kind === "identity"
        ? { kind: "identity" }
        : { ...plan.response.projection, fields: sortedRecord(plan.response.projection.fields) },
      errorMappings: sortedRecord(plan.response.errorMappings),
    },
    success: {
      statusCodes: [...plan.success.statusCodes].sort((left, right) => left - right),
      requiredOutputFields: [...plan.success.requiredOutputFields].sort(),
    },
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
