import { createHash } from "node:crypto";
import {
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
} from "../../capability-ir/src/plan.ts";

const MAX_RELEASE_BYTES = 64 * 1024;

export type CapabilityReleaseManifest = Readonly<{
  version: 3;
  rendererId: string;
  releaseId: string;
  integrityPolicy: Readonly<{
    enforcement: "trusted-loader-required";
    algorithms: readonly ["sha256", "sha384"];
  }>;
  targetOrigin: string;
  plans: readonly CapabilityPlan[];
}>;

export type CompiledRelease = {
  code: string;
  contentHash: string;
  integrity: string;
  integrityRequired: true;
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
      STALE_PAGE: "The reviewed page structure changed before the action completed.",
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
const MAX_REQUEST_BODY_BYTES = 32768;
const MAX_REQUEST_URL_BYTES = 8192;
const MAX_OBJECT_PROPERTIES = 100;
const EXECUTION_DEADLINE_MS = 15000;
const REGISTRY_SYMBOL = Symbol.for("page2webmcp.release.registry.v1");
const RELEASE_KEY = releaseManifest.releaseId;
const platformFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
const PlatformEvent = globalThis.Event;
const PlatformDOMParser = globalThis.DOMParser;
const PlatformHeaders = globalThis.Headers;
const PlatformURL = globalThis.URL;
const PlatformURLSearchParams = globalThis.URLSearchParams;
const PlatformTextEncoder = globalThis.TextEncoder;
const PlatformTextDecoder = globalThis.TextDecoder;
const platformSetTimeout = globalThis.setTimeout?.bind(globalThis);
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, "value")?.set;
const nativeInputCheckedSetter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, "checked")?.set;
const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, "value")?.set;
const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(globalThis.HTMLSelectElement?.prototype || {}, "value")?.set;
const nativeClick = globalThis.HTMLElement?.prototype?.click;
const sourceNativeConfirmations = new Map();
for (const spec of releaseManifest.plans) {
  const integration = spec.effects.sourceNativeConfirmation;
  const callback = integration ? globalThis[integration.globalName] : undefined;
  if (typeof callback === "function") sourceNativeConfirmations.set(spec.tool.name, callback.bind(globalThis));
}
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
    const shorterThan = (minimum) => {
      let count = 0;
      for (const _codePoint of value) { count += 1; if (count >= minimum) return false; }
      return true;
    };
    const longerThan = (maximum) => {
      let count = 0;
      for (const _codePoint of value) { count += 1; if (count > maximum) return true; }
      return false;
    };
    if (typeof value !== "string"
      || (schema.minLength !== undefined && shorterThan(schema.minLength))
      || (schema.maxLength !== undefined && longerThan(schema.maxLength))
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
  let propertyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    propertyCount += 1;
    if (propertyCount > MAX_OBJECT_PROPERTIES || !Object.prototype.hasOwnProperty.call(schema.properties, key)) fail();
  }
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
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new PlatformTextEncoder().encode(identity));
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
  const url = new PlatformURL(path, releaseManifest.targetOrigin);
  if (url.origin !== releaseManifest.targetOrigin) throw new Page2WebMCPError("ORIGIN_MISMATCH");
  for (const [parameter, field] of Object.entries(request.query)) {
    if (input[field] !== undefined) url.searchParams.set(parameter, input[field]);
  }
  if (new PlatformTextEncoder().encode(url.href).byteLength > MAX_REQUEST_URL_BYTES) throw new Page2WebMCPError("INVALID_INPUT");
  return url;
}

function signalError(signal) {
  return signal.reason instanceof Page2WebMCPError ? signal.reason : new Page2WebMCPError("ABORTED");
}

function assertExecutionActive(signal) {
  if (signal.aborted) throw signalError(signal);
}

async function runExecution(callerSignal, lifecycleSignal, operation) {
  if (callerSignal?.aborted || lifecycleSignal.aborted) throw new Page2WebMCPError("ABORTED");
  const controller = new AbortController();
  const abort = (code) => {
    if (!controller.signal.aborted) controller.abort(new Page2WebMCPError(code));
  };
  const onCallerAbort = () => abort("ABORTED");
  const onLifecycleAbort = () => abort("ABORTED");
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });
  const timer = setTimeout(() => abort("DEADLINE_EXCEEDED"), EXECUTION_DEADLINE_MS);
  const aborted = new Promise((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(signalError(controller.signal)), { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
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
    if (!platformFetch) throw new Page2WebMCPError("TARGET_ERROR");
    const response = await platformFetch(url, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
      signal,
    });
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
      return JSON.parse(new PlatformTextDecoder().decode(body));
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

async function runWithPageGuard(signal, snapshot, operation) {
  if (typeof platformSetTimeout !== "function") throw new Page2WebMCPError("TARGET_ERROR");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signalError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  let settled = false;
  const monitor = (async () => {
    while (!settled) {
      await new Promise((resolve) => platformSetTimeout(resolve, 10));
      if (settled) return undefined;
      assertExecutionActive(signal);
      try {
        assertPageStable(snapshot);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }
    return undefined;
  })();
  try {
    return await Promise.race([operation(controller.signal), monitor]);
  } finally {
    settled = true;
    signal.removeEventListener("abort", onAbort);
  }
}

async function requestDocumentOnce(spec, url, init, signal, snapshot) {
  assertAllowedOrigin();
  assertExecutionActive(signal);
  try {
    return await runWithPageGuard(signal, snapshot, async (guardedSignal) => {
      try {
        if (!platformFetch) throw new Page2WebMCPError("TARGET_ERROR");
        const response = await platformFetch(url, {
          ...init,
          credentials: "same-origin",
          redirect: "error",
          signal: guardedSignal,
        });
        assertExecutionActive(guardedSignal);
        if (!spec.success.statusCodes.includes(response.status)) {
          void response.body?.cancel().catch(() => undefined);
          const code = mappedError(spec, response.status);
          if (retryableStatus(response.status)) throw new RetryableRequestError(code);
          throw new DefinitiveRequestError(code);
        }
        if (response.url) {
          const responseUrl = new PlatformURL(response.url);
          if (responseUrl.origin !== releaseManifest.targetOrigin) {
            void response.body?.cancel().catch(() => undefined);
            throw new DefinitiveRequestError("ORIGIN_MISMATCH");
          }
        }
        const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (!spec.response.contentTypes.includes(contentType)) {
          void response.body?.cancel().catch(() => undefined);
          throw new DefinitiveRequestError("UNSUPPORTED_CONTENT_TYPE");
        }
        const body = await readBoundedBody(response, guardedSignal);
        assertExecutionActive(guardedSignal);
        if (typeof PlatformDOMParser !== "function") throw new DefinitiveRequestError("INVALID_OUTPUT");
        const parsed = new PlatformDOMParser().parseFromString(new PlatformTextDecoder().decode(body), "text/html");
        if (!parsed) throw new DefinitiveRequestError("INVALID_OUTPUT");
        return parsed;
      } catch (error) {
        if (guardedSignal.aborted && guardedSignal.reason instanceof Page2WebMCPError) {
          throw guardedSignal.reason;
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Page2WebMCPError || error instanceof RetryableRequestError) throw error;
    if (signal.aborted) throw signalError(signal);
    throw new RetryableRequestError("TARGET_ERROR");
  }
}

async function requestDocument(spec, url, init, signal, snapshot) {
  const attempts = spec.idempotency.retry === "safe_once" ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestDocumentOnce(spec, url, init, signal, snapshot);
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
  const tagName = csrf.resolution.kind === "meta" ? "meta" : "input";
  const candidates = Array.from(globalThis.document?.getElementsByTagName?.(tagName) || []);
  const matches = candidates.filter((candidate) => {
    if (candidate.getAttribute?.("name") !== csrf.resolution.name) return false;
    if (csrf.resolution.kind === "meta") return true;
    const type = String(candidate.type || candidate.getAttribute?.("type") || "").toLowerCase();
    const autocomplete = String(candidate.getAttribute?.("autocomplete") || "").toLowerCase();
    return type === "hidden" && (autocomplete === "" || autocomplete === "off");
  });
  if (matches.length !== 1) throw new Page2WebMCPError("CSRF_UNAVAILABLE");
  const element = matches[0];
  let value;
  value = csrf.resolution.attribute === "value" ? element.value : element.getAttribute?.(csrf.resolution.attribute);
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new Page2WebMCPError("CSRF_UNAVAILABLE");
  }
  return { name: csrf.headerName, value };
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function semanticElements(root) {
  const descendants = Array.from(root?.getElementsByTagName?.("*") || []);
  if (root?.tagName) descendants.unshift(root);
  if (descendants.length > 2000) throw new Page2WebMCPError("STALE_PAGE");
  return descendants;
}

function elementTag(element) {
  return String(element?.tagName || "").toLowerCase();
}

function implicitRole(element) {
  const tag = elementTag(element);
  const type = String(element?.type || element?.getAttribute?.("type") || "").toLowerCase();
  if (tag === "button") return "button";
  if (tag === "form") return "form";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input" && ["checkbox", "radio"].includes(type)) return type === "checkbox" ? "checkbox" : undefined;
  if (tag === "input" && !["button", "submit", "reset", "hidden", "file", "image"].includes(type)) return "textbox";
  if (["h1", "h2", "h3"].includes(tag)) return "heading";
  if (tag === "a" && element?.getAttribute?.("href")) return "link";
  return undefined;
}

function labelsFor(root, element) {
  const id = element?.getAttribute?.("id");
  const labels = semanticElements(root).filter((candidate) => {
    if (elementTag(candidate) !== "label") return false;
    if (id && candidate.getAttribute?.("for") === id) return true;
    return candidate.contains?.(element) === true;
  });
  return labels.map((label) => normalizedText(label.textContent)).filter(Boolean);
}

function accessibleName(root, element) {
  const ariaLabel = element?.getAttribute?.("aria-label");
  if (ariaLabel) return normalizedText(ariaLabel);
  const labels = labelsFor(root, element);
  if (labels.length === 1) return labels[0];
  const tag = elementTag(element);
  if (["button", "a", "h1", "h2", "h3", "output"].includes(tag)) return normalizedText(element.textContent);
  return "";
}

function semanticMatches(root, locator) {
  const matches = semanticElements(root).filter((element) => {
    if (locator.kind === "role") {
      if (locator.element && elementTag(element) !== locator.element) return false;
      const role = element.getAttribute?.("role") || implicitRole(element);
      return role === locator.role && accessibleName(root, element) === locator.accessibleName;
    }
    if (elementTag(element) !== locator.element) return false;
    if (locator.kind === "name") return element.getAttribute?.("name") === locator.name;
    if (locator.kind === "stable_attribute") return element.getAttribute?.(locator.name) === locator.value;
    const labels = labelsFor(root, element);
    return labels.length === 1 && labels[0] === locator.label;
  });
  if (matches.length > 1) throw new Page2WebMCPError("STALE_PAGE");
  return matches;
}

function resolveSemantic(root, locator) {
  const matches = semanticMatches(root, locator);
  if (matches.length !== 1) throw new Page2WebMCPError("STALE_PAGE");
  return matches[0];
}

function pageSnapshot() {
  return { document: globalThis.document, href: String(globalThis.window?.location?.href || "") };
}

function assertPageStable(snapshot) {
  assertAllowedOrigin();
  if (globalThis.document !== snapshot.document
    || String(globalThis.window?.location?.href || "") !== snapshot.href) {
    throw new Page2WebMCPError("STALE_PAGE");
  }
}

function assertSameSemantic(root, locator, expected) {
  const resolved = resolveSemantic(root, locator);
  if (resolved !== expected || expected?.isConnected === false) throw new Page2WebMCPError("STALE_PAGE");
}

function sensitiveControl(element) {
  const tag = elementTag(element);
  const type = String(element?.type || element?.getAttribute?.("type") || "").toLowerCase();
  const autocomplete = String(element?.getAttribute?.("autocomplete") || "").toLowerCase();
  return tag === "input" && ["password", "file"].includes(type)
    || /(?:current-password|new-password|one-time-code|cc-|webauthn)/.test(autocomplete);
}

function nativeSetControl(element, value) {
  if (sensitiveControl(element) || element?.disabled === true) throw new Page2WebMCPError("STALE_PAGE");
  const tag = elementTag(element);
  const type = String(element?.type || element?.getAttribute?.("type") || "").toLowerCase();
  let setter;
  let nextValue = value;
  if (tag === "input" && type === "checkbox") {
    if (typeof value !== "boolean") throw new Page2WebMCPError("INVALID_INPUT");
    setter = nativeInputCheckedSetter;
  } else {
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Page2WebMCPError("INVALID_INPUT");
    nextValue = String(value);
    setter = tag === "input" ? nativeInputValueSetter
      : tag === "textarea" ? nativeTextAreaValueSetter
        : tag === "select" ? nativeSelectValueSetter : undefined;
  }
  if (typeof setter !== "function" || typeof PlatformEvent !== "function" || typeof element?.dispatchEvent !== "function") {
    throw new Page2WebMCPError("STALE_PAGE");
  }
  setter.call(element, nextValue);
  element.dispatchEvent(new PlatformEvent("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new PlatformEvent("change", { bubbles: true }));
  if (tag === "input" && type === "checkbox") {
    if (element.checked !== nextValue) throw new Page2WebMCPError("STALE_PAGE");
  } else if (element.value !== nextValue) {
    throw new Page2WebMCPError("STALE_PAGE");
  }
}

function assertSafeClickTarget(element, locator) {
  const tag = elementTag(element);
  if (tag !== locator.element || !["button", "input"].includes(tag) || element?.disabled === true) {
    throw new Page2WebMCPError("STALE_PAGE");
  }
  const defaultType = tag === "button" ? "submit" : "text";
  const type = String(element.type || element.getAttribute?.("type") || defaultType).toLowerCase();
  if (type !== "button") throw new Page2WebMCPError("STALE_PAGE");
  if (element.getAttribute?.("formaction") || element.getAttribute?.("formtarget")) {
    throw new Page2WebMCPError("STALE_PAGE");
  }
}

function readSemanticValue(root, projection) {
  const element = resolveSemantic(root, projection.locator);
  if (projection.read === "checked") {
    if (elementTag(element) !== "input" || typeof element.checked !== "boolean") throw new Page2WebMCPError("STALE_PAGE");
    return element.checked;
  }
  if (projection.read === "value") {
    if (sensitiveControl(element) || typeof element.value !== "string") throw new Page2WebMCPError("STALE_PAGE");
    return element.value;
  }
  return normalizedText(element.textContent);
}

function semanticConditionState(root, condition) {
  const matches = semanticMatches(root, condition.locator);
  if (matches.length === 0) return false;
  return readSemanticValue(root, condition) === condition.equals;
}

function projectSemanticResponse(root, projection) {
  const projected = Object.create(null);
  for (const [field, source] of Object.entries(projection.fields)) projected[field] = readSemanticValue(root, source);
  return projected;
}

async function waitForSemanticCondition(root, scopeLocator, condition, conditionTarget, snapshot, signal) {
  while (true) {
    assertExecutionActive(signal);
    assertPageStable(snapshot);
    assertSameSemantic(snapshot.document, scopeLocator, root);
    assertSameSemantic(root, condition.locator, conditionTarget);
    if (readSemanticValue(root, condition) === condition.equals) return;
    if (typeof platformSetTimeout !== "function") throw new Page2WebMCPError("STALE_PAGE");
    await new Promise((resolve) => platformSetTimeout(resolve, 10));
  }
}

function formControls(form) {
  const controls = semanticElements(form).filter((element) => ["input", "textarea", "select"].includes(elementTag(element)));
  if (controls.length > 200) throw new Page2WebMCPError("STALE_PAGE");
  return controls;
}

function assertExactForm(state, spec, input) {
  const snapshot = state.page;
  assertPageStable(snapshot);
  const form = resolveSemantic(snapshot.document, spec.request.form);
  const actionAttribute = form.getAttribute?.("action") || snapshot.href;
  let actualAction;
  try { actualAction = new PlatformURL(actionAttribute, snapshot.document?.baseURI || snapshot.href); } catch {
    throw new Page2WebMCPError("STALE_PAGE");
  }
  if (actualAction.origin !== releaseManifest.targetOrigin) throw new Page2WebMCPError("ORIGIN_MISMATCH");
  if (actualAction.href !== spec.request.action) throw new Page2WebMCPError("STALE_PAGE");
  const actualMethod = String(form.getAttribute?.("method") || "get").toUpperCase();
  if (actualMethod !== spec.request.method) throw new Page2WebMCPError("STALE_PAGE");
  const controls = formControls(form);
  const allowedNames = new Set(Object.keys(spec.request.controls));
  if (spec.idempotency.strategy === "form_field") allowedNames.add(spec.idempotency.fieldName);
  if (spec.authentication.csrf?.resolution?.kind === "hidden_input") allowedNames.add(spec.authentication.csrf.resolution.name);
  for (const control of controls) {
    const name = control.getAttribute?.("name");
    if (name && !allowedNames.has(name)) throw new Page2WebMCPError("STALE_PAGE");
  }
  const mapped = new Map();
  for (const [name, mapping] of Object.entries(spec.request.controls)) {
    const matches = controls.filter((control) => control.getAttribute?.("name") === name);
    const inputPresent = Object.prototype.hasOwnProperty.call(input, mapping.inputField);
    if (matches.length > 1 || (!mapping.optional && matches.length !== 1) || (inputPresent && matches.length !== 1)) {
      throw new Page2WebMCPError("STALE_PAGE");
    }
    if (matches.length === 1) mapped.set(name, { control: matches[0], mapping, inputPresent });
  }
  return { form, controls, mapped, action: actualAction, snapshot };
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
  const hook = sourceNativeConfirmations.get(spec.tool.name);
  let approved;
  if (typeof hook === "function") {
    try {
      approved = await hook(Object.freeze({
        toolName: spec.tool.name,
        title: spec.tool.title,
        summary: spec.effects.summary,
        input,
        idempotencyKey,
        signal,
      }));
    } catch {
      throw new Page2WebMCPError("CONFIRMATION_FAILED");
    }
  } else {
    approved = await builtInConfirmation(spec, signal);
  }
  assertExecutionActive(signal);
  if (approved !== true) throw new Page2WebMCPError("CONFIRMATION_DECLINED");
}

function ephemeralIdempotencyKey() {
  const key = globalThis.crypto?.randomUUID?.();
  if (!validIdempotencyKey(key)) throw new Page2WebMCPError("IDEMPOTENCY_UNAVAILABLE");
  return key;
}

async function executeJsonWithinDeadline(state, spec, input, signal) {
  const headers = new PlatformHeaders();
  const bodyValue = Object.create(null);
  for (const [targetField, inputField] of Object.entries(spec.request.body)) {
    if (input[inputField] !== undefined) bodyValue[targetField] = input[inputField];
  }
  for (const [headerName, inputField] of Object.entries(spec.request.headers ?? {})) {
    if (input[inputField] !== undefined) headers.set(headerName, String(input[inputField]));
  }
  const hasBody = Object.keys(bodyValue).length > 0;
  const bodyEncoding = spec.request.bodyEncoding ?? "json";
  if (hasBody) headers.set("content-type", bodyEncoding === "form_urlencoded"
    ? "application/x-www-form-urlencoded;charset=UTF-8"
    : "application/json");
  const csrf = resolveCsrf(spec);
  if (csrf) headers.set(csrf.name, csrf.value);

  let pending;
  let idempotencyKey;
  let finalRequestStarted = false;
  try {
    if (spec.effects.kind === "mutation") {
      if (spec.idempotency.strategy === "header") {
        if (spec.idempotency.verified && spec.idempotency.retry === "safe_once") {
          pending = await acquirePendingMutation(state, spec, input);
          idempotencyKey = pending.key;
        } else {
          idempotencyKey = ephemeralIdempotencyKey();
        }
        headers.set(spec.idempotency.headerName, idempotencyKey);
      }
      await confirmMutation(state, spec, input, idempotencyKey, signal);
    }
    assertAllowedOrigin();
    assertExecutionActive(signal);
    finalRequestStarted = true;
    const body = hasBody
      ? bodyEncoding === "form_urlencoded"
        ? new PlatformURLSearchParams(Object.entries(bodyValue).map(([key, value]) => [key, String(value)])).toString()
        : JSON.stringify(bodyValue)
      : undefined;
    if (body !== undefined && new PlatformTextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new Page2WebMCPError("INVALID_INPUT");
    }
    const raw = await requestJson(state, spec, requestUrl(spec.request, input), {
      method: spec.request.method,
      headers,
      body,
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

async function executeFormWithinDeadline(state, spec, input, signal) {
  const page = pageSnapshot();
  const formState = { page };
  const initial = assertExactForm(formState, spec, input);
  const headers = new PlatformHeaders();
  const csrf = resolveCsrf(spec);
  if (csrf) headers.set(csrf.name, csrf.value);
  let pending;
  let idempotencyKey;
  let finalRequestStarted = false;
  try {
    if (spec.effects.kind === "mutation") {
      if (spec.idempotency.strategy !== "none") {
        if (spec.idempotency.verified && spec.idempotency.retry === "safe_once") {
          pending = await acquirePendingMutation(state, spec, input);
          idempotencyKey = pending.key;
        } else {
          idempotencyKey = ephemeralIdempotencyKey();
        }
        if (spec.idempotency.strategy === "header") headers.set(spec.idempotency.headerName, idempotencyKey);
      }
      await confirmMutation(state, spec, input, idempotencyKey, signal);
    }
    assertExecutionActive(signal);
    const current = assertExactForm(formState, spec, input);
    if (current.form !== initial.form) throw new Page2WebMCPError("STALE_PAGE");
    const parameters = new PlatformURLSearchParams();
    for (const [name, entry] of current.mapped) {
      if (!entry.inputPresent) continue;
      const value = input[entry.mapping.inputField];
      nativeSetControl(entry.control, value);
      assertPageStable(page);
      assertSameSemantic(current.form, entry.mapping.locator || {
        kind: "name", element: elementTag(entry.control), name,
      }, entry.control);
      const type = String(entry.control.type || entry.control.getAttribute?.("type") || "").toLowerCase();
      if (elementTag(entry.control) !== "input" || type !== "checkbox" || value === true) {
        parameters.set(name, type === "checkbox" ? entry.control.getAttribute?.("value") || "on" : String(value));
      }
    }
    if (spec.idempotency.strategy === "form_field") {
      const matches = current.controls.filter((control) => control.getAttribute?.("name") === spec.idempotency.fieldName);
      if (matches.length !== 1 || elementTag(matches[0]) !== "input"
        || String(matches[0].type || matches[0].getAttribute?.("type") || "").toLowerCase() !== "hidden") {
        throw new Page2WebMCPError("STALE_PAGE");
      }
      nativeSetControl(matches[0], idempotencyKey);
      parameters.set(spec.idempotency.fieldName, idempotencyKey);
    }
    assertSameSemantic(page.document, spec.request.form, current.form);
    assertPageStable(page);
    const url = new PlatformURL(spec.request.action);
    let body;
    if (spec.request.method === "GET") {
      for (const [name, value] of parameters) url.searchParams.set(name, value);
      if (new PlatformTextEncoder().encode(url.href).byteLength > MAX_REQUEST_URL_BYTES) throw new Page2WebMCPError("INVALID_INPUT");
    } else {
      body = parameters.toString();
      if (new PlatformTextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) throw new Page2WebMCPError("INVALID_INPUT");
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
    assertAllowedOrigin();
    finalRequestStarted = true;
    const documentResult = await requestDocument(spec, url, {
      method: spec.request.method,
      headers,
      body,
    }, signal, page);
    assertPageStable(page);
    if (!semanticConditionState(documentResult, spec.success.condition)) throw new Page2WebMCPError("STALE_PAGE");
    const projected = projectSemanticResponse(documentResult, spec.response.projection);
    const output = validateAndProject(spec.schemas.output, projected, "INVALID_OUTPUT");
    completePendingMutation(state, pending);
    return output;
  } catch (error) {
    if (!finalRequestStarted || error instanceof DefinitiveRequestError) completePendingMutation(state, pending);
    if (signal.aborted) throw signalError(signal);
    throw error;
  }
}

async function executeDomWithinDeadline(state, spec, input, signal) {
  const snapshot = pageSnapshot();
  assertPageStable(snapshot);
  const scope = resolveSemantic(snapshot.document, spec.request.scope);
  const inputs = new Map();
  for (const [field, mapping] of Object.entries(spec.request.inputs)) {
    const present = Object.prototype.hasOwnProperty.call(input, field);
    const matches = semanticMatches(scope, mapping.locator);
    if (matches.length !== 1 && (!mapping.optional || present)) throw new Page2WebMCPError("STALE_PAGE");
    if (matches.length === 1) inputs.set(field, { element: matches[0], mapping, present });
  }
  const actionTarget = spec.request.action.kind === "click"
    ? resolveSemantic(scope, spec.request.action.target) : undefined;
  const conditionTarget = spec.request.action.kind === "click"
    ? resolveSemantic(scope, spec.success.condition.locator) : undefined;
  if (spec.effects.kind === "mutation") await confirmMutation(state, spec, input, undefined, signal);
  assertPageStable(snapshot);
  assertSameSemantic(snapshot.document, spec.request.scope, scope);
  for (const [field, entry] of inputs) {
    if (!entry.present) continue;
    assertSameSemantic(scope, entry.mapping.locator, entry.element);
    nativeSetControl(entry.element, input[field]);
    assertPageStable(snapshot);
    assertSameSemantic(snapshot.document, spec.request.scope, scope);
    assertSameSemantic(scope, entry.mapping.locator, entry.element);
  }
  if (actionTarget) {
    assertSameSemantic(scope, spec.request.action.target, actionTarget);
    assertSameSemantic(scope, spec.success.condition.locator, conditionTarget);
    assertSafeClickTarget(actionTarget, spec.request.action.target);
    if (typeof nativeClick !== "function") throw new Page2WebMCPError("STALE_PAGE");
    nativeClick.call(actionTarget);
  }
  if (spec.request.action.kind === "read") {
    if (!semanticConditionState(scope, spec.success.condition)) throw new Page2WebMCPError("STALE_PAGE");
  } else {
    await waitForSemanticCondition(
      scope,
      spec.request.scope,
      spec.success.condition,
      conditionTarget,
      snapshot,
      signal,
    );
  }
  assertSameSemantic(snapshot.document, spec.request.scope, scope);
  const projected = projectSemanticResponse(scope, spec.response.projection);
  return validateAndProject(spec.schemas.output, projected, "INVALID_OUTPUT");
}

async function executeWithinDeadline(state, spec, rawInput, signal) {
  assertAllowedOrigin();
  const input = deepFreeze(validateAndProject(spec.schemas.input, rawInput, "INVALID_INPUT"));
  if (spec.request.adapter === "json_api") return executeJsonWithinDeadline(state, spec, input, signal);
  if (spec.request.adapter === "html_form") return executeFormWithinDeadline(state, spec, input, signal);
  return executeDomWithinDeadline(state, spec, input, signal);
}

async function executePlan(state, spec, input, callerSignal) {
  try {
    return await runExecution(callerSignal, state.controller.signal,
      (signal) => executeWithinDeadline(state, spec, input, signal));
  } catch (error) {
    const safeError = error instanceof Page2WebMCPError ? error : new Page2WebMCPError("INTERNAL_ERROR");
    emitDiagnostic(state, "execution", safeError.code);
    throw safeError;
  }
}

function mergeBridge(state, bridge) {
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
    if (existing.controller.signal.aborted || existing.status !== "registered") {
      lastRegistrationStatus = "unregistered";
      return { supported: false, reason: "REGISTRATION_CANCELLED" };
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

function renderReleaseModule(manifestJson: string): string {
  return `"use strict";\nconst deepFreeze = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const nested of Object.values(value)) deepFreeze(nested); } return value; };\nexport const releaseManifest = deepFreeze(${manifestJson});\n${runtimeSource.trimStart()}`;
}

const RENDERER_ID = createHash("sha256")
  .update(renderReleaseModule("__PAGE2WEBMCP_CANONICAL_MANIFEST__"))
  .digest("hex");

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
  const releaseIdentity = JSON.stringify({ version: 3, rendererId: RENDERER_ID, targetOrigin, plans: canonicalPlans });
  const releaseId = createHash("sha256").update(releaseIdentity).digest("hex");
  const manifest = deepFreeze({
    version: 3 as const,
    rendererId: RENDERER_ID,
    releaseId,
    integrityPolicy: {
      enforcement: "trusted-loader-required" as const,
      algorithms: ["sha256", "sha384"] as const,
    },
    targetOrigin,
    plans: canonicalPlans,
  });
  const code = renderReleaseModule(JSON.stringify(manifest));
  if (Buffer.byteLength(code) > MAX_RELEASE_BYTES) {
    throw new Error("compiled release exceeds the 64 KiB artifact boundary");
  }
  const contentDigest = createHash("sha256").update(code).digest();
  const integrityDigest = createHash("sha384").update(code).digest("base64");
  return {
    code,
    contentHash: contentDigest.toString("hex"),
    integrity: `sha384-${integrityDigest}`,
    integrityRequired: true,
    allowedOrigin: targetOrigin,
    manifest,
  };
}

/**
 * Verification boundary for the trusted installer/loader. Generated modules cannot
 * securely hash bytes that have already begun evaluating, so callers must invoke
 * this check before evaluation and reject a false result.
 */
export function verifyWebMcpReleaseBytes(
  code: string | Uint8Array,
  metadata: Pick<CompiledRelease, "contentHash" | "integrity" | "integrityRequired">,
): boolean {
  if (metadata.integrityRequired !== true) return false;
  const bytes = typeof code === "string" ? Buffer.from(code) : code;
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
  return contentHash === metadata.contentHash && integrity === metadata.integrity;
}
