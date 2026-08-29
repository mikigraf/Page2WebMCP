import { parseDocument } from "yaml";

type Operation = { operationId?: string; summary?: string; [key: string]: unknown };
export type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Partial<Record<"get" | "post" | "put" | "patch" | "delete", Operation>>>;
  [key: string]: unknown;
};
export type OpenApiCapability = { name: string; risk: "R0" | "R1"; operations: string[] };

const MAX_DOCUMENT_BYTES = 1_000_000;
const MAX_DOCUMENT_DEPTH = 64;
const MAX_DOCUMENT_NODES = 10_000;
const MAX_LOCAL_REFERENCE_STEPS = 10_000;
const operationMethods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const names: Record<string, { name: string; risk: "R0" | "R1" }> = {
  findOrder: { name: "find_order", risk: "R0" }, getOrderStatus: { name: "get_order_status", risk: "R0" }, createSupportTicket: { name: "create_support_ticket", risk: "R1" }
};

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

export function compileOpenApi(document: OpenApiDocument): { capabilities: OpenApiCapability[]; diagnostics: Array<{ code: "HIGH_RISK_OPERATION_BLOCKED"; operationId: string }> } {
  if (!isSupportedOpenApiVersion(document.openapi)) throw new Error("UNSUPPORTED_OPENAPI_VERSION");
  const capabilities: OpenApiCapability[] = []; const diagnostics: Array<{ code: "HIGH_RISK_OPERATION_BLOCKED"; operationId: string }> = [];
  for (const item of Object.values(document.paths)) for (const [method, operation] of Object.entries(item)) {
    const operationId = operation?.operationId; if (!operationId) continue;
    if (method === "delete" || /delete|payment|password|permission/i.test(operationId)) { diagnostics.push({ code: "HIGH_RISK_OPERATION_BLOCKED", operationId }); continue; }
    const target = names[operationId]; if (target) capabilities.push({ ...target, operations: [operationId] });
  }
  return { capabilities, diagnostics };
}
