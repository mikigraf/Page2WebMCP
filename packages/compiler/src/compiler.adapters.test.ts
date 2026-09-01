import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityPlan } from "../../capability-ir/src/plan.ts";
import {
  FixtureDocument,
  FixtureHTMLElement,
  FixtureInputElement,
  SemanticBrowserFixture,
} from "../../../test-support/semantic-browser-fixture.ts";
import { compileWebMcpRelease } from "./compiler.ts";

const HASH = "c".repeat(64);
const REGISTRY = Symbol.for("page2webmcp.release.registry.v1");

type GeneratedArtifact = {
  autoRegistration: Promise<{ supported: boolean; reason?: string; alreadyRegistered?: boolean }>;
  unregisterPage2WebMCPTools(): void;
};

function commonPlan() {
  return {
    version: 1,
    targetOrigin: "https://catalog.example",
    authentication: { mode: "same_origin_cookie", requiredScopes: [] },
    evidence: [{ source: "runtime", reference: `urn:sha256:${HASH}` }],
  } as const;
}

function formReadPlan(): CapabilityPlan {
  return {
    ...commonPlan(),
    tool: { name: "search_catalog", title: "Search catalog", description: "Search catalog entries." },
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
    effects: { kind: "read", riskTier: "R0", reversible: true, summary: "Reads catalog entries.", confirmation: "none" },
    idempotency: { strategy: "none", verified: false, retry: "safe_once" },
    request: {
      adapter: "html_form",
      form: { kind: "name", element: "form", name: "catalog_search" },
      action: "https://catalog.example/search",
      method: "GET",
      controls: {
        query: { inputField: "query", optional: false },
        category: { inputField: "category", optional: true },
      },
    },
    response: {
      adapter: "html_form",
      contentTypes: ["text/html"],
      projection: {
        kind: "semantic_object",
        fields: {
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
          label: { locator: { kind: "role", role: "heading", accessibleName: "Catalog result" }, read: "text" },
        },
      },
      errorMappings: { "401": "AUTHENTICATION_REQUIRED", default: "TARGET_ERROR" },
    },
    success: {
      adapter: "html_form",
      statusCodes: [200],
      condition: {
        locator: { kind: "role", role: "status", accessibleName: "Search status" },
        read: "text",
        equals: "complete",
      },
      requiredOutputFields: ["itemId", "label"],
    },
  } as unknown as CapabilityPlan;
}

function formMutationPlan(safeOnce = false): CapabilityPlan {
  const read = formReadPlan();
  return {
    ...read,
    tool: { name: "save_catalog_draft", title: "Save catalog draft", description: "Save a reversible catalog draft." },
    schemas: {
      input: {
        type: "object",
        properties: { label: { type: "string", minLength: 1, maxLength: 80 } },
        required: ["label"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { label: { type: "string", maxLength: 80 }, state: { type: "string", enum: ["saved"] } },
        required: ["label", "state"],
        additionalProperties: false,
      },
    },
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
    idempotency: safeOnce
      ? { strategy: "form_field", fieldName: "request_key", verified: true, retry: "safe_once" }
      : { strategy: "none", verified: false, retry: "none" },
    request: {
      adapter: "html_form",
      form: { kind: "name", element: "form", name: "catalog_editor" },
      action: "https://catalog.example/drafts/save",
      method: "POST",
      controls: { label: { inputField: "label", optional: false } },
    },
    response: {
      adapter: "html_form",
      contentTypes: ["text/html"],
      projection: {
        kind: "semantic_object",
        fields: {
          label: { locator: { kind: "role", role: "heading", accessibleName: "Saved draft" }, read: "text" },
          state: { locator: { kind: "role", role: "status", accessibleName: "Save status" }, read: "text" },
        },
      },
      errorMappings: { default: "TARGET_ERROR" },
    },
    success: {
      adapter: "html_form",
      statusCodes: [200],
      condition: {
        locator: { kind: "role", role: "status", accessibleName: "Save status" },
        read: "text",
        equals: "saved",
      },
      requiredOutputFields: ["label", "state"],
    },
  } as CapabilityPlan;
}

function domMutationPlan(): CapabilityPlan {
  return {
    ...formMutationPlan(),
    tool: { name: "rename_catalog_draft", title: "Rename catalog draft", description: "Rename a reversible catalog draft." },
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
        label: { locator: { kind: "label", element: "input", label: "Draft name" }, optional: false },
      },
      action: { kind: "click", target: { kind: "role", element: "button", role: "button", accessibleName: "Save draft" } },
    },
    response: {
      adapter: "semantic_dom",
      projection: {
        kind: "semantic_object",
        fields: {
          label: { locator: { kind: "label", element: "input", label: "Draft name" }, read: "value" },
          state: { locator: { kind: "role", role: "status", accessibleName: "Draft status" }, read: "text" },
        },
      },
    },
    success: {
      adapter: "semantic_dom",
      condition: {
        locator: { kind: "role", role: "status", accessibleName: "Draft status" },
        read: "text",
        equals: "saved",
      },
      requiredOutputFields: ["label", "state"],
    },
  } as CapabilityPlan;
}

function domReadPlan(): CapabilityPlan {
  const read = formReadPlan();
  return {
    ...read,
    tool: { name: "read_catalog_summary", title: "Read catalog summary", description: "Read the catalog summary." },
    idempotency: { strategy: "none", verified: false, retry: "none" },
    schemas: {
      input: { type: "object", properties: {}, required: [], additionalProperties: false },
      output: {
        type: "object",
        properties: { label: { type: "string", maxLength: 200 } },
        required: ["label"],
        additionalProperties: false,
      },
    },
    request: {
      adapter: "semantic_dom",
      scope: { kind: "role", role: "region", accessibleName: "Catalog overview" },
      inputs: {},
      action: { kind: "read" },
    },
    response: {
      adapter: "semantic_dom",
      projection: {
        kind: "semantic_object",
        fields: { label: { locator: { kind: "role", role: "heading", accessibleName: "Current catalog" }, read: "text" } },
      },
    },
    success: {
      adapter: "semantic_dom",
      condition: { locator: { kind: "role", role: "heading", accessibleName: "Current catalog" }, read: "text", equals: "Summer" },
      requiredOutputFields: ["label"],
    },
  } as CapabilityPlan;
}

async function importRelease(plans: CapabilityPlan[], clearRegistry = true): Promise<GeneratedArtifact> {
  if (clearRegistry) delete (globalThis as Record<symbol, unknown>)[REGISTRY];
  const release = compileWebMcpRelease(plans);
  return import(`data:text/javascript;base64,${Buffer.from(release.code).toString("base64")}#${crypto.randomUUID()}`) as Promise<GeneratedArtifact>;
}

function appendForm(
  fixture: SemanticBrowserFixture,
  options: { name: string; action: string; method: "get" | "post"; controlName: string; idempotency?: boolean },
) {
  const form = fixture.element("form", { name: options.name, action: options.action, method: options.method });
  const control = fixture.element("input", { name: options.controlName }) as FixtureInputElement;
  form.append(control);
  let idempotency: FixtureInputElement | undefined;
  if (options.idempotency) {
    idempotency = fixture.element("input", { name: "request_key", type: "hidden" }) as FixtureInputElement;
    form.append(idempotency);
  }
  fixture.document.body.append(form);
  return { form, control, idempotency };
}

function installSuccessfulFormResponse(fixture: SemanticBrowserFixture, label: string) {
  fixture.responseDocument((documentObject) => {
    const status = documentObject.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-label", label === "Notebook" ? "Search status" : "Save status");
    status.textContent = label === "Notebook" ? "complete" : "saved";
    const heading = documentObject.createElement("h2");
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-label", label === "Notebook" ? "Catalog result" : "Saved draft");
    heading.textContent = label;
    const output = documentObject.createElement("output");
    output.setAttribute("data-catalog-key", "primary-result");
    (output as unknown as { value: string }).value = "CAT-7";
    documentObject.body.append(status, heading, output);
  });
}

function appendDomEditor(fixture: SemanticBrowserFixture) {
  const scope = fixture.element("section", { "data-catalog-bridge": "draft-editor" });
  const label = fixture.element("label", { for: "draft-name" }, "Draft name");
  const input = fixture.element("input", { id: "draft-name", name: "draft_name" }) as FixtureInputElement;
  const button = fixture.element("button", { role: "button", "aria-label": "Save draft", type: "button" });
  const status = fixture.element("p", { role: "status", "aria-label": "Draft status" }, "idle");
  scope.append(label, input, button, status);
  fixture.document.body.append(scope);
  return { scope, input, button, status };
}

test("named HTML form reads set native controls, emit input/change, and project bounded HTML output", async () => {
  const fixture = new SemanticBrowserFixture().install();
  const { control } = appendForm(fixture, {
    name: "catalog_search",
    action: "https://catalog.example/search",
    method: "get",
    controlName: "query",
  });
  installSuccessfulFormResponse(fixture, "Notebook");
  const observedEvents: string[] = [];
  control.addEventListener("input", () => observedEvents.push("input"));
  control.addEventListener("change", () => observedEvents.push("change"));
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return new Response("catalog-result", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const artifact = await importRelease([formReadPlan()]);
    assert.deepEqual(await artifact.autoRegistration, { supported: true });
    const result = await fixture.tools[0]!.execute({ query: "notebook" }, { signal: new AbortController().signal });
    assert.deepEqual({ ...(result as Record<string, unknown>) }, { itemId: "CAT-7", label: "Notebook" });
    assert.equal(requestUrl, "https://catalog.example/search?query=notebook");
    assert.equal(control.value, "notebook");
    assert.equal(control.nativeValueSetterCalls, 1);
    assert.deepEqual(observedEvents, ["input", "change"]);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.restore();
  }
});

test("form mutation confirmation gates setters and ambiguous effects do not auto-retry", async () => {
  const deniedFixture = new SemanticBrowserFixture().install({ confirm: async () => false });
  const deniedForm = appendForm(deniedFixture, {
    name: "catalog_editor",
    action: "https://catalog.example/drafts/save",
    method: "post",
    controlName: "label",
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError("ambiguous form outcome"); };
  try {
    const deniedArtifact = await importRelease([formMutationPlan()]);
    await deniedArtifact.autoRegistration;
    await assert.rejects(
      deniedFixture.tools[0]!.execute({ label: "Autumn" }, { signal: new AbortController().signal }),
      { code: "CONFIRMATION_DECLINED" },
    );
    assert.equal(deniedForm.control.nativeValueSetterCalls, 0);
    assert.equal(calls, 0);
  } finally {
    deniedFixture.restore();
  }

  const approvedFixture = new SemanticBrowserFixture().install({ confirm: async () => true });
  appendForm(approvedFixture, {
    name: "catalog_editor",
    action: "https://catalog.example/drafts/save",
    method: "post",
    controlName: "label",
  });
  try {
    const approvedArtifact = await importRelease([formMutationPlan()]);
    await approvedArtifact.autoRegistration;
    await assert.rejects(
      approvedFixture.tools[0]!.execute({ label: "Autumn" }, { signal: new AbortController().signal }),
      { code: "TARGET_ERROR" },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    approvedFixture.restore();
  }
});

test("only verified standard-form idempotency permits one safe retry with the same native field", async () => {
  const fixture = new SemanticBrowserFixture().install({ confirm: async () => true });
  const { idempotency } = appendForm(fixture, {
    name: "catalog_editor",
    action: "https://catalog.example/drafts/save",
    method: "post",
    controlName: "label",
    idempotency: true,
  });
  installSuccessfulFormResponse(fixture, "Autumn");
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    bodies.push(String(init?.body));
    if (calls === 1) throw new TypeError("response dropped after commit");
    return new Response("saved", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const artifact = await importRelease([formMutationPlan(true)]);
    await artifact.autoRegistration;
    const result = await fixture.tools[0]!.execute({ label: "Autumn" }, { signal: new AbortController().signal });
    assert.equal((result as { state: string }).state, "saved");
    const keys = bodies.map((body) => new URLSearchParams(body).get("request_key"));
    assert.match(keys[0] ?? "", /^[a-zA-Z0-9._:-]{8,128}$/);
    assert.equal(keys[0], keys[1]);
    assert.equal(idempotency?.nativeValueSetterCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.restore();
  }
});

test("semantic DOM bridge resolves stable scope and role/name targets, using native setters and events", async () => {
  const fixture = new SemanticBrowserFixture().install({ confirm: async () => true });
  const { input, button, status } = appendDomEditor(fixture);
  const events: string[] = [];
  input.addEventListener("input", () => events.push("input"));
  input.addEventListener("change", () => events.push("change"));
  button.addEventListener("click", () => { status.textContent = "saved"; });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("DOM bridge must not fetch"); };
  try {
    const artifact = await importRelease([domMutationPlan()]);
    await artifact.autoRegistration;
    const result = await fixture.tools[0]!.execute({ label: "Winter" }, { signal: new AbortController().signal });
    assert.deepEqual({ ...(result as Record<string, unknown>) }, { label: "Winter", state: "saved" });
    assert.equal(input.nativeValueSetterCalls, 1);
    assert.deepEqual(events, ["input", "change"]);
    assert.equal(button.nativeClickCalls, 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.restore();
  }
});

test("semantic DOM mutations reject a generic scripted click target before side effects", async () => {
  const fixture = new SemanticBrowserFixture().install({ confirm: async () => true });
  const { scope, button, status } = appendDomEditor(fixture);
  button.remove();
  const genericTarget = fixture.element("div", { role: "button", "aria-label": "Save draft" });
  let sideEffects = 0;
  genericTarget.addEventListener("click", () => {
    sideEffects += 1;
    status.textContent = "saved";
  });
  scope.append(genericTarget);
  try {
    const artifact = await importRelease([domMutationPlan()]);
    await artifact.autoRegistration;
    await assert.rejects(
      fixture.tools[0]!.execute({ label: "Unsafe" }, { signal: new AbortController().signal }),
      { code: "STALE_PAGE" },
    );
    assert.equal(genericTarget.nativeClickCalls, 0);
    assert.equal(sideEffects, 0);
  } finally {
    fixture.restore();
  }
});

test("semantic DOM mutation reports a disappearing reviewed success target as stale immediately", async () => {
  const fixture = new SemanticBrowserFixture().install({ confirm: async () => true });
  const { button, status } = appendDomEditor(fixture);
  button.addEventListener("click", () => status.remove());
  try {
    const artifact = await importRelease([domMutationPlan()]);
    await artifact.autoRegistration;
    const execution = fixture.tools[0]!.execute({ label: "Drifted" }, { signal: new AbortController().signal });
    await assert.rejects(
      Promise.race([execution, new Promise((resolve) => setTimeout(() => resolve("STALLED"), 100))]),
      { code: "STALE_PAGE" },
    );
    assert.equal(button.nativeClickCalls, 1);
  } finally {
    fixture.events.dispatchEvent(new Event("pagehide"));
    fixture.restore();
  }
});

test("semantic and form target ambiguity, missing controls, and unexpected controls fail closed", async () => {
  const ambiguous = new SemanticBrowserFixture().install();
  for (let index = 0; index < 2; index += 1) {
    const region = ambiguous.element("section", { role: "region", "aria-label": "Catalog overview" });
    region.append(ambiguous.element("h2", { role: "heading", "aria-label": "Current catalog" }, "Summer"));
    ambiguous.document.body.append(region);
  }
  try {
    const artifact = await importRelease([domReadPlan()]);
    await artifact.autoRegistration;
    await assert.rejects(ambiguous.tools[0]!.execute({}, { signal: new AbortController().signal }), { code: "STALE_PAGE" });
  } finally {
    ambiguous.restore();
  }

  for (const mode of ["missing", "extra"] as const) {
    const fixture = new SemanticBrowserFixture().install();
    const form = fixture.element("form", {
      name: "catalog_search",
      action: "https://catalog.example/search",
      method: "get",
    });
    if (mode === "extra") {
      form.append(fixture.element("input", { name: "query" }), fixture.element("input", { name: "unreviewed" }));
    }
    fixture.document.body.append(form);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls += 1; return new Response(); };
    try {
      const artifact = await importRelease([formReadPlan()]);
      await artifact.autoRegistration;
      await assert.rejects(
        fixture.tools[0]!.execute({ query: "desk" }, { signal: new AbortController().signal }),
        { code: "STALE_PAGE" },
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
      fixture.restore();
    }
  }
});

test("form cancellation, lifecycle teardown, and same-origin navigation drift stop in-flight work", async () => {
  const fixture = new SemanticBrowserFixture().install();
  appendForm(fixture, {
    name: "catalog_search",
    action: "https://catalog.example/search",
    method: "get",
    controlName: "query",
  });
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    requestSignal = init?.signal ?? undefined;
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
  try {
    const artifact = await importRelease([formReadPlan()]);
    await artifact.autoRegistration;
    const execution = fixture.tools[0]!.execute({ query: "desk" }, { signal: new AbortController().signal });
    while (!requestSignal) await new Promise((resolve) => setTimeout(resolve, 1));
    fixture.events.dispatchEvent(new Event("pagehide"));
    await assert.rejects(execution, { code: "ABORTED" });
    assert.equal(requestSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.restore();
  }

  const formDrift = new SemanticBrowserFixture().install();
  appendForm(formDrift, {
    name: "catalog_search",
    action: "https://catalog.example/search",
    method: "get",
    controlName: "query",
  });
  let driftSignal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    driftSignal = init?.signal ?? undefined;
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
  try {
    const artifact = await importRelease([formReadPlan()]);
    await artifact.autoRegistration;
    const execution = formDrift.tools[0]!.execute({ query: "desk" }, { signal: new AbortController().signal });
    while (!driftSignal) await new Promise((resolve) => setTimeout(resolve, 1));
    formDrift.location.href = "https://catalog.example/other-page";
    await assert.rejects(
      Promise.race([execution, new Promise((resolve) => setTimeout(() => resolve("STALLED"), 100))]),
      { code: "STALE_PAGE" },
    );
    assert.equal(driftSignal.aborted, true);
  } finally {
    formDrift.events.dispatchEvent(new Event("pagehide"));
    globalThis.fetch = originalFetch;
    formDrift.restore();
  }

  const bodyDrift = new SemanticBrowserFixture().install();
  appendForm(bodyDrift, {
    name: "catalog_search",
    action: "https://catalog.example/search",
    method: "get",
    controlName: "query",
  });
  let responseStarted = false;
  let responseCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start() { responseStarted = true; },
    cancel() { responseCancelled = true; },
  }), { status: 200, headers: { "content-type": "text/html" } });
  try {
    const artifact = await importRelease([formReadPlan()]);
    await artifact.autoRegistration;
    const execution = bodyDrift.tools[0]!.execute({ query: "desk" }, { signal: new AbortController().signal });
    while (!responseStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    bodyDrift.location.href = "https://catalog.example/other-page";
    await assert.rejects(
      Promise.race([execution, new Promise((resolve) => setTimeout(() => resolve("STALLED"), 100))]),
      { code: "STALE_PAGE" },
    );
    assert.equal(responseCancelled, true);
  } finally {
    bodyDrift.events.dispatchEvent(new Event("pagehide"));
    globalThis.fetch = originalFetch;
    bodyDrift.restore();
  }

  const drift = new SemanticBrowserFixture().install({ confirm: async () => true });
  const { button } = appendDomEditor(drift);
  button.addEventListener("click", () => { drift.location.href = "https://catalog.example/other-page"; });
  try {
    const artifact = await importRelease([domMutationPlan()]);
    await artifact.autoRegistration;
    await assert.rejects(
      drift.tools[0]!.execute({ label: "Spring" }, { signal: new AbortController().signal }),
      { code: "STALE_PAGE" },
    );
  } finally {
    drift.restore();
  }

  const domCancellation = new SemanticBrowserFixture().install({ confirm: async () => true });
  const dom = appendDomEditor(domCancellation);
  const caller = new AbortController();
  try {
    const artifact = await importRelease([domMutationPlan()]);
    await artifact.autoRegistration;
    const execution = domCancellation.tools[0]!.execute({ label: "Cancelled" }, { signal: caller.signal });
    while (dom.button.nativeClickCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    caller.abort();
    await assert.rejects(execution, { code: "ABORTED" });
  } finally {
    domCancellation.events.dispatchEvent(new Event("pagehide"));
    domCancellation.restore();
  }
});

test("wrong-origin form action and semantic output drift fail closed before returning data", async () => {
  const wrong = new SemanticBrowserFixture().install();
  appendForm(wrong, {
    name: "catalog_search",
    action: "https://evil.example/collect",
    method: "get",
    controlName: "query",
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(); };
  try {
    const artifact = await importRelease([formReadPlan()]);
    await artifact.autoRegistration;
    await assert.rejects(wrong.tools[0]!.execute({ query: "private" }, { signal: new AbortController().signal }), {
      code: "ORIGIN_MISMATCH",
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    wrong.restore();
  }

  const wrongDom = new SemanticBrowserFixture().install({ confirm: async () => true });
  const dom = appendDomEditor(wrongDom);
  dom.button.remove();
  const crossOriginAction = wrongDom.element("a", {
    role: "button",
    "aria-label": "Save draft",
    href: "https://evil.example/collect",
  });
  let crossOriginClicks = 0;
  crossOriginAction.addEventListener("click", () => {
    crossOriginClicks += 1;
    dom.status.textContent = "saved";
  });
  dom.scope.append(crossOriginAction);
  try {
    const artifact = await importRelease([domMutationPlan()]);
    await artifact.autoRegistration;
    await assert.rejects(
      wrongDom.tools[0]!.execute({ label: "Private" }, { signal: new AbortController().signal }),
      { code: "STALE_PAGE" },
    );
    assert.equal(crossOriginClicks, 0);
  } finally {
    wrongDom.restore();
  }

  const oversized = new SemanticBrowserFixture().install();
  const scope = oversized.element("section", { role: "region", "aria-label": "Catalog overview" });
  scope.append(oversized.element("h2", { role: "heading", "aria-label": "Current catalog" }, "X".repeat(201)));
  oversized.document.body.append(scope);
  try {
    const artifact = await importRelease([domReadPlan()]);
    await artifact.autoRegistration;
    await assert.rejects(oversized.tools[0]!.execute({}, { signal: new AbortController().signal }), { code: "STALE_PAGE" });
  } finally {
    oversized.restore();
  }
});

test("mixed adapter releases canonicalize deterministically and duplicate loads register once", async () => {
  const plans = [formReadPlan(), domReadPlan()];
  assert.equal(compileWebMcpRelease(plans).code, compileWebMcpRelease([...plans].reverse()).code);

  const fixture = new SemanticBrowserFixture().install();
  appendForm(fixture, {
    name: "catalog_search",
    action: "https://catalog.example/search",
    method: "get",
    controlName: "query",
  });
  const region = fixture.element("section", { role: "region", "aria-label": "Catalog overview" });
  region.append(fixture.element("h2", { role: "heading", "aria-label": "Current catalog" }, "Summer"));
  fixture.document.body.append(region);
  try {
    const first = await importRelease(plans);
    assert.deepEqual(await first.autoRegistration, { supported: true });
    const duplicate = await importRelease([...plans].reverse(), false);
    assert.deepEqual(await duplicate.autoRegistration, { supported: true, alreadyRegistered: true });
    assert.equal(fixture.tools.length, 2);
  } finally {
    fixture.restore();
  }
});

test("browser response parsing is bounded before semantic projection", async () => {
  const fixture = new SemanticBrowserFixture().install();
  appendForm(fixture, {
    name: "catalog_search",
    action: "https://catalog.example/search",
    method: "get",
    controlName: "query",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 200, headers: { "content-type": "text/html" } });
  try {
    const artifact = await importRelease([formReadPlan()]);
    await artifact.autoRegistration;
    await assert.rejects(
      fixture.tools[0]!.execute({ query: "desk" }, { signal: new AbortController().signal }),
      { code: "RESPONSE_TOO_LARGE" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.restore();
  }
});

void FixtureDocument;
void FixtureHTMLElement;
