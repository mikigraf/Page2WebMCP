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
  validateRequestPath(plan);

  if (plan.effects.riskTier === "R3") throw new Error(`R3 capability ${plan.tool.name} cannot be compiled`);
  if (plan.effects.kind === "read") {
    if (!plan.annotations.readOnly || plan.effects.riskTier !== "R0" || plan.effects.confirmation !== "none") {
      throw new Error(`read effects require read-only R0 annotations for ${plan.tool.name}`);
    }
    if (plan.request.method !== "GET" || Object.keys(plan.request.body).length > 0) {
      throw new Error(`read capability must use GET without a body for ${plan.tool.name}`);
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
  for (const field of [...Object.values(plan.request.path), ...Object.values(plan.request.query)]) {
    const schema = inputProperties[field]!;
    if (schema.type === "object" || schema.type === "array") {
      throw new Error(`path and query mappings require scalar input fields for ${plan.tool.name}`);
    }
  }
  let maximumBodyBytes = 2;
  for (const [target, field] of Object.entries(plan.request.body)) {
    const schema = inputProperties[field]!;
    if (schema.type === "object" || schema.type === "array") {
      throw new Error(`request body mappings require scalar input fields for ${plan.tool.name}`);
    }
    maximumBodyBytes += utf8Bytes(JSON.stringify(target)) + 1 + maximumScalarJsonBytes(schema) + 1;
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

  const reservedHeaders = new Set([
    "authorization", "connection", "content-length", "content-type", "cookie", "host", "origin", "proxy-authorization",
    "referer", "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  const idempotencyHeader = plan.idempotency.headerName?.toLowerCase();
  const csrfHeader = plan.authentication.csrf?.headerName.toLowerCase();
  if (idempotencyHeader && (reservedHeaders.has(idempotencyHeader) || idempotencyHeader.startsWith("sec-")
    || idempotencyHeader.startsWith("proxy-") || !/^(?:x-)?idempotency(?:-key)?$/.test(idempotencyHeader))) {
    throw new Error(`reserved or unsupported idempotency header for ${plan.tool.name}`);
  }
  if (csrfHeader && reservedHeaders.has(csrfHeader)) throw new Error(`reserved CSRF header for ${plan.tool.name}`);
  if (csrfHeader && idempotencyHeader && csrfHeader === idempotencyHeader) {
    throw new Error(`CSRF and idempotency headers collide for ${plan.tool.name}`);
  }

  assertUnique(plan.response.contentTypes, `${plan.tool.name}.response.contentTypes`);
  for (const contentType of plan.response.contentTypes) {
    if (contentType !== contentType.toLowerCase() || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType)) {
      throw new Error(`unsupported response content type for ${plan.tool.name}`);
    }
  }
  assertUnique(plan.success.statusCodes, `${plan.tool.name}.success.statusCodes`);
  if (plan.success.statusCodes.some((status) => status === 204 || status === 205)) {
    throw new Error(`204 and 205 are unsupported by the JSON response adapter for ${plan.tool.name}`);
  }
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
    request: {
      ...plan.request,
      path: sortedRecord(plan.request.path),
      query: sortedRecord(plan.request.query),
      body: sortedRecord(plan.request.body),
    },
    response: {
      contentTypes: [...plan.response.contentTypes].sort(compareStrings),
      projection: plan.response.projection.kind === "identity"
        ? { kind: "identity" }
        : { ...plan.response.projection, fields: sortedRecord(plan.response.projection.fields) },
      errorMappings: sortedRecord(plan.response.errorMappings),
    },
    success: {
      statusCodes: [...plan.success.statusCodes].sort((left, right) => left - right),
      requiredOutputFields: [...plan.success.requiredOutputFields].sort(compareStrings),
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
