import { createHash } from "node:crypto";

export type JsonSchema =
  | { type: "string"; minLength?: number; maxLength?: number; enum?: string[] }
  | { type: "boolean" }
  | { type: "number" }
  | { type: "array"; items: JsonSchema; maxItems?: number }
  | { type: "object"; properties: Record<string, JsonSchema>; required: string[]; additionalProperties: false };

export type RequestPlan = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: string[];
};

export type CompilableCapability = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema?: Extract<JsonSchema, { type: "object" }>;
  outputSchema?: JsonSchema;
  requestPlan?: RequestPlan;
  untrustedContent?: boolean;
  requiresConfirmation?: boolean;
};

export type CompiledRelease = {
  code: string;
  contentHash: string;
  integrity: string;
  allowedOrigin: string;
  manifest: {
    version: 2;
    allowedOrigin: string;
    tools: Array<{
      name: string;
      readOnly: boolean;
      untrustedContent: boolean;
      requiresConfirmation: boolean;
    }>;
  };
};

type NormalizedCapability = Omit<CompilableCapability, "inputSchema" | "outputSchema" | "requestPlan" | "requiresConfirmation"> & {
  inputSchema: Extract<JsonSchema, { type: "object" }>;
  outputSchema: JsonSchema;
  requestPlan: RequestPlan;
  requiresConfirmation: boolean;
};

const stringSchema = { type: "string" as const, minLength: 1, maxLength: 120 };
const ticketOutput: JsonSchema = {
  type: "object",
  properties: {
    ticketId: { type: "string" },
    status: { type: "string", enum: ["open"] },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    createdAt: { type: "string" },
  },
  required: ["ticketId", "status", "priority", "createdAt"],
  additionalProperties: false,
};
const orderSummary: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" }, email: { type: "string" }, shipmentStatus: { type: "string" } },
  required: ["id", "email", "shipmentStatus"],
  additionalProperties: false,
};

const vettedAcmePlans: Record<string,
  Pick<NormalizedCapability, "inputSchema" | "outputSchema" | "requestPlan"> & { untrustedContent?: boolean }
> = {
  find_order: {
    inputSchema: { type: "object", properties: { query: stringSchema }, required: ["query"], additionalProperties: false },
    requestPlan: { method: "GET", path: "/api/orders", query: { q: "query" } },
    outputSchema: { type: "array", items: orderSummary, maxItems: 100 },
  },
  get_order_status: {
    untrustedContent: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["query"],
      additionalProperties: false
    },
    requestPlan: { method: "GET", path: "/api/orders/{query}" },
    outputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string" }, shipmentStatus: { type: "string" },
        customerNotes: { type: "string" }, untrustedContent: { type: "boolean" },
      },
      required: ["orderId", "shipmentStatus", "customerNotes", "untrustedContent"],
      additionalProperties: false,
    },
  },
  create_support_ticket: {
    inputSchema: {
      type: "object",
      properties: {
        orderId: stringSchema,
        title: { type: "string", minLength: 3, maxLength: 120 },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["orderId", "title", "priority"],
      additionalProperties: false,
    },
    requestPlan: { method: "POST", path: "/api/tickets", body: ["orderId", "title", "priority"] },
    outputSchema: ticketOutput,
  },
};

function assertSchema(schema: JsonSchema, label: string): void {
  if (!schema || typeof schema !== "object") throw new Error(`${label} must be a supported JSON schema`);
  if (schema.type === "string") {
    if (schema.minLength !== undefined && (!Number.isInteger(schema.minLength) || schema.minLength < 0)) throw new Error(`${label} has invalid minLength`);
    if (schema.maxLength !== undefined && (!Number.isInteger(schema.maxLength) || schema.maxLength < 0)) throw new Error(`${label} has invalid maxLength`);
    if (schema.enum?.some((value) => typeof value !== "string")) throw new Error(`${label} has invalid enum`);
    return;
  }
  if (schema.type === "array") {
    if (schema.maxItems !== undefined && (!Number.isInteger(schema.maxItems) || schema.maxItems < 0)) throw new Error(`${label} has invalid maxItems`);
    assertSchema(schema.items, `${label}.items`);
    return;
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) throw new Error(`${label} must reject additional properties`);
    if (!Array.isArray(schema.required) || schema.required.some((key) =>
      typeof key !== "string" || !Object.prototype.hasOwnProperty.call(schema.properties, key)
    )) throw new Error(`${label} has invalid required fields`);
    for (const [key, property] of Object.entries(schema.properties)) assertSchema(property, `${label}.${key}`);
    return;
  }
  if (schema.type !== "boolean" && schema.type !== "number") throw new Error(`${label} uses an unsupported schema type`);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.origin !== value || url.username || url.password) throw new Error("allowedOrigin must be an exact HTTP(S) origin");
  return url.origin;
}

function validatePlan(capability: NormalizedCapability): void {
  const plan = capability.requestPlan;
  if (plan.method !== "GET" && plan.method !== "POST") throw new Error(`unsupported request method for ${capability.name}`);
  if (!plan.path.startsWith("/") || plan.path.startsWith("//") || plan.path.includes("?") || plan.path.includes("#")) throw new Error(`unsafe request path for ${capability.name}`);
  if (plan.method === "GET" && plan.body?.length) throw new Error(`GET request cannot have a body for ${capability.name}`);
  if (!capability.readOnly && plan.method !== "POST") throw new Error(`mutation must use POST for ${capability.name}`);
  if (plan.method === "POST" && capability.readOnly) throw new Error(`read-only capability cannot use POST for ${capability.name}`);
  if (plan.method === "POST" && !capability.requiresConfirmation) throw new Error(`mutation must require confirmation for ${capability.name}`);
  const required = new Set(capability.inputSchema.required);
  const referenced = [
    ...Object.values(plan.query ?? {}),
    ...(plan.body ?? []),
    ...Array.from(plan.path.matchAll(/\{([^}]+)\}/g), (match) => match[1]!),
  ];
  if (referenced.some((field) => !Object.prototype.hasOwnProperty.call(capability.inputSchema.properties, field))) {
    throw new Error(`request plan references an unknown input field for ${capability.name}`);
  }
  if (referenced.some((field) => !required.has(field))) throw new Error(`request plan references an optional input field for ${capability.name}`);
}

function normalizeCapability(capability: CompilableCapability): NormalizedCapability {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(capability.name)) throw new Error(`invalid capability name: ${capability.name}`);
  const vetted = Object.prototype.hasOwnProperty.call(vettedAcmePlans, capability.name) ? vettedAcmePlans[capability.name] : undefined;
  const requestPlan = capability.requestPlan ?? vetted?.requestPlan;
  const outputSchema = capability.outputSchema ?? vetted?.outputSchema;
  if (!requestPlan || !outputSchema) throw new Error(`${capability.name} lacks a vetted request plan and output schema`);
  const inputSchema = capability.inputSchema ?? vetted?.inputSchema ?? {
    type: "object", properties: { query: stringSchema }, required: ["query"], additionalProperties: false,
  };
  const normalized: NormalizedCapability = {
    ...capability,
    inputSchema,
    outputSchema,
    requestPlan,
    // Vetted knowledge is authoritative for known attacker-controlled outputs.
    // Callers may conservatively classify other tools, but cannot downgrade one.
    untrustedContent: vetted?.untrustedContent === true || capability.untrustedContent === true,
    requiresConfirmation: capability.requiresConfirmation ?? !capability.readOnly,
  };
  assertSchema(normalized.inputSchema, `${capability.name}.inputSchema`);
  assertSchema(normalized.outputSchema, `${capability.name}.outputSchema`);
  validatePlan(normalized);
  return normalized;
}

const runtimeSource = String.raw`
export class Page2WebMCPError extends Error {
  constructor(code) {
    const messages = {
      ORIGIN_MISMATCH: "This tool is not available on this origin.",
      INVALID_INPUT: "The tool input is invalid.",
      INVALID_OUTPUT: "The tool returned an invalid response.",
      HTTP_ERROR: "The tool request failed.",
      RESPONSE_TOO_LARGE: "The tool response exceeded the size limit.",
      DEADLINE_EXCEEDED: "The tool request timed out.",
      ABORTED: "The tool request was cancelled.",
      CONFIRMATION_REQUIRED: "Explicit confirmation is required.",
      CONFIRMATION_DECLINED: "The action was not confirmed.",
      CONFIRMATION_FAILED: "Confirmation could not be completed.",
      REGISTRATION_FAILED: "Tool registration failed.",
      INTERNAL_ERROR: "The tool request failed.",
    };
    super(messages[code] || messages.INTERNAL_ERROR);
    this.name = "Page2WebMCPError";
    this.code = code;
  }
}

const MAX_RESPONSE_BYTES = 65536;
const EXECUTION_DEADLINE_MS = 15000;
let registrationState;
let registrationGeneration = 0;
let runtimeBridge;
const pendingMutationKeys = new Map();

function assertAllowedOrigin() {
  if (window.location.origin !== releaseManifest.allowedOrigin) throw new Page2WebMCPError("ORIGIN_MISMATCH");
}

function emitDiagnostic(bridge, phase, code) {
  try { bridge?.onDiagnostic?.({ phase, code }); } catch { /* diagnostics never affect tools */ }
}

function validateAndProject(schema, value, code) {
  const fail = () => { throw new Page2WebMCPError(code); };
  if (schema.type === "string") {
    if (typeof value !== "string" || (schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.enum && !schema.enum.includes(value))) fail();
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail();
    return value;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail();
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail();
    return value.map((item) => validateAndProject(schema.items, item, code));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (schema.additionalProperties === false && keys.some((key) => !Object.prototype.hasOwnProperty.call(schema.properties, key))) fail();
  if (schema.required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) fail();
  const output = Object.create(null);
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = validateAndProject(propertySchema, value[key], code);
  }
  return output;
}

function validIdempotencyKey(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(value);
}

function sessionStorageOrUndefined() {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

async function mutationStorageKey(identity) {
  try {
    if (!globalThis.crypto?.subtle) return undefined;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return "page2webmcp.mutation.v1." + hex;
  } catch {
    return undefined;
  }
}

async function acquirePendingMutation(spec, input) {
  const identity = JSON.stringify([releaseManifest.allowedOrigin, spec.name, spec.requestPlan, input]);
  const inMemory = pendingMutationKeys.get(identity);
  if (validIdempotencyKey(inMemory)) return { identity, key: inMemory };
  const storageKey = await mutationStorageKey(identity);
  const raced = pendingMutationKeys.get(identity);
  if (validIdempotencyKey(raced)) return { identity, key: raced, storageKey };
  const storage = sessionStorageOrUndefined();
  let stored;
  try { stored = storageKey ? storage?.getItem(storageKey) : undefined; } catch { /* fall back to memory */ }
  const key = validIdempotencyKey(stored) ? stored : globalThis.crypto?.randomUUID?.();
  if (!validIdempotencyKey(key)) throw new Page2WebMCPError("CONFIRMATION_FAILED");
  pendingMutationKeys.set(identity, key);
  try { if (storageKey) storage?.setItem(storageKey, key); } catch { /* memory still protects this page */ }
  return { identity, key, storageKey };
}

function completePendingMutation(pending) {
  if (pendingMutationKeys.get(pending.identity) === pending.key) pendingMutationKeys.delete(pending.identity);
  const storage = sessionStorageOrUndefined();
  try {
    if (pending.storageKey && storage?.getItem(pending.storageKey) === pending.key) {
      storage.removeItem(pending.storageKey);
    }
  } catch { /* browser storage is an optional recovery aid */ }
}

function requestUrl(plan, input) {
  const path = plan.path.replace(/\{([^}]+)\}/g, (_match, field) => encodeURIComponent(input[field]));
  const url = new URL(path, releaseManifest.allowedOrigin);
  if (url.origin !== releaseManifest.allowedOrigin) throw new Page2WebMCPError("ORIGIN_MISMATCH");
  for (const [parameter, field] of Object.entries(plan.query || {})) url.searchParams.set(parameter, input[field]);
  return url;
}

function signalError(signal) {
  return signal.reason instanceof Page2WebMCPError ? signal.reason : new Page2WebMCPError("ABORTED");
}

function assertExecutionActive(signal) {
  if (signal.aborted) throw signalError(signal);
}

async function runExecution(callerSignal, operation) {
  if (callerSignal?.aborted) throw new Page2WebMCPError("ABORTED");
  const controller = new AbortController();
  const abort = (code) => {
    if (!controller.signal.aborted) controller.abort(new Page2WebMCPError(code));
  };
  const onCallerAbort = () => abort("ABORTED");
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => abort("DEADLINE_EXCEEDED"), EXECUTION_DEADLINE_MS);
  const aborted = new Promise((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(signalError(controller.signal)), { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

async function readBoundedBody(response, signal) {
  const declaredHeader = response.headers.get("content-length");
  const declaredLength = declaredHeader === null ? 0 : Number(declaredHeader);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Page2WebMCPError("RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      assertExecutionActive(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Page2WebMCPError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

class RetryableRequestError extends Error {}
class DefinitiveRequestError extends Page2WebMCPError {
  constructor() { super("HTTP_ERROR"); }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}

async function requestJsonOnce(url, init, signal) {
  assertAllowedOrigin();
  assertExecutionActive(signal);
  try {
    const response = await runtimeBridge.fetch(url, { ...init, credentials: "same-origin", signal });
    assertExecutionActive(signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (isRetryableStatus(response.status)) throw new RetryableRequestError();
      throw new DefinitiveRequestError();
    }
    const body = await readBoundedBody(response, signal);
    assertExecutionActive(signal);
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new Page2WebMCPError("INVALID_OUTPUT");
    }
  } catch (error) {
    if (error instanceof Page2WebMCPError || error instanceof RetryableRequestError) throw error;
    if (signal.aborted) throw signalError(signal);
    throw new RetryableRequestError();
  }
}

async function requestJson(url, init, signal, allowRetry = false) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await requestJsonOnce(url, init, signal);
    } catch (error) {
      if (signal.aborted) throw signalError(signal);
      if (!(error instanceof RetryableRequestError)) throw error;
      if (!allowRetry || attempt === 1) throw new Page2WebMCPError("HTTP_ERROR");
    }
  }
  throw new Page2WebMCPError("HTTP_ERROR");
}

async function executeWithinDeadline(spec, rawInput, signal) {
  assertAllowedOrigin();
  const input = validateAndProject(spec.inputSchema, rawInput, "INVALID_INPUT");
  const plan = spec.requestPlan;
  const headers = new Headers();
  let body;
  if (plan.body) {
    const bodyValue = {};
    for (const field of plan.body) bodyValue[field] = input[field];
    body = JSON.stringify(bodyValue);
    headers.set("content-type", "application/json");
  }
  if (plan.method === "POST") {
    if (typeof runtimeBridge.confirm !== "function") throw new Page2WebMCPError("CONFIRMATION_REQUIRED");
    const pending = await acquirePendingMutation(spec, input);
    let finalRequestStarted = false;
    try {
      assertExecutionActive(signal);
      const approved = await runtimeBridge.confirm({ toolName: spec.name, input, idempotencyKey: pending.key, signal });
      assertExecutionActive(signal);
      if (approved !== true) throw new Page2WebMCPError("CONFIRMATION_DECLINED");
      const confirmation = await requestJson(new URL("/api/confirmations", releaseManifest.allowedOrigin), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolName: spec.name, input, idempotencyKey: pending.key }),
      }, signal);
      if (!confirmation || typeof confirmation.evidence !== "string" || confirmation.evidence.length < 1) {
        throw new Page2WebMCPError("CONFIRMATION_FAILED");
      }
      headers.set("idempotency-key", pending.key);
      headers.set("x-page2webmcp-confirmation", confirmation.evidence);
      finalRequestStarted = true;
      const result = await requestJson(requestUrl(plan, input), { method: plan.method, headers, body }, signal, true);
      const output = validateAndProject(spec.outputSchema, result, "INVALID_OUTPUT");
      completePendingMutation(pending);
      return output;
    } catch (error) {
      if (!finalRequestStarted || error instanceof DefinitiveRequestError) completePendingMutation(pending);
      if (signal.aborted) throw signalError(signal);
      if (error instanceof Page2WebMCPError) throw error;
      throw new Page2WebMCPError("CONFIRMATION_FAILED");
    }
  }
  const result = await requestJson(requestUrl(plan, input), { method: plan.method, headers, body }, signal, true);
  return validateAndProject(spec.outputSchema, result, "INVALID_OUTPUT");
}

async function executePlan(spec, input, callerSignal) {
  try {
    return await runExecution(callerSignal, (signal) => executeWithinDeadline(spec, input, signal));
  } catch (error) {
    const safeError = error instanceof Page2WebMCPError ? error : new Page2WebMCPError("INTERNAL_ERROR");
    emitDiagnostic(runtimeBridge, "execution", safeError.code);
    throw safeError;
  }
}

export async function registerPage2WebMCPTools(bridge = {}) {
  if (window.location.origin !== releaseManifest.allowedOrigin) return { supported: false, reason: "ORIGIN_MISMATCH" };
  if (!document.modelContext) return { supported: false, reason: "WEBMCP_UNAVAILABLE" };
  const existing = registrationState;
  if (existing && !existing.controller.signal.aborted) {
    try {
      await existing.promise;
    } catch {
      emitDiagnostic(bridge, "registration", "REGISTRATION_FAILED");
      throw new Page2WebMCPError("REGISTRATION_FAILED");
    }
    return existing.controller.signal.aborted
      ? { supported: false, reason: "REGISTRATION_CANCELLED" }
      : { supported: true, alreadyRegistered: true };
  }

  const controller = new AbortController();
  const generation = ++registrationGeneration;
  const state = { controller, generation, promise: undefined };
  runtimeBridge = { fetch: globalThis.fetch.bind(globalThis), confirm: bridge.confirm, onDiagnostic: bridge.onDiagnostic };
  state.promise = (async () => {
    for (const spec of toolPlans) {
      if (controller.signal.aborted || generation !== registrationGeneration) return;
      await document.modelContext.registerTool({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: { readOnlyHint: spec.readOnly, untrustedContentHint: spec.untrustedContent ?? false },
        execute: (input, { signal }) => executePlan(spec, input, signal),
      }, { signal: controller.signal });
      if (controller.signal.aborted || generation !== registrationGeneration) return;
    }
  })();
  registrationState = state;
  try {
    await state.promise;
  } catch {
    controller.abort();
    if (registrationState === state) registrationState = undefined;
    if (generation === registrationGeneration) runtimeBridge = undefined;
    emitDiagnostic(bridge, "registration", "REGISTRATION_FAILED");
    throw new Page2WebMCPError("REGISTRATION_FAILED");
  }
  if (controller.signal.aborted || generation !== registrationGeneration) return { supported: false, reason: "REGISTRATION_CANCELLED" };
  return { supported: true };
}

export function unregisterPage2WebMCPTools() {
  registrationGeneration += 1;
  registrationState?.controller.abort();
  registrationState = undefined;
  runtimeBridge = undefined;
}
`;

export function compileWebMcpRelease(capabilities: CompilableCapability[], allowedOrigin: string): CompiledRelease {
  const origin = normalizeOrigin(allowedOrigin);
  const seen = new Set<string>();
  const normalized = capabilities.map((capability) => {
    if (seen.has(capability.name)) throw new Error(`duplicate capability name: ${capability.name}`);
    seen.add(capability.name);
    return normalizeCapability(capability);
  });
  const manifest = {
    version: 2 as const,
    allowedOrigin: origin,
    tools: normalized.map(({ name, readOnly, untrustedContent, requiresConfirmation }) => ({
      name,
      readOnly,
      untrustedContent: untrustedContent ?? false,
      requiresConfirmation
    })),
  };
  const plans = normalized.map(({ name, description, readOnly, inputSchema, outputSchema, requestPlan, untrustedContent, requiresConfirmation }) => ({
    name, description, readOnly, inputSchema, outputSchema, requestPlan,
    untrustedContent: untrustedContent ?? false, requiresConfirmation,
  }));
  const code = `"use strict";\nexport const releaseManifest = Object.freeze(${JSON.stringify(manifest)});\nconst toolPlans = Object.freeze(${JSON.stringify(plans)});\n${runtimeSource.trimStart()}`;
  const digest = createHash("sha256").update(code).digest();
  return {
    code,
    contentHash: digest.toString("hex"),
    integrity: `sha256-${digest.toString("base64")}`,
    allowedOrigin: origin,
    manifest
  };
}
