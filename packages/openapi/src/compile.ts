import { createHash } from "node:crypto";
import { createConfig, lintFromString } from "@redocly/openapi-core";
import { parseDocument } from "yaml";
import {
  CapabilityPlanSchema,
  canonicalizeCapabilityPlans,
  type CapabilityErrorCode,
  type CapabilityPlan,
  type JsonSchema,
  type ObjectJsonSchema,
} from "../../capability-ir/src/plan.ts";

export type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

export type OpenApiDiagnosticCode =
  | "AUTHENTICATION_AMBIGUOUS"
  | "CSRF_REVIEW_REQUIRED"
  | "EFFECT_REVIEW_REQUIRED"
  | "HIGH_RISK_OPERATION_BLOCKED"
  | "MALFORMED_OPERATION"
  | "SERVER_ORIGIN_MISMATCH"
  | "SERVER_ADAPTER_REQUIRED"
  | "UNSUPPORTED_COOKIE_PARAMETER"
  | "UNSUPPORTED_HTTP_METHOD"
  | "UNSUPPORTED_PARAMETER_SERIALIZATION"
  | "UNSUPPORTED_REQUEST_BODY"
  | "UNSUPPORTED_RESPONSE"
  | "UNSUPPORTED_SERVER"
  | "UNSUPPORTED_SCHEMA";

export type OpenApiDiagnostic = Readonly<{
  code: OpenApiDiagnosticCode;
  operationKey: string;
  reason?: "api_key_header" | "api_key_query" | "http_basic" | "http_bearer" | "oauth_client_credentials" | "oauth_password" | "openid_connect" | "unsafe_header_parameter" | "unsupported_security_scheme";
}>;

export type OpenApiCompileOptions = Readonly<{
  targetOrigin: string;
  testPageUrl: string;
  environment: "test" | "staging" | "production";
  evidenceReference: string;
}>;

export type OpenApiGroup = Readonly<{ name: string; operations: string[] }>;

export type OpenApiCompileResult = Readonly<{
  plans: CapabilityPlan[];
  diagnostics: OpenApiDiagnostic[];
  groups: OpenApiGroup[];
}>;

export type OpenApiGroupingPort = Readonly<{
  group(request: Readonly<{
    version: 1;
    operations: ReadonlyArray<Readonly<{ key: string; method: "GET" | "POST"; path: string; suggestedName: string }>>;
    signal: AbortSignal;
  }>): Promise<unknown>;
}>;

const MAX_DOCUMENT_BYTES = 1_000_000;
const MAX_DOCUMENT_DEPTH = 64;
const MAX_DOCUMENT_NODES = 10_000;
const MAX_LOCAL_REFERENCE_STEPS = 10_000;
export const REDOCLY_OPENAPI_CORE_VERSION = "2.45.0" as const;
const operationMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"]);
const redoclyConfig = createConfig({ extends: ["minimal"] });

function resourceLimit(): never { throw new Error("OPENAPI_RESOURCE_LIMIT_EXCEEDED"); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSupportedOpenApiVersion(value: string): boolean {
  return /^3\.(0|1|2)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function assertDocumentShape(root: Record<string, unknown>): void {
  const version = root.openapi;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("INVALID_OPENAPI_DOCUMENT");
  if (!isSupportedOpenApiVersion(version)) throw new Error("UNSUPPORTED_OPENAPI_VERSION");
  if (!isRecord(root.paths)) throw new Error("INVALID_OPENAPI_DOCUMENT");
  for (const [path, item] of Object.entries(root.paths)) {
    if (path.startsWith("x-")) continue;
    if (!path.startsWith("/") || !isRecord(item)) throw new Error("INVALID_OPENAPI_DOCUMENT");
    for (const [method, operation] of Object.entries(item)) {
      if (!operationMethods.has(method)) continue;
      if (!isRecord(operation) || operation.operationId !== undefined && typeof operation.operationId !== "string") throw new Error("INVALID_OPENAPI_DOCUMENT");
    }
  }
}

function assertSourceIsBounded(source: string, format: "json" | "yaml"): void {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCUMENT_BYTES) resourceLimit();
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (const character of source) {
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\" && quote === '"') escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "{" || character === "[") {
      if (++depth > MAX_DOCUMENT_DEPTH) resourceLimit();
    } else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
  }
  if (format === "yaml") {
    for (const line of source.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent > MAX_DOCUMENT_DEPTH * 2) resourceLimit();
    }
  }
}

function getLocalReferenceTarget(root: Record<string, unknown>, reference: string): unknown {
  if (!reference.startsWith("#")) throw new Error("EXTERNAL_REFERENCE_BLOCKED");
  let pointer: string;
  try { pointer = decodeURIComponent(reference.slice(1)); } catch { throw new Error("LOCAL_REFERENCE_INVALID"); }
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) throw new Error("LOCAL_REFERENCE_INVALID");
  let target: unknown = root;
  for (const segment of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(segment)) throw new Error("LOCAL_REFERENCE_INVALID");
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(target)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || !Object.prototype.hasOwnProperty.call(target, key)) throw new Error("LOCAL_REFERENCE_INVALID");
      target = target[Number(key)];
      continue;
    }
    if (!target || typeof target !== "object") throw new Error("LOCAL_REFERENCE_INVALID");
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error("LOCAL_REFERENCE_INVALID");
    target = (target as Record<string, unknown>)[key];
  }
  return target;
}

function inspectValue(initial: unknown): string[] {
  const references: string[] = [];
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; leaving?: boolean }> = [{ value: initial, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth, leaving } = stack.pop()!;
    if (leaving) { active.delete(value as object); continue; }
    if (depth > MAX_DOCUMENT_DEPTH || ++nodes > MAX_DOCUMENT_NODES) resourceLimit();
    if (!value || typeof value !== "object") continue;
    if (active.has(value)) resourceLimit();
    if (seen.has(value)) continue;
    seen.add(value);
    active.add(value);
    stack.push({ value, depth, leaving: true });
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref") {
        if (typeof child !== "string") throw new Error("INVALID_OPENAPI_DOCUMENT");
        if (!child.startsWith("#")) throw new Error("EXTERNAL_REFERENCE_BLOCKED");
        references.push(child);
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return references;
}

function assertLocalReferencesAreSafe(root: Record<string, unknown>, references: string[]): void {
  let steps = 0;
  const visited = new Set<string>();
  const queue = [...references];
  while (queue.length > 0) {
    const reference = queue.pop()!;
    if (visited.has(reference)) continue;
    if (++steps > MAX_LOCAL_REFERENCE_STEPS) resourceLimit();
    visited.add(reference);
    const target = getLocalReferenceTarget(root, reference);
    for (const nestedReference of inspectValue(target)) queue.push(nestedReference);
  }
}

export function parseOpenApiDocument(source: string, format: "json" | "yaml"): OpenApiDocument {
  assertSourceIsBounded(source, format);
  let parsed: unknown;
  try {
    if (format === "json") parsed = JSON.parse(source);
    else {
      const document = parseDocument(source, { uniqueKeys: true });
      if (document.errors.length > 0) throw new Error("INVALID_OPENAPI_DOCUMENT");
      parsed = document.toJS({ maxAliasCount: 50 });
    }
  } catch {
    throw new Error("INVALID_OPENAPI_DOCUMENT");
  }
  if (!isRecord(parsed)) throw new Error("INVALID_OPENAPI_DOCUMENT");
  const root = parsed as Record<string, unknown>;
  assertDocumentShape(root);
  const references = inspectValue(root);
  assertLocalReferencesAreSafe(root, references);
  return parsed as OpenApiDocument;
}

export async function validateOpenApiSource(source: string, format: "json" | "yaml"): Promise<OpenApiDocument> {
  const parsed = parseOpenApiDocument(source, format);
  try {
    const problems = await lintFromString({
      source,
      absoluteRef: format === "json" ? "/openapi.json" : "/openapi.yaml",
      config: await redoclyConfig,
    });
    if (problems.some(({ severity }) => severity === "error")) throw new Error("OPENAPI_SCHEMA_INVALID");
  } catch (error) {
    if (error instanceof Error && error.message === "OPENAPI_SCHEMA_INVALID") throw error;
    throw new Error("OPENAPI_SCHEMA_INVALID");
  }
  return parsed;
}

class OperationDiagnostic extends Error {
  constructor(readonly code: OpenApiDiagnosticCode, readonly reason?: OpenApiDiagnostic["reason"]) { super(code); }
}

type ExtractedOperation = Readonly<{
  key: string;
  method: string;
  path: string;
  operation: Record<string, unknown>;
  pathItem: Record<string, unknown>;
}>;

type PlanOperation = Readonly<{
  key: string;
  method: "GET" | "POST";
  path: string;
  plan: CapabilityPlan;
}>;

const reservedRequestHeaders = new Set([
  "authorization", "connection", "content-length", "content-type", "cookie", "host", "origin", "proxy-authorization",
  "referer", "te", "trailer", "transfer-encoding", "upgrade",
]);
const credentialMarker = /(?:password|passwd|secret|token|api[-_ ]?key|credential|authorization|bearer|cookie|session|sk[-_ ]?live)/i;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

function operationName(operationId: unknown, method: string, path: string): string {
  const identityHash = shortHash(`${method}\n${path}`);
  if (typeof operationId !== "string" || credentialMarker.test(operationId)) return `${method.toLowerCase()}_operation_${identityHash}`;
  let base = operationId.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  if (!/^[a-z]/.test(base)) base = `${method.toLowerCase()}_${base}`;
  base = base.slice(0, 50).replace(/_+$/g, "");
  return `${base || `${method.toLowerCase()}_operation`}_${identityHash}`.slice(0, 63);
}

function assertCompileContext(options: OpenApiCompileOptions): void {
  let origin: URL;
  let page: URL;
  try {
    origin = new URL(options.targetOrigin);
    page = new URL(options.testPageUrl);
  } catch {
    throw new Error("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
  }
  if (origin.protocol !== "https:" || origin.origin !== options.targetOrigin || origin.username || origin.password
    || page.protocol !== "https:" || page.origin !== origin.origin || page.username || page.password
    || !["test", "staging", "production"].includes(options.environment)
    || !/^urn:sha256:[a-f0-9]{64}$/.test(options.evidenceReference)) {
    throw new Error("OPENAPI_VERIFICATION_CONTEXT_REQUIRED");
  }
}

function assertCompilableDocument(document: OpenApiDocument): Record<string, unknown> {
  if (!isRecord(document)) throw new Error("INVALID_OPENAPI_DOCUMENT");
  assertDocumentShape(document);
  const references = inspectValue(document);
  assertLocalReferencesAreSafe(document, references);
  return document;
}

function resolveLocalRecord(root: Record<string, unknown>, value: unknown): Record<string, unknown> {
  let current = value;
  const references = new Set<string>();
  while (isRecord(current) && typeof current.$ref === "string") {
    if (Object.keys(current).some((key) => !["$ref", "summary", "description"].includes(key))) {
      throw new OperationDiagnostic("MALFORMED_OPERATION");
    }
    const reference = current.$ref;
    if (references.has(reference) || references.size >= 64) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    references.add(reference);
    current = getLocalReferenceTarget(root, reference);
  }
  if (!isRecord(current)) throw new OperationDiagnostic("MALFORMED_OPERATION");
  return current;
}

function extractOperations(root: Record<string, unknown>): ExtractedOperation[] {
  const paths = root.paths as Record<string, unknown>;
  const operations: ExtractedOperation[] = [];
  for (const path of Object.keys(paths).sort(compareStrings)) {
    if (path.startsWith("x-")) continue;
    if (path.length > 1024 || /[\0\\?#]/.test(path)) throw new Error("UNSAFE_OPENAPI_PATH");
    const pathItem = resolveLocalRecord(root, paths[path]);
    for (const method of Object.keys(pathItem)) {
      if (!operationMethods.has(method)) continue;
      const operation = pathItem[method];
      if (!isRecord(operation)) {
        operations.push({ key: `${method.toUpperCase()} ${path}`, method, path, operation: {}, pathItem });
        continue;
      }
      operations.push({ key: `${method.toUpperCase()} ${path}`, method, path, operation, pathItem });
    }
  }
  const rank = (method: string): number => method === "get" ? 0 : method === "post" ? 1 : 2;
  return operations.sort((left, right) => rank(left.method) - rank(right.method) || compareStrings(left.path, right.path));
}

function safeFieldName(prefix: string, target: string, used: Set<string>): string {
  let base = target.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  if (!/^[a-z]/.test(base)) base = `value_${base}`;
  base = `${prefix}_${base}`.slice(0, 110).replace(/_+$/g, "");
  let candidate = base;
  if (used.has(candidate)) candidate = `${base.slice(0, 100)}_${shortHash(`${prefix}\n${target}`)}`;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(candidate) || used.has(candidate)) {
    throw new OperationDiagnostic("UNSUPPORTED_PARAMETER_SERIALIZATION");
  }
  used.add(candidate);
  return candidate;
}

function convertSchema(
  root: Record<string, unknown>,
  value: unknown,
  input: boolean,
  activeReferences = new Set<string>(),
  depth = 0,
): JsonSchema {
  if (depth > 8 || !isRecord(value)) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
  if (typeof value.$ref === "string") {
    if (Object.keys(value).some((key) => !["$ref", "summary", "description"].includes(key))) {
      throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    }
    if (activeReferences.has(value.$ref)) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    const next = new Set(activeReferences);
    next.add(value.$ref);
    return convertSchema(root, getLocalReferenceTarget(root, value.$ref), input, next, depth + 1);
  }
  if (value.nullable === true || value.oneOf !== undefined || value.anyOf !== undefined || value.allOf !== undefined
    || value.not !== undefined || Array.isArray(value.type)
    || value.pattern !== undefined || value.multipleOf !== undefined || value.exclusiveMinimum !== undefined
    || value.exclusiveMaximum !== undefined || value.uniqueItems !== undefined || value.contains !== undefined
    || value.minContains !== undefined || value.maxContains !== undefined || value.propertyNames !== undefined
    || value.patternProperties !== undefined || value.unevaluatedProperties !== undefined
    || value.const !== undefined || value.format !== undefined || value.if !== undefined || value.then !== undefined
    || value.else !== undefined || value.dependentRequired !== undefined || value.dependentSchemas !== undefined
    || value.dependencies !== undefined || value.minProperties !== undefined || value.maxProperties !== undefined
    || value.prefixItems !== undefined || value.additionalItems !== undefined || value.contentEncoding !== undefined
    || value.contentMediaType !== undefined || value.contentSchema !== undefined || value.discriminator !== undefined
    || value.readOnly === true || value.writeOnly === true) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
  const type = value.type ?? (isRecord(value.properties) ? "object" : undefined);
  if (type !== "string" && value.enum !== undefined) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
  if (type === "string") {
    const schema: Extract<JsonSchema, { type: "string" }> = { type: "string" };
    if (value.minLength !== undefined) {
      if (!Number.isInteger(value.minLength) || Number(value.minLength) < 0) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      schema.minLength = Number(value.minLength);
    }
    if (value.maxLength !== undefined) {
      if (!Number.isInteger(value.maxLength) || Number(value.maxLength) < 0 || Number(value.maxLength) > 4096) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      schema.maxLength = Number(value.maxLength);
    }
    if (Array.isArray(value.enum)) {
      if (value.enum.length === 0 || value.enum.length > 100 || value.enum.some((item) => typeof item !== "string" || item.length > 4096)) {
        throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      }
      schema.enum = [...value.enum] as string[];
      if (new Set(schema.enum).size !== schema.enum.length) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    }
    if (input && schema.maxLength === undefined && schema.enum === undefined) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
      throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    }
    return schema;
  }
  if (type === "boolean") return { type: "boolean" };
  if (type === "number" || type === "integer") {
    const schema: Extract<JsonSchema, { type: "number" | "integer" }> = { type } as Extract<JsonSchema, { type: "number" | "integer" }>;
    if (value.minimum !== undefined) {
      if (typeof value.minimum !== "number" || !Number.isFinite(value.minimum) || type === "integer" && !Number.isInteger(value.minimum)) {
        throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      }
      schema.minimum = value.minimum;
    }
    if (value.maximum !== undefined) {
      if (typeof value.maximum !== "number" || !Number.isFinite(value.maximum) || type === "integer" && !Number.isInteger(value.maximum)) {
        throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      }
      schema.maximum = value.maximum;
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
      throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    }
    return schema;
  }
  if (type === "array") {
    if (!isRecord(value.items)) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    const schema: Extract<JsonSchema, { type: "array" }> = {
      type: "array",
      items: convertSchema(root, value.items, input, activeReferences, depth + 1),
    };
    if (value.minItems !== undefined) {
      if (!Number.isInteger(value.minItems) || Number(value.minItems) < 0) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      schema.minItems = Number(value.minItems);
    }
    if (value.maxItems !== undefined) {
      if (!Number.isInteger(value.maxItems) || Number(value.maxItems) < 0 || Number(value.maxItems) > 1000) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      schema.maxItems = Number(value.maxItems);
    }
    if (input && schema.maxItems === undefined) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
      throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    }
    return schema;
  }
  if (type === "object") {
    if (value.additionalProperties !== undefined && value.additionalProperties !== false) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    const sourceProperties = value.properties === undefined ? {} : value.properties;
    if (!isRecord(sourceProperties) || Object.keys(sourceProperties).length > 100) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    const required = value.required === undefined ? [] : value.required;
    if (!Array.isArray(required) || required.some((field) => typeof field !== "string") || new Set(required).size !== required.length) {
      throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    }
    const properties: Record<string, JsonSchema> = {};
    for (const field of Object.keys(sourceProperties).sort(compareStrings)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(field)) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
      properties[field] = convertSchema(root, sourceProperties[field], input, activeReferences, depth + 1);
    }
    if (required.some((field) => !Object.prototype.hasOwnProperty.call(properties, field))) throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
    return { type: "object", properties, required: [...required].sort(compareStrings), additionalProperties: false };
  }
  throw new OperationDiagnostic("UNSUPPORTED_SCHEMA");
}

function parametersFor(root: Record<string, unknown>, extracted: ExtractedOperation): Record<string, unknown>[] {
  const combined = new Map<string, Record<string, unknown>>();
  for (const source of [extracted.pathItem.parameters, extracted.operation.parameters]) {
    if (source === undefined) continue;
    if (!Array.isArray(source) || source.length > 100) throw new OperationDiagnostic("MALFORMED_OPERATION");
    for (const parameterValue of source) {
      const parameter = resolveLocalRecord(root, parameterValue);
      if (typeof parameter.name !== "string" || typeof parameter.in !== "string") throw new OperationDiagnostic("MALFORMED_OPERATION");
      combined.set(`${parameter.in}\n${parameter.name}`, parameter);
    }
  }
  return [...combined.values()].sort((left, right) => compareStrings(`${left.in}\n${left.name}`, `${right.in}\n${right.name}`));
}

function runtimeOperationPath(root: Record<string, unknown>, extracted: ExtractedOperation, targetOrigin: string): string {
  const servers = extracted.operation.servers ?? extracted.pathItem.servers ?? root.servers;
  if (servers === undefined) return extracted.path;
  if (!Array.isArray(servers) || servers.length !== 1 || !isRecord(servers[0]) || typeof servers[0].url !== "string"
    || servers[0].variables !== undefined || /[{}]/.test(servers[0].url)) {
    throw new OperationDiagnostic("UNSUPPORTED_SERVER");
  }
  let server: URL;
  try { server = new URL(servers[0].url, targetOrigin); } catch { throw new OperationDiagnostic("UNSUPPORTED_SERVER"); }
  if (server.origin !== targetOrigin) throw new OperationDiagnostic("SERVER_ORIGIN_MISMATCH");
  if (server.username || server.password || server.search || server.hash) throw new OperationDiagnostic("UNSUPPORTED_SERVER");
  const basePath = server.pathname === "/" ? "" : server.pathname.replace(/\/$/, "");
  return `${basePath}${extracted.path}`;
}

function appendParameters(
  root: Record<string, unknown>,
  extracted: ExtractedOperation,
  inputProperties: Record<string, JsonSchema>,
  inputRequired: string[],
  optional: string[],
  usedFields: Set<string>,
): { pathTemplate: string; path: Record<string, string>; query: Record<string, string>; headers: Record<string, string> } {
  let pathTemplate = extracted.path;
  const path: Record<string, string> = {};
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const parameter of parametersFor(root, extracted)) {
    const location = parameter.in as string;
    const target = parameter.name as string;
    if (location === "cookie") throw new OperationDiagnostic("UNSUPPORTED_COOKIE_PARAMETER");
    if (!["path", "query", "header"].includes(location)) throw new OperationDiagnostic("UNSUPPORTED_PARAMETER_SERIALIZATION");
    const expectedStyle = location === "query" ? "form" : "simple";
    if (parameter.content !== undefined || parameter.style !== undefined && parameter.style !== expectedStyle
      || parameter.explode !== undefined && typeof parameter.explode !== "boolean" || parameter.allowReserved === true) {
      throw new OperationDiagnostic("UNSUPPORTED_PARAMETER_SERIALIZATION");
    }
    const schema = convertSchema(root, parameter.schema, true);
    if (schema.type === "array" || schema.type === "object") throw new OperationDiagnostic("UNSUPPORTED_PARAMETER_SERIALIZATION");
    const field = safeFieldName(location, target, usedFields);
    inputProperties[field] = schema;
    const required = location === "path" || parameter.required === true;
    (required ? inputRequired : optional).push(field);
    if (location === "path") {
      if (parameter.required !== true || !pathTemplate.includes(`{${target}}`)) throw new OperationDiagnostic("UNSUPPORTED_PARAMETER_SERIALIZATION");
      const placeholder = field;
      pathTemplate = pathTemplate.split(`{${target}}`).join(`{${placeholder}}`);
      path[placeholder] = field;
    } else if (location === "query") {
      if (!/^[A-Za-z][A-Za-z0-9_.~-]{0,127}$/.test(target)) throw new OperationDiagnostic("UNSUPPORTED_PARAMETER_SERIALIZATION");
      query[target] = field;
    } else {
      const normalized = target.toLowerCase();
      if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(target) || reservedRequestHeaders.has(normalized)
        || normalized.startsWith("sec-") || normalized.startsWith("proxy-")
        || /^(?:forwarded|range|x-forwarded-.+|x-real-ip|x-http-method-override|x-method-override|x-original-url|x-rewrite-url)$/i.test(normalized)
        || /(?:^|-)(?:api-key|authorization|bearer|cookie|credential|csrf|xsrf|idempotency|password|passwd|secret|session|token)(?:-|$)/i.test(normalized)) {
        throw new OperationDiagnostic("SERVER_ADAPTER_REQUIRED", "unsafe_header_parameter");
      }
      headers[target] = field;
    }
  }
  return { pathTemplate, path, query, headers };
}

function appendRequestBody(
  root: Record<string, unknown>,
  operation: Record<string, unknown>,
  inputProperties: Record<string, JsonSchema>,
  inputRequired: string[],
  optional: string[],
  usedFields: Set<string>,
): { body: Record<string, string>; bodyEncoding: "json" | "form_urlencoded" } {
  if (operation.requestBody === undefined) return { body: {}, bodyEncoding: "json" };
  const requestBody = resolveLocalRecord(root, operation.requestBody);
  if (!isRecord(requestBody.content)) throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
  const contentType = Object.prototype.hasOwnProperty.call(requestBody.content, "application/json")
    ? "application/json"
    : Object.prototype.hasOwnProperty.call(requestBody.content, "application/x-www-form-urlencoded")
      ? "application/x-www-form-urlencoded"
      : undefined;
  if (!contentType) throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
  const media = requestBody.content[contentType];
  if (!isRecord(media) || !isRecord(media.schema) || media.encoding !== undefined) {
    throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
  }
  const schema = convertSchema(root, media.schema, true);
  if (schema.type !== "object") throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
  if (requestBody.required !== undefined && typeof requestBody.required !== "boolean") {
    throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
  }
  const body: Record<string, string> = {};
  const requiredBodyFields = new Set(schema.required);
  if (requestBody.required === true ? requiredBodyFields.size === 0 : requiredBodyFields.size > 0) {
    // The canonical adapter has flat optional fields rather than a conditional
    // body-presence schema, so these shapes cannot be serialized exactly.
    throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
  }
  for (const target of Object.keys(schema.properties).sort(compareStrings)) {
    if (!/^[A-Za-z][A-Za-z0-9_.~-]{0,127}$/.test(target)) throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
    const property = schema.properties[target]!;
    if (property.type === "array" || property.type === "object") throw new OperationDiagnostic("UNSUPPORTED_REQUEST_BODY");
    const field = safeFieldName("body", target, usedFields);
    inputProperties[field] = property;
    const required = requestBody.required === true && requiredBodyFields.has(target);
    (required ? inputRequired : optional).push(field);
    body[target] = field;
  }
  return { body, bodyEncoding: contentType === "application/json" ? "json" : "form_urlencoded" };
}

function responsePlan(root: Record<string, unknown>, operation: Record<string, unknown>): {
  output: JsonSchema;
  contentTypes: string[];
  statusCodes: number[];
  errorMappings: Record<string, CapabilityErrorCode>;
} {
  if (!isRecord(operation.responses)) throw new OperationDiagnostic("UNSUPPORTED_RESPONSE");
  let output: JsonSchema | undefined;
  let outputIdentity: string | undefined;
  const contentTypes = new Set<string>();
  const statusCodes: number[] = [];
  const errorMappings: Record<string, CapabilityErrorCode> = {};
  for (const status of Object.keys(operation.responses).sort(compareStrings)) {
    if (/^[45]\d\d$/.test(status)) {
      const numeric = Number(status);
      errorMappings[status] = numeric === 401 ? "AUTHENTICATION_REQUIRED"
        : numeric === 403 ? "FORBIDDEN"
          : numeric === 404 || numeric === 410 ? "STALE_TARGET"
            : numeric === 400 || numeric === 409 || numeric === 422 ? "VALIDATION_FAILED"
              : numeric === 429 ? "RATE_LIMITED" : "TARGET_ERROR";
      continue;
    }
    if (!/^2\d\d$/.test(status) || status === "204" || status === "205") continue;
    const response = resolveLocalRecord(root, operation.responses[status]);
    if (!isRecord(response.content)) throw new OperationDiagnostic("UNSUPPORTED_RESPONSE");
    const candidates = Object.keys(response.content)
      .filter((contentType) => /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType))
      .sort(compareStrings);
    if (candidates.length === 0) throw new OperationDiagnostic("UNSUPPORTED_RESPONSE");
    const contentType = candidates[0]!;
    const media = response.content[contentType];
    if (!isRecord(media) || !isRecord(media.schema)) throw new OperationDiagnostic("UNSUPPORTED_RESPONSE");
    const schema = convertSchema(root, media.schema, false);
    const identity = JSON.stringify(schema);
    if (outputIdentity !== undefined && outputIdentity !== identity) throw new OperationDiagnostic("UNSUPPORTED_RESPONSE");
    output = schema;
    outputIdentity = identity;
    contentTypes.add(contentType);
    statusCodes.push(Number(status));
  }
  if (!output || statusCodes.length === 0) throw new OperationDiagnostic("UNSUPPORTED_RESPONSE");
  errorMappings.default = "TARGET_ERROR";
  return {
    output,
    contentTypes: [...contentTypes].sort(compareStrings),
    statusCodes: statusCodes.sort((left, right) => left - right),
    errorMappings,
  };
}

function authenticationFor(
  root: Record<string, unknown>,
  operation: Record<string, unknown>,
): CapabilityPlan["authentication"] {
  const security = operation.security ?? root.security;
  if (security === undefined || Array.isArray(security) && security.length === 0) return { mode: "public", requiredScopes: [] };
  if (!Array.isArray(security) || security.length !== 1 || !isRecord(security[0])) throw new OperationDiagnostic("AUTHENTICATION_AMBIGUOUS");
  const requirementEntries = Object.entries(security[0]);
  if (requirementEntries.length === 0) return { mode: "public", requiredScopes: [] };
  if (requirementEntries.length !== 1) throw new OperationDiagnostic("AUTHENTICATION_AMBIGUOUS");
  const [schemeName, requestedScopes] = requirementEntries[0]!;
  if (!Array.isArray(requestedScopes) || requestedScopes.some((scope) => typeof scope !== "string")) {
    throw new OperationDiagnostic("AUTHENTICATION_AMBIGUOUS");
  }
  const components = root.components;
  if (!isRecord(components) || !isRecord(components.securitySchemes)
    || !Object.prototype.hasOwnProperty.call(components.securitySchemes, schemeName)) {
    throw new OperationDiagnostic("AUTHENTICATION_AMBIGUOUS");
  }
  const scheme = resolveLocalRecord(root, components.securitySchemes[schemeName]);
  if (scheme.type === "apiKey" && scheme.in === "cookie") return { mode: "same_origin_cookie", requiredScopes: [] };
  if (scheme.type === "oauth2" && isRecord(scheme.flows)) {
    const browserFlow = scheme.flows.authorizationCode ?? scheme.flows.implicit;
    const serverFlow = scheme.flows.clientCredentials ?? scheme.flows.password;
    if (browserFlow !== undefined && serverFlow === undefined && isRecord(browserFlow)) {
      if (!isRecord(browserFlow.scopes) || requestedScopes.some((scope) => !Object.prototype.hasOwnProperty.call(browserFlow.scopes, scope))) {
        throw new OperationDiagnostic("AUTHENTICATION_AMBIGUOUS");
      }
      return { mode: "browser_oauth", requiredScopes: [...requestedScopes].sort(compareStrings) as string[] };
    }
    if (scheme.flows.clientCredentials !== undefined) {
      throw new OperationDiagnostic("SERVER_ADAPTER_REQUIRED", "oauth_client_credentials");
    }
    if (scheme.flows.password !== undefined) throw new OperationDiagnostic("SERVER_ADAPTER_REQUIRED", "oauth_password");
  }
  if (scheme.type === "apiKey") {
    throw new OperationDiagnostic("SERVER_ADAPTER_REQUIRED", scheme.in === "query" ? "api_key_query" : "api_key_header");
  }
  if (scheme.type === "http") {
    throw new OperationDiagnostic("SERVER_ADAPTER_REQUIRED", scheme.scheme === "basic" ? "http_basic" : "http_bearer");
  }
  if (scheme.type === "openIdConnect") throw new OperationDiagnostic("SERVER_ADAPTER_REQUIRED", "openid_connect");
  throw new OperationDiagnostic("SERVER_ADAPTER_REQUIRED", "unsupported_security_scheme");
}

function effectFor(operation: Record<string, unknown>, method: string): {
  effects: CapabilityPlan["effects"];
  idempotency: CapabilityPlan["idempotency"];
} {
  if (method === "get") {
    const review = operation["x-page2webmcp"];
    if (review !== undefined && (!isRecord(review)
      || review.effect !== undefined && review.effect !== "read"
      || review.riskTier !== undefined && review.riskTier !== "R0"
      || review.reversible === false
      || review.confirmation === "always")) {
      throw new OperationDiagnostic("EFFECT_REVIEW_REQUIRED");
    }
    return {
      effects: { kind: "read", riskTier: "R0", reversible: true, summary: "Reads reviewed API data without mutation.", confirmation: "none" },
      idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    };
  }
  if (method !== "post") throw new OperationDiagnostic("UNSUPPORTED_HTTP_METHOD");
  const review = operation["x-page2webmcp"];
  if (!isRecord(review) || review.reviewed !== true || review.effect !== "mutation"
    || !["R1", "R2", "R3"].includes(String(review.riskTier)) || typeof review.reversible !== "boolean") {
    throw new OperationDiagnostic("EFFECT_REVIEW_REQUIRED");
  }
  if (review.riskTier === "R3") throw new OperationDiagnostic("HIGH_RISK_OPERATION_BLOCKED");
  if (review.riskTier === "R1" && review.reversible !== true) throw new OperationDiagnostic("EFFECT_REVIEW_REQUIRED");
  let idempotency: CapabilityPlan["idempotency"] = { strategy: "none", verified: false, retry: "none" };
  if (review.idempotencyHeader !== undefined || review.idempotencyVerified !== undefined) {
    if (typeof review.idempotencyHeader !== "string" || review.idempotencyVerified !== true
      || !/^(?:x-)?idempotency(?:-key)?$/i.test(review.idempotencyHeader)) {
      throw new OperationDiagnostic("EFFECT_REVIEW_REQUIRED");
    }
    idempotency = { strategy: "header", headerName: review.idempotencyHeader, verified: true, retry: "safe_once" };
  }
  return {
    effects: {
      kind: "mutation",
      riskTier: review.riskTier as "R1" | "R2",
      reversible: review.reversible,
      summary: "Performs the reviewed API mutation.",
      confirmation: "always",
    },
    idempotency,
  };
}

function csrfFor(operation: Record<string, unknown>): CapabilityPlan["authentication"]["csrf"] | undefined {
  const review = operation["x-page2webmcp"];
  if (!isRecord(review) || review.csrf === undefined) return undefined;
  const csrf = review.csrf;
  if (!isRecord(csrf) || csrf.reviewed !== true || typeof csrf.headerName !== "string" || !isRecord(csrf.resolution)) {
    throw new OperationDiagnostic("CSRF_REVIEW_REQUIRED");
  }
  if (csrf.resolution.kind === "meta" && typeof csrf.resolution.name === "string") return {
    reviewed: true,
    headerName: csrf.headerName,
    resolution: { kind: "meta", name: csrf.resolution.name, attribute: "content" },
  };
  if (csrf.resolution.kind === "hidden_input" && typeof csrf.resolution.name === "string") return {
    reviewed: true,
    headerName: csrf.headerName,
    resolution: { kind: "hidden_input", name: csrf.resolution.name, attribute: "value" },
  };
  throw new OperationDiagnostic("CSRF_REVIEW_REQUIRED");
}

function compileOperation(root: Record<string, unknown>, extracted: ExtractedOperation, options: OpenApiCompileOptions): PlanOperation {
  const method = extracted.method.toUpperCase();
  if (method !== "GET" && method !== "POST") throw new OperationDiagnostic("UNSUPPORTED_HTTP_METHOD");
  const { effects, idempotency } = effectFor(extracted.operation, extracted.method);
  const authentication = authenticationFor(root, extracted.operation);
  const csrf = csrfFor(extracted.operation);
  if (effects.kind === "mutation" && authentication.mode === "same_origin_cookie" && !csrf) {
    throw new OperationDiagnostic("CSRF_REVIEW_REQUIRED");
  }
  const inputProperties: Record<string, JsonSchema> = {};
  const inputRequired: string[] = [];
  const optional: string[] = [];
  const usedFields = new Set<string>();
  const runtimeExtracted = { ...extracted, path: runtimeOperationPath(root, extracted, options.targetOrigin) };
  const requestParameters = appendParameters(root, runtimeExtracted, inputProperties, inputRequired, optional, usedFields);
  const requestBody = appendRequestBody(root, extracted.operation, inputProperties, inputRequired, optional, usedFields);
  const response = responsePlan(root, extracted.operation);
  const name = operationName(extracted.operation.operationId, method, runtimeExtracted.path);
  const input: ObjectJsonSchema = {
    type: "object",
    properties: inputProperties,
    required: [...inputRequired].sort(compareStrings),
    additionalProperties: false,
  };
  const plan: CapabilityPlan = {
    version: 1,
    targetOrigin: options.targetOrigin,
    tool: {
      name,
      title: `${method} ${runtimeExtracted.path}`.slice(0, 120),
      description: method === "GET" ? "Read data from the reviewed API operation." : "Run the reviewed API mutation.",
    },
    schemas: { input, output: response.output },
    annotations: { readOnly: effects.kind === "read", untrusted: false },
    authentication: { ...authentication, ...(csrf ? { csrf } : {}) },
    effects,
    idempotency,
    request: {
      adapter: "json_api",
      method,
      pathTemplate: requestParameters.pathTemplate,
      path: requestParameters.path,
      query: requestParameters.query,
      headers: requestParameters.headers,
      body: requestBody.body,
      optional: [...optional].sort(compareStrings),
      bodyEncoding: requestBody.bodyEncoding,
    },
    response: {
      adapter: "json_api",
      contentTypes: response.contentTypes,
      projection: { kind: "identity" },
      errorMappings: response.errorMappings,
    },
    success: { adapter: "json_api", statusCodes: response.statusCodes, requiredOutputFields: [] },
    evidence: [{ source: "openapi", reference: options.evidenceReference }],
  };
  try {
    return { key: extracted.key, method, path: runtimeExtracted.path, plan: CapabilityPlanSchema.parse(plan) };
  } catch {
    throw new OperationDiagnostic("MALFORMED_OPERATION");
  }
}

function compileOperations(document: OpenApiDocument, options: OpenApiCompileOptions): {
  operations: PlanOperation[];
  diagnostics: OpenApiDiagnostic[];
} {
  assertCompileContext(options);
  const root = assertCompilableDocument(document);
  const operations: PlanOperation[] = [];
  const diagnostics: OpenApiDiagnostic[] = [];
  for (const extracted of extractOperations(root)) {
    try {
      operations.push(compileOperation(root, extracted, options));
    } catch (error) {
      if (!(error instanceof OperationDiagnostic)) throw error;
      diagnostics.push({ code: error.code, operationKey: extracted.key, ...(error.reason ? { reason: error.reason } : {}) });
    }
  }
  if (operations.length > 100) resourceLimit();
  return { operations, diagnostics };
}

function deterministicGroups(operations: readonly PlanOperation[]): OpenApiGroup[] {
  return operations.map(({ key, plan }) => ({ name: plan.tool.name, operations: [key] }));
}

function validateGroups(value: unknown, expectedOperations: readonly PlanOperation[]): OpenApiGroup[] {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 32_768) {
      throw new Error("INVALID_OPENAPI_GROUPING");
    }
  } catch {
    throw new Error("INVALID_OPENAPI_GROUPING");
  }
  if (!isRecord(value) || !Array.isArray(value.groups) || value.groups.length === 0 || value.groups.length > 100) {
    throw new Error("INVALID_OPENAPI_GROUPING");
  }
  const groups: OpenApiGroup[] = [];
  const seenNames = new Set<string>();
  const seenOperations = new Set<string>();
  const expected = new Set(expectedOperations.map(({ key }) => key));
  for (const group of value.groups) {
    if (!isRecord(group) || typeof group.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(group.name)
      || seenNames.has(group.name) || !Array.isArray(group.operations) || group.operations.length === 0
      || group.operations.some((operation) => typeof operation !== "string" || !expected.has(operation) || seenOperations.has(operation))) {
      throw new Error("INVALID_OPENAPI_GROUPING");
    }
    seenNames.add(group.name);
    for (const operation of group.operations as string[]) seenOperations.add(operation);
    groups.push({ name: group.name, operations: [...group.operations] as string[] });
  }
  if (seenOperations.size !== expected.size) throw new Error("INVALID_OPENAPI_GROUPING");
  return groups;
}

export function compileOpenApi(document: OpenApiDocument, options: OpenApiCompileOptions): OpenApiCompileResult {
  const { operations, diagnostics } = compileOperations(document, options);
  const plans = operations.length === 0 ? [] : [...canonicalizeCapabilityPlans(operations.map(({ plan }) => plan))];
  return { plans, diagnostics, groups: deterministicGroups(operations) };
}

export async function compileOpenApiWithGrouping(
  document: OpenApiDocument,
  options: OpenApiCompileOptions,
  groupingPort?: OpenApiGroupingPort,
): Promise<OpenApiCompileResult> {
  const compiled = compileOperations(document, options);
  const plans = compiled.operations.length === 0 ? [] : [...canonicalizeCapabilityPlans(compiled.operations.map(({ plan }) => plan))];
  if (!groupingPort || compiled.operations.length === 0) {
    return { plans, diagnostics: compiled.diagnostics, groups: deterministicGroups(compiled.operations) };
  }
  const controller = new AbortController();
  const error = new Error("OPENAPI_GROUPING_TIMEOUT");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let response: unknown;
  try {
    response = await Promise.race([
      groupingPort.group({
        version: 1,
        operations: compiled.operations.map(({ key, method, path, plan }) => ({ key, method, path, suggestedName: plan.tool.name })),
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { controller.abort(error); reject(error); }, 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return { plans, diagnostics: compiled.diagnostics, groups: validateGroups(response, compiled.operations) };
}
