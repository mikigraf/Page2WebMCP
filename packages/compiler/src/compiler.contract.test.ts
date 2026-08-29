import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CapabilityPlan } from "../../capability-ir/src/plan.ts";
import { compileWebMcpRelease } from "./compiler.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REGISTRY = Symbol.for("page2webmcp.release.registry.v1");

type GeneratedTool = {
  name: string;
  title: string;
  execute(input: unknown, context: { signal: AbortSignal }): Promise<unknown>;
};

type GeneratedArtifact = {
  autoRegistration: Promise<{ supported: boolean; reason?: string; alreadyRegistered?: boolean }>;
  releaseManifest: { version: 3; targetOrigin: string; plans: CapabilityPlan[] };
  registerPage2WebMCPTools(bridge?: {
    confirm?: (request: { toolName: string; title: string; summary: string; input: Record<string, unknown>; signal: AbortSignal }) => boolean | Promise<boolean>;
  }): Promise<{ supported: boolean; reason?: string; alreadyRegistered?: boolean }>;
  unregisterPage2WebMCPTools(): void;
  getPage2WebMCPRegistrationState(): { status: string; registeredToolNames: string[] };
};

function plans(origin = "https://widgets.example"): CapabilityPlan[] {
  return [
    {
      version: 1,
      targetOrigin: origin,
      tool: { name: "search_widgets", title: "Search widgets", description: "Search widgets." },
      schemas: {
        input: {
          type: "object",
          properties: { query: { type: "string", minLength: 1, maxLength: 120 } },
          required: ["query"],
          additionalProperties: false,
        },
        output: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" } },
            required: ["id", "label"],
            additionalProperties: false,
          },
          maxItems: 100,
        },
      },
      annotations: { readOnly: true, untrusted: false },
      authentication: { mode: "same_origin_cookie", requiredScopes: ["widgets:read"] },
      effects: {
        kind: "read",
        riskTier: "R0",
        reversible: true,
        summary: "Reads widget summaries.",
        confirmation: "none",
      },
      idempotency: { strategy: "none", verified: false, retry: "safe_once" },
      request: { method: "GET", pathTemplate: "/v7/widgets", path: {}, query: { q: "query" }, body: {} },
      response: {
        contentTypes: ["application/json"],
        projection: { kind: "array", fields: { id: "widget_id", label: "display_name" } },
        errorMappings: {
          "401": "AUTHENTICATION_REQUIRED",
          "403": "FORBIDDEN",
          "429": "RATE_LIMITED",
          default: "TARGET_ERROR",
        },
      },
      success: { statusCodes: [200], requiredOutputFields: ["id", "label"] },
      evidence: [{ source: "openapi", reference: `urn:sha256:${HASH_A}` }],
    },
    {
      version: 1,
      targetOrigin: origin,
      tool: { name: "create_widget_draft", title: "Create widget draft", description: "Create a reversible widget draft." },
      schemas: {
        input: {
          type: "object",
          properties: { label: { type: "string", minLength: 1, maxLength: 80 } },
          required: ["label"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { id: { type: "string" }, state: { type: "string", enum: ["draft"] } },
          required: ["id", "state"],
          additionalProperties: false,
        },
      },
      annotations: { readOnly: false, untrusted: false },
      authentication: {
        mode: "same_origin_cookie",
        requiredScopes: ["widgets:write"],
        csrf: {
          reviewed: true,
          headerName: "x-csrf-token",
          resolution: { kind: "meta", selector: "meta[name=csrf-token]", attribute: "content" },
        },
      },
      effects: {
        kind: "mutation",
        riskTier: "R1",
        reversible: true,
        summary: "Creates one widget draft that can be deleted.",
        confirmation: "always",
      },
      idempotency: { strategy: "header", headerName: "idempotency-key", verified: true, retry: "safe_once" },
      request: { method: "POST", pathTemplate: "/v7/widget-drafts", path: {}, query: {}, body: { label: "label" } },
      response: {
        contentTypes: ["application/json"],
        projection: { kind: "object", fields: { id: "widget_id", state: "state" } },
        errorMappings: {
          "401": "AUTHENTICATION_REQUIRED",
          "403": "FORBIDDEN",
          "409": "STALE_TARGET",
          "422": "VALIDATION_FAILED",
          default: "TARGET_ERROR",
        },
      },
      success: { statusCodes: [201], requiredOutputFields: ["id", "state"] },
      evidence: [
        { source: "runtime", reference: `urn:sha256:${HASH_A}` },
        { source: "github", reference: `urn:sha256:${HASH_B}` },
      ],
    },
  ];
}

function installEnvironment(origin: string, tools: GeneratedTool[], options: { csrf?: string; supported?: boolean } = {}) {
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(events, { location: { origin } }),
  });
  const documentValue: Record<string, unknown> = {
    querySelector: (selector: string) => selector === "meta[name=csrf-token]" && options.csrf !== undefined
      ? { getAttribute: (name: string) => name === "content" ? options.csrf : null }
      : null,
  };
  if (options.supported !== false) {
    documentValue.modelContext = {
      registerTool: async (tool: GeneratedTool, registration: { signal: AbortSignal }) => {
        tools.push(tool);
        registration.signal.addEventListener("abort", () => {
          const index = tools.indexOf(tool);
          if (index >= 0) tools.splice(index, 1);
        }, { once: true });
      },
    };
  }
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentValue });
  return events;
}

async function importRelease(
  selectedPlans: CapabilityPlan[],
  options: { clearRegistry?: boolean; deadlineMs?: number } = {},
): Promise<GeneratedArtifact> {
  if (options.clearRegistry !== false) delete (globalThis as Record<symbol, unknown>)[REGISTRY];
  const release = compileWebMcpRelease(selectedPlans);
  const code = options.deadlineMs === undefined
    ? release.code
    : release.code.replace("const EXECUTION_DEADLINE_MS = 15000;", `const EXECUTION_DEADLINE_MS = ${options.deadlineMs};`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${crypto.randomUUID()}`) as Promise<GeneratedArtifact>;
}

test("compiler canonicalizes complete non-fixture plans and emits SHA-256/SHA-384 metadata", () => {
  const forward = compileWebMcpRelease(plans());
  const reordered = plans().reverse().map((plan) => ({
    ...plan,
    authentication: { ...plan.authentication, requiredScopes: [...plan.authentication.requiredScopes].reverse() },
    evidence: [...plan.evidence].reverse(),
    success: { ...plan.success, statusCodes: [...plan.success.statusCodes].reverse(), requiredOutputFields: [...plan.success.requiredOutputFields].reverse() },
  }));
  const reverse = compileWebMcpRelease(reordered);

  assert.equal(forward.code, reverse.code);
  assert.equal(forward.contentHash, createHash("sha256").update(forward.code).digest("hex"));
  assert.equal(forward.integrity, `sha384-${createHash("sha384").update(forward.code).digest("base64")}`);
  assert.deepEqual(forward.manifest.plans.map((plan) => plan.tool.name), ["create_widget_draft", "search_widgets"]);
  assert.equal(compileWebMcpRelease(forward.manifest.plans).code, forward.code);
  assert.doesNotMatch(forward.code, /Acme|api\/confirmations|process\.env|control-plane/i);
});

test("generated module auto-registers once and aborts registration on lifecycle teardown", async () => {
  const tools: GeneratedTool[] = [];
  const events = installEnvironment("https://widgets.example", tools);
  const first = await importRelease(plans());
  assert.deepEqual(await first.autoRegistration, { supported: true });
  assert.deepEqual(tools.map((tool) => tool.name), ["create_widget_draft", "search_widgets"]);
  assert.deepEqual(first.getPage2WebMCPRegistrationState(), {
    status: "registered",
    registeredToolNames: ["create_widget_draft", "search_widgets"],
  });

  const duplicate = await importRelease(plans(), { clearRegistry: false });
  assert.deepEqual(await duplicate.autoRegistration, { supported: true, alreadyRegistered: true });
  assert.equal(tools.length, 2);

  events.dispatchEvent(new Event("pagehide"));
  assert.equal(tools.length, 0);
});

test("generated module fails closed on wrong origin and unsupported WebMCP", async () => {
  const wrongTools: GeneratedTool[] = [];
  installEnvironment("https://evil.example", wrongTools);
  const wrong = await importRelease(plans());
  assert.deepEqual(await wrong.autoRegistration, { supported: false, reason: "ORIGIN_MISMATCH" });
  assert.equal(wrongTools.length, 0);

  installEnvironment("https://widgets.example", [], { supported: false });
  const unsupported = await importRelease(plans());
  assert.deepEqual(await unsupported.autoRegistration, { supported: false, reason: "WEBMCP_UNAVAILABLE" });
});

test("generated read projects output, sends credentials, maps errors, and bounds content type", async () => {
  const tools: GeneratedTool[] = [];
  installEnvironment("https://widgets.example", tools);
  const artifact = await importRelease(plans());
  await artifact.autoRegistration;
  const read = tools.find((tool) => tool.name === "search_widgets")!;
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      request = { url: String(input), init };
      return Response.json([{ widget_id: "w-1", display_name: "Alpha", secret: "drop" }]);
    };
    const output = await read.execute({ query: "alpha" }, { signal: new AbortController().signal });
    assert.deepEqual((output as Array<Record<string, unknown>>).map((item) => ({ ...item })), [{ id: "w-1", label: "Alpha" }]);
    assert.equal(request?.url, "https://widgets.example/v7/widgets?q=alpha");
    assert.equal(request?.init?.credentials, "same-origin");

    globalThis.fetch = async () => new Response("signed out", { status: 401 });
    await assert.rejects(read.execute({ query: "alpha" }, { signal: new AbortController().signal }), { code: "AUTHENTICATION_REQUIRED" });
    globalThis.fetch = async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });
    await assert.rejects(read.execute({ query: "alpha" }, { signal: new AbortController().signal }), { code: "UNSUPPORTED_CONTENT_TYPE" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated mutation resolves reviewed CSRF, confirms, and safely replays with one idempotency key", async () => {
  const tools: GeneratedTool[] = [];
  installEnvironment("https://widgets.example", tools, { csrf: "csrf-from-page" });
  const artifact = await importRelease(plans());
  await artifact.autoRegistration;
  let confirmations = 0;
  await artifact.registerPage2WebMCPTools({ confirm: async () => { confirmations += 1; return true; } });
  const mutation = tools.find((tool) => tool.name === "create_widget_draft")!;
  const originalFetch = globalThis.fetch;
  const headers: Headers[] = [];
  let calls = 0;
  try {
    globalThis.fetch = async (_input, init) => {
      calls += 1;
      headers.push(new Headers(init?.headers));
      if (calls === 1) throw new TypeError("response dropped after commit");
      return Response.json({ widget_id: "w-2", state: "draft" }, { status: 201 });
    };
    const result = await mutation.execute({ label: "Beta" }, { signal: new AbortController().signal });
    assert.deepEqual({ ...(result as Record<string, unknown>) }, { id: "w-2", state: "draft" });
    assert.equal(confirmations, 1);
    assert.equal(calls, 2);
    assert.equal(headers[0]!.get("x-csrf-token"), "csrf-from-page");
    assert.equal(headers[0]!.get("idempotency-key"), headers[1]!.get("idempotency-key"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated built-in confirmation is encapsulated, labelled, described, and handles approval and denial", async () => {
  class FakeElement extends EventTarget {
    readonly attributes = new Map<string, string>();
    readonly children: FakeElement[] = [];
    id = "";
    textContent = "";
    type = "";
    value = "";
    removed = false;
    shadowMode?: ShadowRootMode;

    constructor(readonly tagName: string) { super(); }
    append(...children: FakeElement[]) { this.children.push(...children); }
    attachShadow(options: ShadowRootInit) {
      this.shadowMode = options.mode;
      const shadow = new FakeElement("shadow-root");
      this.children.push(shadow);
      return shadow;
    }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    showModal() {}
    close() {}
    focus() {}
    remove() { this.removed = true; }
  }

  const tools: GeneratedTool[] = [];
  const created: FakeElement[] = [];
  installEnvironment("https://widgets.example", tools, { csrf: "csrf-from-page" });
  const currentDocument = globalThis.document as unknown as Record<string, unknown>;
  currentDocument.createElement = (tagName: string) => {
    const element = new FakeElement(tagName);
    created.push(element);
    return element;
  };
  currentDocument.body = new FakeElement("body");
  const artifact = await importRelease(plans());
  await artifact.autoRegistration;
  const mutation = tools.find((tool) => tool.name === "create_widget_draft")!;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ widget_id: "w-dialog", state: "draft" }, { status: 201 });
    const approved = mutation.execute({ label: "Dialog approval" }, { signal: new AbortController().signal });
    for (let attempt = 0; attempt < 100 && !created.some((element) => element.tagName === "dialog"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const host = created.find((element) => element.tagName === "div")!;
    const dialog = created.find((element) => element.tagName === "dialog")!;
    const summary = created.find((element) => element.tagName === "p")!;
    assert.equal(host.shadowMode, "closed");
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(dialog.getAttribute("aria-labelledby"), "page2webmcp-confirmation-title");
    assert.equal(dialog.getAttribute("aria-describedby"), "page2webmcp-confirmation-summary");
    assert.equal(summary.id, "page2webmcp-confirmation-summary");
    created.find((element) => element.tagName === "button" && element.textContent === "Confirm")!
      .dispatchEvent(new Event("click"));
    assert.equal((await approved as { id: string }).id, "w-dialog");

    const denied = mutation.execute({ label: "Dialog denial" }, { signal: new AbortController().signal });
    const firstDialogCount = created.filter((element) => element.tagName === "dialog").length;
    for (let attempt = 0; attempt < 100 && created.filter((element) => element.tagName === "dialog").length === firstDialogCount; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const cancelButtons = created.filter((element) => element.tagName === "button" && element.textContent === "Cancel");
    cancelButtons.at(-1)!.dispatchEvent(new Event("click"));
    await assert.rejects(denied, { code: "CONFIRMATION_DECLINED" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated confirmation denial, caller cancellation, and timeout make no uncontrolled effect", async () => {
  const deniedTools: GeneratedTool[] = [];
  installEnvironment("https://widgets.example", deniedTools, { csrf: "csrf-from-page" });
  const denied = await importRelease(plans());
  await denied.autoRegistration;
  await denied.registerPage2WebMCPTools({ confirm: async () => false });
  const mutation = deniedTools.find((tool) => tool.name === "create_widget_draft")!;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { calls += 1; return Response.json({}); };
    await assert.rejects(mutation.execute({ label: "No" }, { signal: new AbortController().signal }), { code: "CONFIRMATION_DECLINED" });
    assert.equal(calls, 0);

    const timeoutTools: GeneratedTool[] = [];
    installEnvironment("https://widgets.example", timeoutTools);
    const timeout = await importRelease([plans()[0]!], { deadlineMs: 5 });
    await timeout.autoRegistration;
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    await assert.rejects(timeoutTools[0]!.execute({ query: "x" }, { signal: new AbortController().signal }), { code: "DEADLINE_EXCEEDED" });

    const caller = new AbortController();
    const pending = timeoutTools[0]!.execute({ query: "x" }, { signal: caller.signal });
    caller.abort();
    await assert.rejects(pending, { code: "ABORTED" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
