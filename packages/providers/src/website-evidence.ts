import { createHash } from "node:crypto";
import {
  CapabilityPlanSchema,
  canonicalizeCapabilityPlans,
  type CapabilityPlan,
  type JsonSchema,
  type SemanticCondition,
  type SemanticLocator,
  type SemanticValue,
} from "../../capability-ir/src/plan.ts";
import { sanitizeEvidence } from "../../security/src/security.ts";

const MAX_EVENTS = 100;
const MAX_FIELDS = 100;
const MAX_CONTENT_BYTES = 64 * 1_024;
const MAX_TEXT = 2_048;
const identifierPattern = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const wireNamePattern = /^[A-Za-z][A-Za-z0-9_.~-]{0,127}$/;

type ObservedField = Readonly<{
  field: string;
  required?: boolean;
  maxLength: number;
}>;

export type WebsiteNetworkObservation = Readonly<{
  logicalAction: string;
  title: string;
  description: string;
  method: "GET" | "POST";
  pathTemplate: string;
  status: number;
  contentType: string;
  authentication: "public" | "same_origin_cookie";
  effect: "read" | "mutation";
  riskTier?: "R1" | "R2" | "R3";
  inputs: readonly (ObservedField & Readonly<{ wireName: string; location: "path" | "query" }>)[];
  outputs: readonly (ObservedField & Readonly<{ path: string }>)[];
}>;

export type WebsiteFormObservation = Readonly<{
  logicalAction: string;
  title: string;
  description: string;
  action: string;
  method: "GET" | "POST";
  authentication: "public" | "same_origin_cookie";
  effect: "read" | "mutation";
  riskTier?: "R1" | "R2" | "R3";
  form: SemanticLocator;
  controls: readonly (ObservedField & Readonly<{ name: string }>)[];
  outputs: readonly (ObservedField & Readonly<{ value: SemanticValue }>)[];
  success: SemanticCondition;
  statusCodes: readonly number[];
  redactedQueryParameters?: readonly string[];
}>;

export type WebsiteDomObservation = Readonly<{
  logicalAction: string;
  title: string;
  description: string;
  authentication: "public" | "same_origin_cookie";
  effect: "read" | "mutation";
  riskTier?: "R1" | "R2" | "R3";
  scope: SemanticLocator;
  inputs: readonly (ObservedField & Readonly<{ locator?: SemanticLocator }>)[];
  outputs: readonly (ObservedField & Readonly<{ value: SemanticValue }>)[];
  success: SemanticCondition;
}>;

export type WebsiteObservationInput = Readonly<{
  navigations: readonly Readonly<{ sequence: number; url: string; origin: string }>[];
  semanticTargets: readonly Readonly<{ url: string; locator: SemanticLocator; matches: number }>[];
  network: readonly WebsiteNetworkObservation[];
  forms: readonly WebsiteFormObservation[];
  dom: readonly WebsiteDomObservation[];
  authSignals: readonly Readonly<{ origin: string; observedAt: string; signals: readonly string[] }>[];
  blockedMutations: readonly Readonly<{ method: string; path: string; reason: string }>[];
  stateTransitions: readonly Readonly<{ sequence: number; from: string; to: string }>[];
}>;

export type WebsiteEvidence = Readonly<{
  organizationId: string;
  projectId: string;
  analysisRunId: string;
  source: "runtime";
  content: string;
  reference: string;
}>;

export type WebsiteEvidenceStore = Readonly<{
  put(record: WebsiteEvidence): Promise<Readonly<{ reference: string }>>;
}>;

export type WebsiteProposalDiagnostic = Readonly<{
  code: string;
  operationKey: string;
  reason?: string;
}>;

type Snapshot = Readonly<{
  version: 1;
  ownership: Readonly<{ organizationId: string; projectId: string; runId: string }>;
  targetOrigin: string;
  provider: Readonly<{ apiVersion: "v4"; model: "browser-use-2.0"; policyDigest: string }>;
  observations: Readonly<{
    navigations: readonly Readonly<{
      sequence: number;
      url: string;
      origin: string;
      redactedQueryParameters?: readonly string[];
    }>[];
    semanticTargets: readonly Readonly<{
      url: string;
      locator: SemanticLocator;
      matches: number;
      redactedQueryParameters?: readonly string[];
    }>[];
    network: readonly WebsiteNetworkObservation[];
    forms: readonly WebsiteFormObservation[];
    dom: readonly WebsiteDomObservation[];
    authSignals: readonly Readonly<{ origin: string; observedAt: string; signals: readonly string[] }>[];
    blockedMutations: readonly Readonly<{ method: string; path: string; reason: string }>[];
    stateTransitions: readonly Readonly<{ sequence: number; from: string; to: string }>[];
  }>;
}>;

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactOrigin(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("WEBSITE_EVIDENCE_ORIGIN_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.href !== `${value}/` || parsed.username || parsed.password) {
    throw new Error("WEBSITE_EVIDENCE_ORIGIN_INVALID");
  }
  return parsed;
}

function boundedText(value: unknown, pattern?: RegExp, maximum = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || pattern && !pattern.test(value)) {
    throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
  }
  return value;
}

function boundedArray<T>(value: readonly T[], maximum = MAX_EVENTS): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
  return value;
}

const semanticElements = new Set([
  "form", "input", "textarea", "select", "button", "output", "div", "span", "p", "section", "article", "h1", "h2", "h3", "a",
]);
const semanticRoles = new Set(["button", "form", "textbox", "checkbox", "combobox", "status", "alert", "region", "heading", "link"]);

function normalizeLocator(locator: SemanticLocator): SemanticLocator {
  if (!locator || typeof locator !== "object") throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
  if (locator.kind === "role") {
    if (!semanticRoles.has(locator.role)) throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
    return { kind: "role", role: locator.role, accessibleName: boundedText(locator.accessibleName, undefined, 200) };
  }
  if (locator.kind === "label") {
    if (!["input", "textarea", "select"].includes(locator.element)) throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
    return { kind: "label", element: locator.element, label: boundedText(locator.label, undefined, 200) };
  }
  if (locator.kind === "name") {
    if (!semanticElements.has(locator.element)) throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
    return { kind: "name", element: locator.element, name: boundedText(locator.name, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/, 128) };
  }
  if (locator.kind === "stable_attribute") {
    if (locator.reviewed !== true || !semanticElements.has(locator.element)) throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
    return {
      kind: "stable_attribute",
      reviewed: true,
      element: locator.element,
      name: boundedText(locator.name, /^data-[a-z][a-z0-9-]{0,63}$/, 64),
      value: boundedText(locator.value, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, 128),
    };
  }
  throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
}

function normalizeSemanticValue(value: SemanticValue): SemanticValue {
  if (!value || !["text", "value", "checked"].includes(value.read)) throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
  return { locator: normalizeLocator(value.locator), read: value.read };
}

function normalizeCondition(condition: SemanticCondition): SemanticCondition {
  const value = normalizeSemanticValue(condition);
  if (typeof condition.equals !== "boolean" && (typeof condition.equals !== "string" || condition.equals.length > 4_096)) {
    throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
  }
  return { ...value, equals: condition.equals };
}

const authSensitiveQueryParameters = new Set([
  "accesstoken", "apikey", "assertion", "authorization", "clientsecret", "code", "credential", "csrf", "idtoken",
  "next", "nonce", "oauthverifier", "otp", "passcode", "password", "redirect", "redirecturi", "refresh_token",
  "refreshtoken", "returnto", "returnurl", "samlrequest", "samlresponse", "secret", "session", "sessionstate", "state",
  "ticket", "token", "xsrf",
]);

function normalizedQueryName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizedEvidenceUrl(
  value: string,
  targetOrigin: string,
): Readonly<{ url: string; redactedQueryParameters: readonly string[] }> {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("WEBSITE_EVIDENCE_ORIGIN_MISMATCH"); }
  if (parsed.origin !== targetOrigin || parsed.username || parsed.password) throw new Error("WEBSITE_EVIDENCE_ORIGIN_MISMATCH");
  if (parsed.hash) throw new Error("WEBSITE_EVIDENCE_URL_FRAGMENT_BLOCKED");
  const retained: Array<readonly [string, string]> = [];
  const redacted: string[] = [];
  for (const [name, queryValue] of parsed.searchParams) {
    if (authSensitiveQueryParameters.has(normalizedQueryName(name))) redacted.push(name);
    else retained.push([name, queryValue]);
  }
  retained.sort(([leftName, leftValue], [rightName, rightValue]) => compareCodePoints(leftName, rightName)
    || compareCodePoints(leftValue, rightValue));
  parsed.search = "";
  for (const [name, queryValue] of retained) parsed.searchParams.append(name, queryValue);
  return {
    url: parsed.href,
    redactedQueryParameters: [...new Set(redacted)].sort(compareCodePoints),
  };
}

function normalizedObservedField(field: ObservedField): ObservedField {
  return {
    field: boundedText(field.field, identifierPattern, 128),
    ...(field.required === undefined ? {} : { required: Boolean(field.required) }),
    maxLength: Number.isInteger(field.maxLength) && field.maxLength >= 1 && field.maxLength <= 4_096
      ? field.maxLength
      : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
  };
}

function normalizedCommon<T extends WebsiteNetworkObservation | WebsiteFormObservation | WebsiteDomObservation>(candidate: T) {
  if (candidate.riskTier !== undefined && !["R1", "R2", "R3"].includes(candidate.riskTier)) {
    throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
  }
  return {
    logicalAction: boundedText(candidate.logicalAction, identifierPattern, 128),
    title: boundedText(candidate.title, undefined, 120),
    description: boundedText(candidate.description, undefined, 600),
    authentication: candidate.authentication === "public" || candidate.authentication === "same_origin_cookie"
      ? candidate.authentication
      : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
    effect: candidate.effect === "read" || candidate.effect === "mutation"
      ? candidate.effect
      : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
    ...(candidate.riskTier ? { riskTier: candidate.riskTier } : {}),
  } as const;
}

function normalizeObservations(input: WebsiteObservationInput, targetOrigin: string): Snapshot["observations"] {
  const navigations = boundedArray(input.navigations).map((item) => {
    const normalized = normalizedEvidenceUrl(item.url, targetOrigin);
    if (item.origin !== targetOrigin || !Number.isInteger(item.sequence) || item.sequence < 0) {
      throw new Error("WEBSITE_EVIDENCE_ORIGIN_MISMATCH");
    }
    return {
      sequence: item.sequence,
      url: normalized.url,
      origin: targetOrigin,
      ...(normalized.redactedQueryParameters.length > 0
        ? { redactedQueryParameters: normalized.redactedQueryParameters }
        : {}),
    };
  });
  const semanticTargets = boundedArray(input.semanticTargets).map((item) => {
    const normalized = normalizedEvidenceUrl(item.url, targetOrigin);
    return {
      url: normalized.url,
      locator: normalizeLocator(item.locator),
      matches: Number.isInteger(item.matches) && item.matches >= 0 && item.matches <= 100
        ? item.matches
        : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
      ...(normalized.redactedQueryParameters.length > 0
        ? { redactedQueryParameters: normalized.redactedQueryParameters }
        : {}),
    };
  });
  const network = boundedArray(input.network).map((item): WebsiteNetworkObservation => ({
    ...normalizedCommon(item),
    method: item.method === "GET" || item.method === "POST" ? item.method : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
    pathTemplate: boundedText(item.pathTemplate, /^\/(?!\/)[^?#\\\0]{0,2047}$/),
    status: Number.isInteger(item.status) && item.status >= 100 && item.status <= 599
      ? item.status
      : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
    contentType: boundedText(item.contentType, /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/, 128),
    inputs: boundedArray(item.inputs, MAX_FIELDS).map((field) => ({
      ...normalizedObservedField(field),
      wireName: boundedText(field.wireName, wireNamePattern, 128),
      location: field.location === "path" || field.location === "query"
        ? field.location
        : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
    })),
    outputs: boundedArray(item.outputs, MAX_FIELDS).map((field) => ({
      ...normalizedObservedField(field),
      path: boundedText(field.path, /^[A-Za-z][A-Za-z0-9_.~-]{0,127}$/, 128),
    })),
  }));
  const forms = boundedArray(input.forms).map((item): WebsiteFormObservation => {
    const normalized = normalizedEvidenceUrl(item.action, targetOrigin);
    return {
      ...normalizedCommon(item),
      action: normalized.url,
      method: item.method === "GET" || item.method === "POST" ? item.method : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
      form: normalizeLocator(item.form),
      controls: boundedArray(item.controls, MAX_FIELDS).map((field) => ({
        ...normalizedObservedField(field),
        name: boundedText(field.name, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/, 128),
      })),
      outputs: boundedArray(item.outputs, MAX_FIELDS).map((field) => ({ ...normalizedObservedField(field), value: normalizeSemanticValue(field.value) })),
      success: normalizeCondition(item.success),
      statusCodes: boundedArray(item.statusCodes, 20).map((status) => Number.isInteger(status) && status >= 200 && status <= 299
        ? status
        : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })()),
      ...(normalized.redactedQueryParameters.length > 0
        ? { redactedQueryParameters: normalized.redactedQueryParameters }
        : {}),
    };
  });
  const dom = boundedArray(input.dom).map((item): WebsiteDomObservation => ({
    ...normalizedCommon(item),
    scope: normalizeLocator(item.scope),
    inputs: boundedArray(item.inputs, MAX_FIELDS).map((field) => ({
      ...normalizedObservedField(field),
      ...(field.locator ? { locator: normalizeLocator(field.locator) } : {}),
    })),
    outputs: boundedArray(item.outputs, MAX_FIELDS).map((field) => ({ ...normalizedObservedField(field), value: normalizeSemanticValue(field.value) })),
    success: normalizeCondition(item.success),
  }));
  const authSignals = boundedArray(input.authSignals).map((item) => {
    if (item.origin !== targetOrigin || !Number.isFinite(Date.parse(item.observedAt))) throw new Error("WEBSITE_EVIDENCE_ORIGIN_MISMATCH");
    return {
      origin: targetOrigin,
      observedAt: item.observedAt,
      signals: boundedArray(item.signals, 10).map((signal) => boundedText(signal, /^[a-z][a-z0-9_]{0,63}$/, 64)).sort(compareCodePoints),
    };
  });
  const blockedMutations = boundedArray(input.blockedMutations).map((item) => ({
    method: boundedText(item.method, /^(?:POST|PUT|PATCH|DELETE)$/),
    path: boundedText(item.path, /^\/(?!\/)[^?#\\\0]{0,2047}$/),
    reason: boundedText(item.reason, /^[A-Z][A-Z0-9_]{0,63}$/, 64),
  }));
  const stateTransitions = boundedArray(input.stateTransitions).map((item) => ({
    sequence: Number.isInteger(item.sequence) && item.sequence >= 0
      ? item.sequence
      : (() => { throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED"); })(),
    from: boundedText(item.from, /^[a-z][a-z0-9_]{0,63}$/, 64),
    to: boundedText(item.to, /^[a-z][a-z0-9_]{0,63}$/, 64),
  }));
  return { navigations, semanticTargets, network, forms, dom, authSignals, blockedMutations, stateTransitions };
}

export async function captureWebsiteEvidence(
  input: Readonly<{
    organizationId: string;
    projectId: string;
    runId: string;
    targetOrigin: string;
    provider: Readonly<{ apiVersion: "v4"; model: "browser-use-2.0"; policyDigest: string }>;
    observations: WebsiteObservationInput;
  }>,
  store: WebsiteEvidenceStore,
): Promise<WebsiteEvidence> {
  if (![input.organizationId, input.projectId, input.runId].every((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))) {
    throw new Error("WEBSITE_EVIDENCE_OWNERSHIP_INVALID");
  }
  exactOrigin(input.targetOrigin);
  if (input.provider.apiVersion !== "v4" || input.provider.model !== "browser-use-2.0"
    || !/^[a-f0-9]{64}$/.test(input.provider.policyDigest)) throw new Error("WEBSITE_EVIDENCE_PROVIDER_INVALID");
  if (!store || typeof store.put !== "function") throw new Error("WEBSITE_EVIDENCE_STORE_REQUIRED");
  const snapshot: Snapshot = {
    version: 1,
    ownership: { organizationId: input.organizationId, projectId: input.projectId, runId: input.runId },
    targetOrigin: input.targetOrigin,
    provider: { ...input.provider },
    observations: normalizeObservations(input.observations, input.targetOrigin),
  };
  const sanitized = sanitizeEvidence(snapshot);
  const content = canonicalJson(sanitized);
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new Error("WEBSITE_EVIDENCE_BOUNDS_EXCEEDED");
  const evidence: WebsiteEvidence = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    analysisRunId: input.runId,
    source: "runtime",
    content,
    reference: `urn:sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
  };
  const stored = await store.put(evidence);
  if (!stored || stored.reference !== evidence.reference) throw new Error("WEBSITE_EVIDENCE_STORE_MISMATCH");
  return evidence;
}

type Candidate =
  | Readonly<{ adapter: "json_api"; value: WebsiteNetworkObservation }>
  | Readonly<{ adapter: "html_form"; value: WebsiteFormObservation }>
  | Readonly<{ adapter: "semantic_dom"; value: WebsiteDomObservation }>;

function schemaForFields(fields: readonly ObservedField[]): CapabilityPlan["schemas"]["input"] {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field.field, { type: "string", maxLength: field.maxLength } satisfies JsonSchema])),
    required: fields.filter((field) => field.required).map((field) => field.field),
    additionalProperties: false,
  };
}

function outputSchema(fields: readonly ObservedField[]): CapabilityPlan["schemas"]["output"] {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field.field, { type: "string", maxLength: field.maxLength } satisfies JsonSchema])),
    required: fields.map((field) => field.field),
    additionalProperties: false,
  };
}

function commonPlan(
  candidate: WebsiteNetworkObservation | WebsiteFormObservation | WebsiteDomObservation,
  snapshot: Snapshot,
  evidenceReference: string,
) {
  return {
    version: 1 as const,
    targetOrigin: snapshot.targetOrigin,
    tool: { name: candidate.logicalAction, title: candidate.title, description: candidate.description },
    annotations: { readOnly: true, untrusted: true },
    authentication: { mode: candidate.authentication, requiredScopes: [] },
    effects: {
      kind: "read" as const,
      riskTier: "R0" as const,
      reversible: true,
      summary: `Reads ${candidate.title.toLowerCase()}.`,
      confirmation: "none" as const,
    },
    evidence: [{ source: "runtime" as const, reference: evidenceReference }],
  };
}

function apiPlan(candidate: WebsiteNetworkObservation, snapshot: Snapshot, reference: string): CapabilityPlan {
  const path = Object.fromEntries(candidate.inputs.filter(({ location }) => location === "path").map(({ wireName, field }) => [wireName, field]));
  const query = Object.fromEntries(candidate.inputs.filter(({ location }) => location === "query").map(({ wireName, field }) => [wireName, field]));
  return CapabilityPlanSchema.parse({
    ...commonPlan(candidate, snapshot, reference),
    schemas: { input: schemaForFields(candidate.inputs), output: outputSchema(candidate.outputs) },
    idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    request: {
      adapter: "json_api", method: "GET", pathTemplate: candidate.pathTemplate, path, query, body: {}, bodyEncoding: "json",
      ...(candidate.inputs.some((field) => !field.required) ? { optional: candidate.inputs.filter((field) => !field.required).map((field) => field.field) } : {}),
    },
    response: {
      adapter: "json_api",
      contentTypes: [candidate.contentType],
      projection: { kind: "object", fields: Object.fromEntries(candidate.outputs.map(({ field, path }) => [field, path])) },
      errorMappings: { default: "TARGET_ERROR" },
    },
    success: { adapter: "json_api", statusCodes: [candidate.status], requiredOutputFields: candidate.outputs.map(({ field }) => field) },
  });
}

function formPlan(candidate: WebsiteFormObservation, snapshot: Snapshot, reference: string): CapabilityPlan {
  if ((candidate.redactedQueryParameters?.length ?? 0) > 0) throw new Error("redacted_form_action");
  return CapabilityPlanSchema.parse({
    ...commonPlan(candidate, snapshot, reference),
    schemas: { input: schemaForFields(candidate.controls), output: outputSchema(candidate.outputs) },
    idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    request: {
      adapter: "html_form", form: candidate.form, action: candidate.action, method: "GET",
      controls: Object.fromEntries(candidate.controls.map(({ name, field, required }) => [name, { inputField: field, optional: !required }])),
    },
    response: {
      adapter: "html_form", contentTypes: ["text/html"],
      projection: { kind: "semantic_object", fields: Object.fromEntries(candidate.outputs.map(({ field, value }) => [field, value])) },
      errorMappings: { default: "TARGET_ERROR" },
    },
    success: { adapter: "html_form", statusCodes: candidate.statusCodes, condition: candidate.success, requiredOutputFields: candidate.outputs.map(({ field }) => field) },
  });
}

function domPlan(candidate: WebsiteDomObservation, snapshot: Snapshot, reference: string): CapabilityPlan {
  if (candidate.inputs.some((input) => !input.locator)) throw new Error("unsupported_dom_input_locator");
  return CapabilityPlanSchema.parse({
    ...commonPlan(candidate, snapshot, reference),
    schemas: { input: schemaForFields(candidate.inputs), output: outputSchema(candidate.outputs) },
    idempotency: { strategy: "none", verified: false, retry: "none" },
    request: {
      adapter: "semantic_dom", scope: candidate.scope,
      inputs: Object.fromEntries(candidate.inputs.map(({ field, required, locator }) => [field, { locator, optional: !required }])),
      action: { kind: "read" },
    },
    response: {
      adapter: "semantic_dom",
      projection: { kind: "semantic_object", fields: Object.fromEntries(candidate.outputs.map(({ field, value }) => [field, value])) },
    },
    success: { adapter: "semantic_dom", condition: candidate.success, requiredOutputFields: candidate.outputs.map(({ field }) => field) },
  });
}

function verifiedSnapshot(evidence: WebsiteEvidence): Snapshot {
  if (!evidence.organizationId || !evidence.projectId || !evidence.analysisRunId) throw new Error("WEBSITE_EVIDENCE_OWNERSHIP_INVALID");
  const expected = `urn:sha256:${createHash("sha256").update(evidence.content, "utf8").digest("hex")}`;
  if (expected !== evidence.reference) throw new Error("WEBSITE_EVIDENCE_INTEGRITY_FAILED");
  let snapshot: Snapshot;
  try { snapshot = JSON.parse(evidence.content) as Snapshot; } catch { throw new Error("WEBSITE_EVIDENCE_INTEGRITY_FAILED"); }
  if (snapshot.version !== 1 || snapshot.ownership?.organizationId !== evidence.organizationId
    || snapshot.ownership?.projectId !== evidence.projectId || snapshot.ownership?.runId !== evidence.analysisRunId) {
    throw new Error("WEBSITE_EVIDENCE_OWNERSHIP_INVALID");
  }
  return snapshot;
}

export function proposeWebsiteCapabilityPlans(evidence: WebsiteEvidence): Readonly<{
  plans: readonly CapabilityPlan[];
  diagnostics: readonly WebsiteProposalDiagnostic[];
}> {
  const snapshot = verifiedSnapshot(evidence);
  const candidates: Candidate[] = [
    ...snapshot.observations.network.map((value) => ({ adapter: "json_api" as const, value })),
    ...snapshot.observations.forms.map((value) => ({ adapter: "html_form" as const, value })),
    ...snapshot.observations.dom.map((value) => ({ adapter: "semantic_dom" as const, value })),
  ];
  const byAction = new Map<string, Candidate[]>();
  for (const candidate of candidates) byAction.set(candidate.value.logicalAction, [...(byAction.get(candidate.value.logicalAction) ?? []), candidate]);
  const plans: CapabilityPlan[] = [];
  const diagnostics: WebsiteProposalDiagnostic[] = snapshot.observations.blockedMutations.map((blocked) => ({
    code: "DISCOVERY_MUTATION_BLOCKED",
    operationKey: `${blocked.method} ${blocked.path}`,
    reason: blocked.reason,
  }));
  if (candidates.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      code: "NO_SUPPORTED_WEBSITE_CAPABILITIES",
      operationKey: snapshot.targetOrigin,
      reason: "no_observed_candidate",
    });
  }
  const priorities = ["json_api", "html_form", "semantic_dom"] as const;
  for (const [operationKey, group] of [...byAction.entries()].sort(([left], [right]) => compareCodePoints(left, right))) {
    if (group.some(({ value }) => value.riskTier === "R3")) {
      diagnostics.push({ code: "HIGH_RISK_OPERATION_BLOCKED", operationKey });
      continue;
    }
    if (group.some(({ value }) => value.effect === "mutation"
      || "method" in value && value.method === "POST")) {
      diagnostics.push({ code: "DISCOVERY_MUTATION_REVIEW_REQUIRED", operationKey });
      continue;
    }
    const supported = group.filter((candidate) => candidate.adapter !== "json_api"
      || /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(candidate.value.contentType)
        && ![204, 205].includes(candidate.value.status));
    if (supported.length === 0) {
      diagnostics.push({ code: "UNSUPPORTED_WEBSITE_CANDIDATE", operationKey, reason: "unsupported_content_type" });
      continue;
    }
    const adapter = priorities.find((current) => supported.some((candidate) => candidate.adapter === current))!;
    const preferred = supported.filter((candidate) => candidate.adapter === adapter);
    if (preferred.length !== 1) {
      diagnostics.push({ code: "AMBIGUOUS_WEBSITE_CANDIDATE", operationKey, reason: `multiple_${adapter}_observations` });
      continue;
    }
    const selected = preferred[0]!;
    try {
      plans.push(selected.adapter === "json_api"
        ? apiPlan(selected.value, snapshot, evidence.reference)
        : selected.adapter === "html_form"
          ? formPlan(selected.value, snapshot, evidence.reference)
          : domPlan(selected.value, snapshot, evidence.reference));
    } catch (error) {
      diagnostics.push({
        code: "UNSUPPORTED_WEBSITE_CANDIDATE",
        operationKey,
        reason: error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : "canonical_plan_validation_failed",
      });
    }
  }
  return {
    plans: plans.length === 0 ? [] : canonicalizeCapabilityPlans(plans),
    diagnostics: diagnostics.sort((left, right) => compareCodePoints(left.operationKey, right.operationKey)
      || compareCodePoints(left.code, right.code)),
  };
}
