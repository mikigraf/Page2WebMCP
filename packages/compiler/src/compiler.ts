import { createHash } from "node:crypto";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../capability-ir/src/plan.ts";

export type CapabilityReleaseManifest = Readonly<{
  version: 3;
  releaseId: string;
  targetOrigin: string;
  plans: readonly CapabilityPlan[];
}>;

export type CompiledRelease = {
  code: string;
  contentHash: string;
  integrity: string;
  allowedOrigin: string;
  manifest: CapabilityReleaseManifest;
};

const runtimeSource = String.raw`
export class Page2WebMCPError extends Error {
  constructor(code) {
    const messages = {
      ORIGIN_MISMATCH: "This tool is not available on this origin.",
      INVALID_INPUT: "The tool input is invalid.",
      INVALID_OUTPUT: "The tool returned an invalid response.",
      AUTHENTICATION_REQUIRED: "Sign in before using this tool.",
      FORBIDDEN: "The current account cannot perform this action.",
      STALE_TARGET: "The target changed before the action completed.",
      VALIDATION_FAILED: "The target rejected the request.",
      RATE_LIMITED: "The target temporarily rate-limited the request.",
      TARGET_ERROR: "The target request failed.",
      UNSUPPORTED_CONTENT_TYPE: "The target returned an unsupported content type.",
      RESPONSE_TOO_LARGE: "The tool response exceeded the size limit.",
      DEADLINE_EXCEEDED: "The tool request timed out.",
      ABORTED: "The tool request was cancelled.",
      CSRF_UNAVAILABLE: "The reviewed CSRF value is unavailable.",
      IDEMPOTENCY_UNAVAILABLE: "The mutation cannot be safely identified.",
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
const REGISTRY_SYMBOL = Symbol.for("page2webmcp.release.registry.v1");
const RELEASE_KEY = releaseManifest.releaseId;
let lastRegistrationStatus = "idle";

function releaseRegistry() {
  let registry = globalThis[REGISTRY_SYMBOL];
  if (!(registry instanceof Map)) {
    registry = new Map();
    globalThis[REGISTRY_SYMBOL] = registry;
  }
  return registry;
}

function assertAllowedOrigin() {
  if (globalThis.window?.location?.origin !== releaseManifest.targetOrigin) {
    throw new Page2WebMCPError("ORIGIN_MISMATCH");
  }
}

function emitDiagnostic(state, phase, code) {
  try { state?.bridge?.onDiagnostic?.({ phase, code }); } catch { /* diagnostics never affect tools */ }
}

function validateAndProject(schema, value, code) {
  const fail = () => { throw new Page2WebMCPError(code); };
  if (schema.type === "string") {
    if (typeof value !== "string"
      || (schema.minLength !== undefined && value.length < schema.minLength)
      || (schema.maxLength !== undefined && value.length > schema.maxLength)
      || (schema.enum && !schema.enum.includes(value))) fail();
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail();
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))
      || (schema.minimum !== undefined && value < schema.minimum)
      || (schema.maximum !== undefined && value > schema.maximum)) fail();
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)
      || (schema.minItems !== undefined && value.length < schema.minItems)
      || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail();
    return value.map((item) => validateAndProject(schema.items, item, code));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(schema.properties, key))) fail();
  if (schema.required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) fail();
  const output = Object.create(null);
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      output[key] = validateAndProject(propertySchema, value[key], code);
    }
  }
  return output;
}

function projectResponse(projection, raw) {
  if (projection.kind === "identity") return raw;
  const projectItem = (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Page2WebMCPError("INVALID_OUTPUT");
    const projected = Object.create(null);
    for (const [outputField, responseField] of Object.entries(projection.fields)) projected[outputField] = item[responseField];
    return projected;
  };
  if (projection.kind === "array") {
    if (!Array.isArray(raw)) throw new Page2WebMCPError("INVALID_OUTPUT");
    return raw.map(projectItem);
  }
  return projectItem(raw);
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

async function acquirePendingMutation(state, spec, input) {
  const identity = JSON.stringify([releaseManifest.releaseId, spec.tool.name, spec.request, input]);
  const inMemory = state.pendingMutationKeys.get(identity);
  if (validIdempotencyKey(inMemory)) return { identity, key: inMemory };
  const storageKey = await mutationStorageKey(identity);
  const raced = state.pendingMutationKeys.get(identity);
  if (validIdempotencyKey(raced)) return { identity, key: raced, storageKey };
  const storage = sessionStorageOrUndefined();
  let stored;
  try { stored = storageKey ? storage?.getItem(storageKey) : undefined; } catch { /* memory remains available */ }
  const key = validIdempotencyKey(stored) ? stored : globalThis.crypto?.randomUUID?.();
  if (!validIdempotencyKey(key)) throw new Page2WebMCPError("IDEMPOTENCY_UNAVAILABLE");
  state.pendingMutationKeys.set(identity, key);
  try { if (storageKey) storage?.setItem(storageKey, key); } catch { /* memory remains authoritative */ }
  return { identity, key, storageKey };
}

function completePendingMutation(state, pending) {
  if (!pending) return;
  if (state.pendingMutationKeys.get(pending.identity) === pending.key) state.pendingMutationKeys.delete(pending.identity);
  const storage = sessionStorageOrUndefined();
  try {
    if (pending.storageKey && storage?.getItem(pending.storageKey) === pending.key) storage.removeItem(pending.storageKey);
  } catch { /* storage is only a recovery aid */ }
}

function requestUrl(request, input) {
  const path = request.pathTemplate.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, placeholder) =>
    encodeURIComponent(input[request.path[placeholder]]));
  const url = new URL(path, releaseManifest.targetOrigin);
  if (url.origin !== releaseManifest.targetOrigin) throw new Page2WebMCPError("ORIGIN_MISMATCH");
  for (const [parameter, field] of Object.entries(request.query)) url.searchParams.set(parameter, input[field]);
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

class RetryableRequestError extends Error {
  constructor(code) { super(code); this.code = code; }
}

class DefinitiveRequestError extends Page2WebMCPError {}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}

function mappedError(spec, status) {
  return spec.response.errorMappings[String(status)] || spec.response.errorMappings.default;
}

async function requestJsonOnce(state, spec, url, init, signal) {
  assertAllowedOrigin();
  assertExecutionActive(signal);
  try {
    const response = await globalThis.fetch(url, { ...init, credentials: "same-origin", signal });
    assertExecutionActive(signal);
    if (!spec.success.statusCodes.includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      const code = mappedError(spec, response.status);
      if (retryableStatus(response.status)) throw new RetryableRequestError(code);
      throw new DefinitiveRequestError(code);
    }
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (!spec.response.contentTypes.includes(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw new DefinitiveRequestError("UNSUPPORTED_CONTENT_TYPE");
    }
    const body = await readBoundedBody(response, signal);
    assertExecutionActive(signal);
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new DefinitiveRequestError("INVALID_OUTPUT");
    }
  } catch (error) {
    if (error instanceof Page2WebMCPError || error instanceof RetryableRequestError) throw error;
    if (signal.aborted) throw signalError(signal);
    throw new RetryableRequestError("TARGET_ERROR");
  }
}

async function requestJson(state, spec, url, init, signal) {
  const attempts = spec.idempotency.retry === "safe_once" ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestJsonOnce(state, spec, url, init, signal);
    } catch (error) {
      if (signal.aborted) throw signalError(signal);
      if (!(error instanceof RetryableRequestError)) throw error;
      if (attempt + 1 === attempts) throw new Page2WebMCPError(error.code);
    }
  }
  throw new Page2WebMCPError("TARGET_ERROR");
}

function resolveCsrf(spec) {
  const csrf = spec.authentication.csrf;
  if (!csrf) return undefined;
  const element = globalThis.document?.querySelector?.(csrf.resolution.selector);
  let value;
  if (element) {
    value = csrf.resolution.attribute === "value" ? element.value : element.getAttribute?.(csrf.resolution.attribute);
  }
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new Page2WebMCPError("CSRF_UNAVAILABLE");
  }
  return { name: csrf.headerName, value };
}

function builtInConfirmation(spec, signal) {
  assertAllowedOrigin();
  const documentObject = globalThis.document;
  if (!documentObject?.createElement || !documentObject.body?.append) {
    return Promise.reject(new Page2WebMCPError("CONFIRMATION_FAILED"));
  }
  return new Promise((resolve, reject) => {
    const host = documentObject.createElement("div");
    const shadow = host.attachShadow?.({ mode: "closed" });
    if (!shadow) { reject(new Page2WebMCPError("CONFIRMATION_FAILED")); return; }
    const dialog = documentObject.createElement("dialog");
    const title = documentObject.createElement("h2");
    const summary = documentObject.createElement("p");
    const cancel = documentObject.createElement("button");
    const approve = documentObject.createElement("button");
    const titleId = "page2webmcp-confirmation-title";
    const summaryId = "page2webmcp-confirmation-summary";
    title.id = titleId;
    title.textContent = spec.tool.title;
    summary.id = summaryId;
    summary.textContent = spec.effects.summary;
    cancel.type = "button";
    cancel.textContent = "Cancel";
    approve.type = "button";
    approve.textContent = "Confirm";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-describedby", summaryId);
    dialog.append(title, summary, cancel, approve);
    shadow.append(dialog);
    documentObject.body.append(host);
    let settled = false;
    const finish = (approved, error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      try { dialog.close?.(); } catch { /* dialog may already be closed */ }
      host.remove?.();
      if (error) reject(error); else resolve(approved);
    };
    const onAbort = () => finish(false, signalError(signal));
    cancel.addEventListener("click", () => finish(false));
    approve.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => { event.preventDefault?.(); finish(false); });
    signal.addEventListener("abort", onAbort, { once: true });
    try { dialog.showModal(); cancel.focus?.(); } catch { finish(false, new Page2WebMCPError("CONFIRMATION_FAILED")); }
  });
}

async function confirmMutation(state, spec, input, idempotencyKey, signal) {
  assertAllowedOrigin();
  assertExecutionActive(signal);
  const hook = state.bridge?.confirm;
  const approved = typeof hook === "function"
    ? await hook({
        toolName: spec.tool.name,
        title: spec.tool.title,
        summary: spec.effects.summary,
        input,
        idempotencyKey,
        signal,
      })
    : await builtInConfirmation(spec, signal);
  assertExecutionActive(signal);
  if (approved !== true) throw new Page2WebMCPError("CONFIRMATION_DECLINED");
}

async function executeWithinDeadline(state, spec, rawInput, signal) {
  assertAllowedOrigin();
  const input = validateAndProject(spec.schemas.input, rawInput, "INVALID_INPUT");
  const headers = new Headers();
  const bodyValue = Object.create(null);
  for (const [targetField, inputField] of Object.entries(spec.request.body)) bodyValue[targetField] = input[inputField];
  const hasBody = Object.keys(spec.request.body).length > 0;
  if (hasBody) headers.set("content-type", "application/json");
  const csrf = resolveCsrf(spec);
  if (csrf) headers.set(csrf.name, csrf.value);

  let pending;
  let finalRequestStarted = false;
  try {
    if (spec.effects.kind === "mutation") {
      if (spec.idempotency.strategy === "header") {
        pending = await acquirePendingMutation(state, spec, input);
        headers.set(spec.idempotency.headerName, pending.key);
      }
      await confirmMutation(state, spec, input, pending?.key, signal);
    }
    assertAllowedOrigin();
    assertExecutionActive(signal);
    finalRequestStarted = true;
    const raw = await requestJson(state, spec, requestUrl(spec.request, input), {
      method: spec.request.method,
      headers,
      body: hasBody ? JSON.stringify(bodyValue) : undefined,
    }, signal);
    const projected = projectResponse(spec.response.projection, raw);
    const output = validateAndProject(spec.schemas.output, projected, "INVALID_OUTPUT");
    completePendingMutation(state, pending);
    return output;
  } catch (error) {
    if (!finalRequestStarted || error instanceof DefinitiveRequestError) completePendingMutation(state, pending);
    if (signal.aborted) throw signalError(signal);
    throw error;
  }
}

async function executePlan(state, spec, input, callerSignal) {
  try {
    return await runExecution(callerSignal, (signal) => executeWithinDeadline(state, spec, input, signal));
  } catch (error) {
    const safeError = error instanceof Page2WebMCPError ? error : new Page2WebMCPError("INTERNAL_ERROR");
    emitDiagnostic(state, "execution", safeError.code);
    throw safeError;
  }
}

function mergeBridge(state, bridge) {
  if (typeof bridge?.confirm === "function") state.bridge.confirm = bridge.confirm;
  if (typeof bridge?.onDiagnostic === "function") state.bridge.onDiagnostic = bridge.onDiagnostic;
}

export async function registerPage2WebMCPTools(bridge = {}) {
  if (globalThis.window?.location?.origin !== releaseManifest.targetOrigin) {
    lastRegistrationStatus = "origin_mismatch";
    return { supported: false, reason: "ORIGIN_MISMATCH" };
  }
  const modelContext = globalThis.document?.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") {
    lastRegistrationStatus = "unsupported";
    return { supported: false, reason: "WEBMCP_UNAVAILABLE" };
  }
  const registry = releaseRegistry();
  const existing = registry.get(RELEASE_KEY);
  if (existing && !existing.controller.signal.aborted) {
    mergeBridge(existing, bridge);
    try { await existing.promise; } catch {
      emitDiagnostic(existing, "registration", "REGISTRATION_FAILED");
      throw new Page2WebMCPError("REGISTRATION_FAILED");
    }
    lastRegistrationStatus = existing.status;
    return { supported: true, alreadyRegistered: true };
  }

  const controller = new AbortController();
  const state = {
    bridge: {},
    controller,
    pendingMutationKeys: new Map(),
    promise: undefined,
    registeredToolNames: [],
    status: "registering",
  };
  mergeBridge(state, bridge);
  registry.set(RELEASE_KEY, state);
  state.promise = (async () => {
    for (const spec of releaseManifest.plans) {
      if (controller.signal.aborted) return;
      await modelContext.registerTool({
        name: spec.tool.name,
        title: spec.tool.title,
        description: spec.tool.description,
        inputSchema: spec.schemas.input,
        annotations: {
          readOnlyHint: spec.annotations.readOnly,
          destructiveHint: spec.effects.kind === "mutation" && !spec.effects.reversible,
          untrustedContentHint: spec.annotations.untrusted,
        },
        execute: (input, context = {}) => executePlan(state, spec, input, context.signal),
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      state.registeredToolNames.push(spec.tool.name);
    }
    state.status = controller.signal.aborted ? "unregistered" : "registered";
  })();
  lastRegistrationStatus = "registering";
  try { await state.promise; } catch {
    controller.abort();
    state.status = "failed";
    if (registry.get(RELEASE_KEY) === state) registry.delete(RELEASE_KEY);
    lastRegistrationStatus = "failed";
    emitDiagnostic(state, "registration", "REGISTRATION_FAILED");
    throw new Page2WebMCPError("REGISTRATION_FAILED");
  }
  lastRegistrationStatus = state.status;
  if (controller.signal.aborted) return { supported: false, reason: "REGISTRATION_CANCELLED" };
  return { supported: true };
}

export function unregisterPage2WebMCPTools() {
  const registry = releaseRegistry();
  const state = registry.get(RELEASE_KEY);
  if (state) {
    state.controller.abort();
    state.status = "unregistered";
    state.registeredToolNames.length = 0;
    registry.delete(RELEASE_KEY);
  }
  lastRegistrationStatus = "unregistered";
}

export function getPage2WebMCPRegistrationState() {
  const state = releaseRegistry().get(RELEASE_KEY);
  return { status: state?.status || lastRegistrationStatus, registeredToolNames: state ? [...state.registeredToolNames] : [] };
}

function onLifecycleEnd() { unregisterPage2WebMCPTools(); }
globalThis.window?.addEventListener?.("pagehide", onLifecycleEnd, { once: true });
globalThis.window?.addEventListener?.("beforeunload", onLifecycleEnd, { once: true });
export const autoRegistration = registerPage2WebMCPTools().catch(() => ({
  supported: false,
  reason: "REGISTRATION_FAILED",
}));
`;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function compileWebMcpRelease(plans: readonly CapabilityPlan[]): CompiledRelease {
  const canonicalPlans = canonicalizeCapabilityPlans(plans);
  const targetOrigin = canonicalPlans[0]!.targetOrigin;
  const releaseIdentity = JSON.stringify({ version: 3, targetOrigin, plans: canonicalPlans });
  const releaseId = createHash("sha256").update(releaseIdentity).digest("hex");
  const manifest = deepFreeze({ version: 3 as const, releaseId, targetOrigin, plans: canonicalPlans });
  const code = `"use strict";\nconst deepFreeze = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value)) deepFreeze(nested); } return value; };\nexport const releaseManifest = deepFreeze(${JSON.stringify(manifest)});\n${runtimeSource.trimStart()}`;
  const contentDigest = createHash("sha256").update(code).digest();
  const integrityDigest = createHash("sha384").update(code).digest("base64");
  return {
    code,
    contentHash: contentDigest.toString("hex"),
    integrity: `sha384-${integrityDigest}`,
    allowedOrigin: targetOrigin,
    manifest,
  };
}
