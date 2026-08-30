import test from "node:test";
import assert from "node:assert/strict";
import { acmeCapabilityPlans } from "../../../apps/acme-support/src/capability-plans.ts";
import type { CapabilityPlan } from "../../capability-ir/src/plan.ts";
import { compileOpenApi } from "../../openapi/src/compile.ts";
import { compileWebMcpRelease } from "./compiler.ts";

const REGISTRY = Symbol.for("page2webmcp.release.registry.v1");
let harnessFetch: typeof fetch = async () => { throw new Error("fetch harness is not configured"); };
type ConfirmationRequest = {
  toolName: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  signal: AbortSignal;
};
type ConfirmationHook = (request: ConfirmationRequest) => boolean | Promise<boolean>;
let harnessConfirm: ConfirmationHook | undefined;

const capturedHarnessFetch: typeof fetch = (input, init) => harnessFetch(input, init);
const capturedHarnessConfirmation = (request: ConfirmationRequest) => {
  if (!harnessConfirm) throw new Error("confirmation harness is not configured");
  return harnessConfirm(request);
};

type GeneratedTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
};

type GeneratedArtifact = {
  autoRegistration: Promise<{ supported: boolean; reason?: string; alreadyRegistered?: boolean }>;
  releaseManifest: { targetOrigin: string; plans: CapabilityPlan[] };
  registerPage2WebMCPTools: (bridge?: {
    confirm?: ConfirmationHook;
    onDiagnostic?: (event: { phase: "registration" | "execution"; code: string }) => void;
  }) => Promise<{ supported: boolean; reason?: string; alreadyRegistered?: boolean }>;
  unregisterPage2WebMCPTools: () => void;
};

const capabilities = acmeCapabilityPlans("https://acme.example")
  .filter((plan) => plan.tool.name !== "get_order_status");

async function loadArtifact(
  origin: string,
  selectedCapabilities: CapabilityPlan[] = capabilities,
  harness: { deadlineMs?: number; afterRegister?: (tool: GeneratedTool, signal: AbortSignal) => Promise<void> } = {},
): Promise<{ artifact: GeneratedArtifact; tools: GeneratedTool[]; registeredSignals: AbortSignal[] }> {
  const tools: GeneratedTool[] = [];
  const registeredSignals: AbortSignal[] = [];
  harnessFetch = async () => { throw new Error("fetch harness is not configured"); };
  harnessConfirm = undefined;
  delete (globalThis as Record<symbol, unknown>)[REGISTRY];
  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(windowEvents, { location: { origin } }),
  });
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: capturedHarnessFetch });
  Object.defineProperty(globalThis, "__page2webmcpConfirmSupportTicket", {
    configurable: true,
    writable: true,
    value: capturedHarnessConfirmation,
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: {
    registerTool: async (tool: GeneratedTool, options: { signal: AbortSignal }) => {
      tools.push(tool);
      registeredSignals.push(options.signal);
      options.signal.addEventListener("abort", () => {
        const index = tools.indexOf(tool);
        if (index >= 0) tools.splice(index, 1);
      }, { once: true });
      await harness.afterRegister?.(tool, options.signal);
    },
  }, querySelector: () => null } });
  const release = compileWebMcpRelease(selectedCapabilities);
  const code = harness.deadlineMs === undefined
    ? release.code
    : release.code.replace("const EXECUTION_DEADLINE_MS = 15000;", `const EXECUTION_DEADLINE_MS = ${harness.deadlineMs};`);
  const artifact = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${crypto.randomUUID()}`) as GeneratedArtifact;
  return { artifact, tools, registeredSignals };
}

async function registerWithFetch(artifact: GeneratedArtifact, fetchImpl: typeof fetch, bridge: Parameters<GeneratedArtifact["registerPage2WebMCPTools"]>[0] = {}) {
  harnessFetch = fetchImpl;
  harnessConfirm = bridge.confirm;
  return artifact.registerPage2WebMCPTools(bridge);
}

function findOrderTool(tools: GeneratedTool[]): GeneratedTool {
  return tools.find(({ name }) => name === "find_order")!;
}

test("compiler emits an executable browser artifact with accurate content metadata", async () => {
  const release = compileWebMcpRelease(capabilities);
  assert.match(release.contentHash, /^[a-f0-9]{64}$/);
  assert.match(release.integrity, /^sha384-[A-Za-z0-9+/]+=*$/);
  const { artifact, tools } = await loadArtifact("https://acme.example");
  assert.deepEqual(await artifact.autoRegistration, { supported: true });
  assert.equal(tools.length, capabilities.length);
});

test("compiler preserves the untrusted-content classification in its manifest and browser registration", async () => {
  const classified = [{ ...capabilities[0]!, annotations: { ...capabilities[0]!.annotations, untrusted: true } }];
  const release = compileWebMcpRelease(classified);
  assert.equal(release.manifest.plans[0]?.annotations.untrusted, true);
  const { artifact, tools } = await loadArtifact("https://acme.example", classified);
  await registerWithFetch(artifact, async () => Response.json([]));
  assert.equal(tools[0]?.annotations?.untrustedContentHint, true);
});

test("generated JSON adapter serializes reviewed headers, optional query values, and form bodies exactly", async () => {
  const evidenceReference = `urn:sha256:${"d".repeat(64)}`;
  const compiled = compileOpenApi({ openapi: "3.1.0", paths: {
    "/widgets/{id}": { get: {
      parameters: [
        { in: "path", name: "id", required: true, schema: { type: "string", maxLength: 20 } },
        { in: "query", name: "locale", schema: { type: "string", maxLength: 5 } },
        { in: "header", name: "X-Trace", required: true, schema: { type: "string", maxLength: 20 } },
      ],
      responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
    } },
    "/widgets": { post: {
      "x-page2webmcp": { reviewed: true, effect: "mutation", riskTier: "R1", reversible: true },
      requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: {
        type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 20 } },
      } } } },
      responses: { "201": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
    } },
  } }, {
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review",
    environment: "test",
    evidenceReference,
  });
  const executablePlans = compiled.plans.map((plan) => plan.effects.kind === "mutation" ? {
    ...plan,
    effects: {
      ...plan.effects,
      sourceNativeConfirmation: {
        reviewed: true as const,
        globalName: "__page2webmcpConfirmSupportTicket",
        evidenceReference,
      },
    },
  } : plan);
  const loaded = await loadArtifact("https://widgets.example", executablePlans);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  await registerWithFetch(loaded.artifact, async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json(true, { status: init?.method === "POST" ? 201 : 200 });
  }, { confirm: () => true });
  const platform = {
    Headers: globalThis.Headers,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  };
  const replaced = class { constructor() { throw new Error("PAGE_REPLACEMENT_CALLED"); } };
  try {
    for (const name of Object.keys(platform)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: replaced });
    const read = loaded.tools.find(({ name }) => name.startsWith("get_operation_"))!;
    await read.execute({ path_id: "a/b", header_x_trace: "trace-1" }, { signal: new AbortController().signal });
    const mutation = loaded.tools.find(({ name }) => name.startsWith("post_operation_"))!;
    await mutation.execute({ body_name: "blue widget" }, { signal: new AbortController().signal });
  } finally {
    for (const [name, constructor] of Object.entries(platform)) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: constructor });
    }
  }
  assert.equal(requests[0]!.url, "https://widgets.example/widgets/a%2Fb");
  assert.equal(new Headers(requests[0]!.init?.headers).get("x-trace"), "trace-1");
  assert.equal(requests[1]!.init?.body, "name=blue+widget");
  assert.match(new Headers(requests[1]!.init?.headers).get("content-type") ?? "", /^application\/x-www-form-urlencoded/);
});

test("compiler applies no fixture-name metadata fallback", () => {
  const fixturePlan = acmeCapabilityPlans("https://acme.example")
    .find((plan) => plan.tool.name === "get_order_status")!;
  const release = compileWebMcpRelease([{ ...fixturePlan, annotations: { ...fixturePlan.annotations, untrusted: false } }]);
  assert.equal(release.manifest.plans[0]?.annotations.untrusted, false);
});

test("generated runtime enforces allowedOrigin before registration and immediately before execution", async () => {
  const wrong = await loadArtifact("https://evil.example");
  assert.deepEqual(await wrong.artifact.registerPage2WebMCPTools(), { supported: false, reason: "ORIGIN_MISMATCH" });
  assert.equal(wrong.tools.length, 0);

  const right = await loadArtifact("https://acme.example");
  await registerWithFetch(right.artifact, async () => Response.json([]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://evil.example" } } });
  await assert.rejects(
    findOrderTool(right.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }),
    { name: "Page2WebMCPError", code: "ORIGIN_MISMATCH" },
  );
});

test("generated runtime rejects malformed input and additional properties before making a request", async () => {
  let calls = 0;
  const { artifact, tools } = await loadArtifact("https://acme.example");
  await registerWithFetch(artifact, async () => { calls += 1; return Response.json([]); });
  const tool = tools.find(({ name }) => name === "find_order")!;
  await assert.rejects(tool.execute({ query: "" }, { signal: new AbortController().signal }), { code: "INVALID_INPUT" });
  await assert.rejects(tool.execute({ query: "ORD-4812", injected: true }, { signal: new AbortController().signal }), { code: "INVALID_INPUT" });
  await assert.rejects(tool.execute(null, { signal: new AbortController().signal }), { code: "INVALID_INPUT" });
  assert.equal(calls, 0);
});

test("get_order_status enforces the endpoint's 64-character identifier boundary before fetch", async () => {
  let calls = 0;
  const { artifact, tools } = await loadArtifact("https://acme.example", acmeCapabilityPlans("https://acme.example")
    .filter((plan) => plan.tool.name === "get_order_status"));
  await registerWithFetch(artifact, async () => {
    calls += 1;
    return Response.json({ orderId: "x".repeat(64), shipmentStatus: "unknown", customerNotes: "", untrustedContent: true });
  });
  const tool = tools[0]!;
  await assert.doesNotReject(tool.execute({ query: "x".repeat(64) }, { signal: new AbortController().signal }));
  assert.equal(calls, 1);
  await assert.rejects(
    tool.execute({ query: "x".repeat(65) }, { signal: new AbortController().signal }),
    { code: "INVALID_INPUT" }
  );
  assert.equal(calls, 1);
});

test("generated runtime rejects inherited Object prototype names as undeclared input properties", async () => {
  let calls = 0;
  const { artifact, tools } = await loadArtifact("https://acme.example");
  await registerWithFetch(artifact, async () => { calls += 1; return Response.json([]); });
  const tool = tools.find(({ name }) => name === "find_order")!;
  for (const property of ["constructor", "__proto__", "prototype"]) {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { query: "ORD-4812" });
    input[property] = "attacker-controlled";
    await assert.rejects(tool.execute(input, { signal: new AbortController().signal }), { code: "INVALID_INPUT" });
  }
  assert.equal(calls, 0);
});

test("generated runtime projects allowlisted output and rejects malformed output", async () => {
  const { artifact, tools } = await loadArtifact("https://acme.example");
  let response: unknown = [{ id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" }];
  await registerWithFetch(artifact, async () => Response.json(response));
  const tool = tools.find(({ name }) => name === "find_order")!;
  const validResult = await tool.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }) as Array<Record<string, unknown>>;
  assert.deepEqual(validResult.map((item) => ({ ...item })), [
    { id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" },
  ]);
  response = [{ id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed", paymentDetails: "secret" }];
  await assert.rejects(tool.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "INVALID_OUTPUT" });
  response = [{ id: "ORD-4812", email: "customer@example.test" }];
  await assert.rejects(tool.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "INVALID_OUTPUT" });
});

test("generated runtime returns null-prototype object projections", async () => {
  const { artifact, tools } = await loadArtifact("https://acme.example");
  await registerWithFetch(artifact, async () => Response.json([
    { id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" },
  ]));
  const result = await findOrderTool(tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }) as Array<Record<string, unknown>>;
  assert.equal(Object.getPrototypeOf(result[0]!), null);
});

test("generated runtime returns typed safe errors for HTTP failures and oversized bodies", async () => {
  const http = await loadArtifact("https://acme.example");
  await registerWithFetch(http.artifact, async () => new Response("upstream secret", { status: 502 }));
  await assert.rejects(findOrderTool(http.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), (error: unknown) => {
    assert.equal((error as { code: string }).code, "TARGET_ERROR");
    assert.doesNotMatch(String((error as Error).message), /upstream secret/);
    return true;
  });

  const large = await loadArtifact("https://acme.example");
  await registerWithFetch(large.artifact, async () => new Response("x".repeat(65_537), {
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(findOrderTool(large.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "RESPONSE_TOO_LARGE" });
});

test("generated safe GET retries one retryable response and no more", async () => {
  const recovered = await loadArtifact("https://acme.example");
  let recoveredCalls = 0;
  await registerWithFetch(recovered.artifact, async () => {
    recoveredCalls += 1;
    return recoveredCalls === 1
      ? new Response("temporarily unavailable", { status: 503 })
      : Response.json([{ id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" }]);
  });
  const result = await findOrderTool(recovered.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }) as Array<Record<string, unknown>>;
  assert.equal(result[0]!.id, "ORD-4812");
  assert.equal(recoveredCalls, 2);

  const bounded = await loadArtifact("https://acme.example");
  let boundedCalls = 0;
  await registerWithFetch(bounded.artifact, async () => {
    boundedCalls += 1;
    return boundedCalls < 3 ? new Response("still unavailable", { status: 429 }) : Response.json([]);
  });
  await assert.rejects(findOrderTool(bounded.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "RATE_LIMITED" });
  assert.equal(boundedCalls, 2);
});

test("generated requests do not retry authentication or other non-retryable 4xx responses", async () => {
  for (const status of [400, 401, 403, 409]) {
    const generated = await loadArtifact("https://acme.example");
    let calls = 0;
    await registerWithFetch(generated.artifact, async () => { calls += 1; return new Response("rejected", { status }); });
    await assert.rejects(findOrderTool(generated.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), {
      code: status === 401 ? "AUTHENTICATION_REQUIRED" : status === 403 ? "FORBIDDEN" : status === 409 ? "STALE_TARGET" : "VALIDATION_FAILED",
    });
    assert.equal(calls, 1);
  }
});

test("generated final POST recovers a dropped response with the same idempotency key", async () => {
  const generated = await loadArtifact("https://acme.example");
  let confirmCalls = 0;
  let ticketCalls = 0;
  const mutationHeaders: Headers[] = [];
  const committedTicket = { ticketId: "TCK-committed", status: "open", priority: "high", createdAt: "2026-08-29T00:00:00.000Z" };
  await registerWithFetch(generated.artifact, async (_request, init) => {
    ticketCalls += 1;
    mutationHeaders.push(new Headers(init?.headers));
    if (ticketCalls === 1) {
      // The server committed, but the client never received its response.
      throw new TypeError("connection dropped after commit");
    }
    return Response.json(committedTicket, { status: 201 });
  }, { confirm: async () => { confirmCalls += 1; return true; } });
  const tool = generated.tools.find(({ name }) => name === "create_support_ticket")!;
  assert.equal((await tool.execute(
    { orderId: "ORD-4812", title: "Recover committed ticket", priority: "high" },
    { signal: new AbortController().signal },
  ) as { ticketId: string }).ticketId, "TCK-committed");
  assert.equal(confirmCalls, 1);
  assert.equal(ticketCalls, 2);
  assert.equal(mutationHeaders[0]!.get("idempotency-key"), mutationHeaders[1]!.get("idempotency-key"));
});

test("generated mutation reuses its pending key across a timed-out execute and a separate invocation", async () => {
  // Leave enough headroom for WebCrypto's async digest under parallel test load;
  // the deliberately unresolved first fetch still deterministically reaches the deadline.
  const generated = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 100 });
  const mutationKeys: string[] = [];
  let confirmationCalls = 0;
  let mutationCalls = 0;
  const committedTicket = {
    ticketId: "TCK-ambiguous",
    status: "open",
    priority: "high",
    createdAt: "2026-08-29T00:00:00.000Z"
  };
  await registerWithFetch(generated.artifact, async (_request, init) => {
    mutationCalls += 1;
    mutationKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (mutationCalls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return Response.json(committedTicket, { status: 201 });
  }, { confirm: async () => { confirmationCalls += 1; return true; } });
  const tool = generated.tools.find(({ name }) => name === "create_support_ticket")!;
  const input = { orderId: "ORD-4812", title: "Recover after timeout", priority: "high" };

  await assert.rejects(
    tool.execute(input, { signal: new AbortController().signal }),
    { code: "DEADLINE_EXCEEDED" }
  );
  assert.equal((await tool.execute(input, { signal: new AbortController().signal }) as { ticketId: string }).ticketId, "TCK-ambiguous");
  assert.equal(confirmationCalls, 2);
  assert.equal(mutationCalls, 2);
  assert.equal(mutationKeys[0], mutationKeys[1]);
});

test("generated final POST does not retry an idempotency conflict", async () => {
  const generated = await loadArtifact("https://acme.example");
  let ticketCalls = 0;
  await registerWithFetch(generated.artifact, async () => {
    ticketCalls += 1;
    return new Response("conflict", { status: 409 });
  }, { confirm: async () => true });
  const tool = generated.tools.find(({ name }) => name === "create_support_ticket")!;
  await assert.rejects(tool.execute(
    { orderId: "ORD-4812", title: "Conflicting ticket", priority: "high" },
    { signal: new AbortController().signal },
  ), { code: "STALE_TARGET" });
  assert.equal(ticketCalls, 1);
});

test("generated retry remains inside the original total execution deadline", async () => {
  const generated = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 5 });
  let calls = 0;
  await registerWithFetch(generated.artifact, async (_request, init) => {
    calls += 1;
    if (calls === 1) throw new TypeError("temporary network failure");
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  });
  await assert.rejects(findOrderTool(generated.tools).execute(
    { query: "ORD-4812" },
    { signal: new AbortController().signal },
  ), { code: "DEADLINE_EXCEEDED" });
  assert.equal(calls, 2);
});

test("generated runtime applies a deadline and honors caller cancellation", async () => {
  const timeout = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 5 });
  await registerWithFetch(timeout.artifact, async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
  await assert.rejects(findOrderTool(timeout.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "DEADLINE_EXCEEDED" });

  const cancelled = await loadArtifact("https://acme.example");
  await registerWithFetch(cancelled.artifact, async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
  const caller = new AbortController();
  const pending = findOrderTool(cancelled.tools).execute({ query: "ORD-4812" }, { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
});

test("generated deadline includes response body consumption", async () => {
  const delayedBody = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 5 });
  await registerWithFetch(delayedBody.artifact, async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    }), { headers: { "content-type": "application/json" } }));
  const execution = findOrderTool(delayedBody.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal });
  await assert.rejects(
    Promise.race([execution, new Promise((resolve) => setTimeout(() => resolve("STALLED"), 50))]),
    { code: "DEADLINE_EXCEEDED" },
  );
});

test("generated deadline and caller cancellation include the confirmation callback", async () => {
  const timed = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 5 });
  await registerWithFetch(timed.artifact, async () => { throw new Error("fetch must not run"); }, { confirm: async () => new Promise<boolean>(() => {}) });
  const timedTool = timed.tools.find(({ name }) => name === "create_support_ticket")!;
  await assert.rejects(
    Promise.race([
      timedTool.execute({ orderId: "ORD-4812", title: "Timed confirmation", priority: "high" }, { signal: new AbortController().signal }),
      new Promise((resolve) => setTimeout(() => resolve("STALLED"), 50)),
    ]),
    { code: "DEADLINE_EXCEEDED" },
  );

  const cancelled = await loadArtifact("https://acme.example");
  await registerWithFetch(cancelled.artifact, async () => { throw new Error("fetch must not run"); }, { confirm: async () => new Promise<boolean>(() => {}) });
  const cancelledTool = cancelled.tools.find(({ name }) => name === "create_support_ticket")!;
  const caller = new AbortController();
  const pending = cancelledTool.execute({ orderId: "ORD-4812", title: "Cancelled confirmation", priority: "high" }, { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
});

test("generated response reader cancels a stream immediately after the 64 KiB cap", async () => {
  let pulls = 0;
  let cancelled = false;
  const large = await loadArtifact("https://acme.example");
  await registerWithFetch(large.artifact, async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(40_000));
      if (pulls === 100) controller.close();
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(findOrderTool(large.tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "RESPONSE_TOO_LARGE" });
  assert.equal(cancelled, true);
  assert.ok(pulls < 100);
});

test("generated registration and unregistration are idempotent without duplicate tools", async () => {
  const { artifact, tools, registeredSignals } = await loadArtifact("https://acme.example");
  const first = await registerWithFetch(artifact, async () => Response.json([]));
  const second = await artifact.registerPage2WebMCPTools();
  assert.equal(first.supported, true);
  assert.equal(second.alreadyRegistered, true);
  assert.equal(tools.length, capabilities.length);
  artifact.unregisterPage2WebMCPTools();
  artifact.unregisterPage2WebMCPTools();
  assert.equal(tools.length, 0);
  assert.ok(registeredSignals.every((signal) => signal.aborted));
});

test("concurrent registration shares one generation and unregister during registration leaves no leaked tools", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let registrations = 0;
  const concurrent = await loadArtifact("https://acme.example", capabilities, {
    afterRegister: async () => { registrations += 1; if (registrations <= 2) await firstGate; },
  });
  const first = registerWithFetch(concurrent.artifact, async () => Response.json([]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = concurrent.artifact.registerPage2WebMCPTools();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(concurrent.tools.length, 1);
  concurrent.artifact.unregisterPage2WebMCPTools();
  releaseFirst();
  const cancelled = await Promise.all([first, second]);
  assert.deepEqual(cancelled, [
    { supported: false, reason: "REGISTRATION_CANCELLED" },
    { supported: false, reason: "REGISTRATION_CANCELLED" },
  ]);
  assert.equal(concurrent.tools.length, 0);

  await registerWithFetch(concurrent.artifact, async () => Response.json([]));
  assert.equal(concurrent.tools.length, capabilities.length);
  assert.equal(new Set(concurrent.tools.map(({ name }) => name)).size, capabilities.length);
});

test("generated mutation fails closed without confirmation and sends bound evidence when approved", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    return Response.json({ ticketId: "TCK-safe", status: "open", priority: "high", createdAt: "2026-08-29T00:00:00.000Z" }, { status: 201 });
  };

  const missing = await loadArtifact("https://acme.example");
  await registerWithFetch(missing.artifact, fakeFetch);
  const missingTool = missing.tools.find(({ name }) => name === "create_support_ticket")!;
  const input = { orderId: "ORD-4812", title: "Damaged parcel", priority: "high" };
  await assert.rejects(missingTool.execute(input, { signal: new AbortController().signal }), { code: "CONFIRMATION_FAILED" });

  const declined = await loadArtifact("https://acme.example");
  await registerWithFetch(declined.artifact, fakeFetch, { confirm: async () => false });
  const declinedTool = declined.tools.find(({ name }) => name === "create_support_ticket")!;
  await assert.rejects(declinedTool.execute(input, { signal: new AbortController().signal }), { code: "CONFIRMATION_DECLINED" });
  assert.equal(requests.length, 0);

  const approved = await loadArtifact("https://acme.example");
  let confirmationRequest: unknown;
  await registerWithFetch(approved.artifact, fakeFetch, { confirm: async (request) => { confirmationRequest = request; return true; } });
  const approvedTool = approved.tools.find(({ name }) => name === "create_support_ticket")!;
  const ticket = await approvedTool.execute(input, { signal: new AbortController().signal });
  assert.equal((ticket as { ticketId: string }).ticketId, "TCK-safe");
  assert.deepEqual({ ...(confirmationRequest as { input: Record<string, unknown> }).input }, input);
  assert.equal(requests.length, 1);
  const mutationHeaders = new Headers(requests[0]!.init?.headers);
  assert.equal(mutationHeaders.get("x-page2webmcp-confirmation"), null);
  assert.match(mutationHeaders.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/);
});

test("host confirmation bridge cannot replace fetch execution semantics", async () => {
  let platformCalls = 0;
  let injectedCalls = 0;
  const { artifact, tools } = await loadArtifact("https://acme.example");
  await registerWithFetch(
    artifact,
    async () => { platformCalls += 1; return Response.json([]); },
    { fetch: async () => { injectedCalls += 1; return Response.json([]); } } as unknown as Parameters<GeneratedArtifact["registerPage2WebMCPTools"]>[0],
  );
  await findOrderTool(tools).execute({ query: "ORD-4812" }, { signal: new AbortController().signal });
  assert.equal(platformCalls, 1);
  assert.equal(injectedCalls, 0);
});

test("generated diagnostics expose only stable phase and code", async () => {
  const diagnostics: Array<{ phase: "registration" | "execution"; code: string }> = [];
  const generated = await loadArtifact("https://acme.example", capabilities, {
    afterRegister: async () => { throw new Error("secret registration detail"); },
  });
  await assert.rejects(registerWithFetch(generated.artifact, async () => Response.json([]), { onDiagnostic: (event) => diagnostics.push(event) }));
  assert.deepEqual(diagnostics, [{ phase: "registration", code: "REGISTRATION_FAILED" }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret/i);
});

test("all concurrent registration callers receive typed safe failures", async () => {
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const generated = await loadArtifact("https://acme.example", capabilities, {
    afterRegister: async () => {
      await failureGate;
      throw new Error("secret registration detail");
    },
  });
  const first = registerWithFetch(generated.artifact, async () => Response.json([]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = generated.artifact.registerPage2WebMCPTools();
  releaseFailure();
  const results = await Promise.allSettled([first, second]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal((result as PromiseRejectedResult).reason?.name, "Page2WebMCPError");
    assert.equal((result as PromiseRejectedResult).reason?.code, "REGISTRATION_FAILED");
    assert.doesNotMatch(String((result as PromiseRejectedResult).reason?.message), /secret/i);
  }
});

test("compiler rejects unsafe request plans", () => {
  const read = capabilities.find((plan) => plan.tool.name === "find_order")!;
  const mutation = capabilities.find((plan) => plan.tool.name === "create_support_ticket")!;
  if (read.request.adapter !== "json_api" || mutation.request.adapter !== "json_api") {
    throw new Error("expected JSON fixture adapters");
  }
  const readRequest = read.request;
  const mutationRequest = mutation.request;
  assert.throws(() => compileWebMcpRelease([{
    ...read,
    request: { ...readRequest, pathTemplate: "https://evil.example/orders" },
  }]), /unsafe request path/i);
  assert.throws(() => compileWebMcpRelease([{
    ...read,
    request: { ...readRequest, method: "DELETE" },
  } as unknown as CapabilityPlan]), /invalid option|GET|POST/i);
  assert.throws(() => compileWebMcpRelease([{
    name: "lookup",
    description: "Generic lookup",
    readOnly: true,
  } as unknown as CapabilityPlan]), /invalid input|expected/i);
  assert.throws(() => compileWebMcpRelease([{
    ...mutation,
    request: { ...mutationRequest, method: "GET" },
  }]), /mutation capability must use POST/i);

  const inheritedProperties = Object.create({ constructor: { type: "string" } }) as Record<string, { type: "string" }>;
  assert.throws(() => compileWebMcpRelease([{
    ...read,
    schemas: {
      ...read.schemas,
      input: { type: "object", properties: inheritedProperties, required: ["constructor"], additionalProperties: false },
    },
    request: { ...readRequest, query: {} },
  }]), /unknown property/i);
});
