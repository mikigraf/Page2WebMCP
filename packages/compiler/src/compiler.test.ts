import test from "node:test";
import assert from "node:assert/strict";
import { compileWebMcpRelease, type CompilableCapability } from "./compiler.ts";

type GeneratedTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
};

type GeneratedArtifact = {
  releaseManifest: { allowedOrigin: string; tools: Array<{ name: string }> };
  registerPage2WebMCPTools: (bridge?: {
    confirm?: (request: { toolName: string; input: Record<string, unknown>; idempotencyKey: string; signal: AbortSignal }) => boolean | Promise<boolean>;
    onDiagnostic?: (event: { phase: "registration" | "execution"; code: string }) => void;
  }) => Promise<{ supported: boolean; reason?: string; alreadyRegistered?: boolean }>;
  unregisterPage2WebMCPTools: () => void;
};

const capabilities: CompilableCapability[] = [
  {
    name: "find_order",
    description: "Find an order",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 120 } },
      required: ["query"],
      additionalProperties: false,
    },
    requestPlan: { method: "GET", path: "/api/orders", query: { q: "query" } },
    outputSchema: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, email: { type: "string" }, shipmentStatus: { type: "string" } },
        required: ["id", "email", "shipmentStatus"],
        additionalProperties: false,
      },
    },
  },
  {
    name: "create_support_ticket",
    description: "Create a ticket",
    readOnly: false,
    requiresConfirmation: true,
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 3, maxLength: 120 },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["orderId", "title", "priority"],
      additionalProperties: false,
    },
    requestPlan: { method: "POST", path: "/api/tickets", body: ["orderId", "title", "priority"] },
    outputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" }, status: { type: "string", enum: ["open"] },
        priority: { type: "string", enum: ["low", "medium", "high"] }, createdAt: { type: "string" },
      },
      required: ["ticketId", "status", "priority", "createdAt"],
      additionalProperties: false,
    },
  },
];

async function loadArtifact(
  origin: string,
  selectedCapabilities: CompilableCapability[] = capabilities,
  harness: { deadlineMs?: number; afterRegister?: (tool: GeneratedTool, signal: AbortSignal) => Promise<void> } = {},
): Promise<{ artifact: GeneratedArtifact; tools: GeneratedTool[]; registeredSignals: AbortSignal[] }> {
  const tools: GeneratedTool[] = [];
  const registeredSignals: AbortSignal[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin } } });
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
  } } });
  const release = compileWebMcpRelease(selectedCapabilities, "https://acme.example");
  const code = harness.deadlineMs === undefined
    ? release.code
    : release.code.replace("const EXECUTION_DEADLINE_MS = 15000;", `const EXECUTION_DEADLINE_MS = ${harness.deadlineMs};`);
  const artifact = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${crypto.randomUUID()}`) as GeneratedArtifact;
  return { artifact, tools, registeredSignals };
}

async function registerWithFetch(artifact: GeneratedArtifact, fetchImpl: typeof fetch, bridge: Parameters<GeneratedArtifact["registerPage2WebMCPTools"]>[0] = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await artifact.registerPage2WebMCPTools(bridge);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("compiler emits a browser artifact with accurate content metadata and no arbitrary execute callback", () => {
  const release = compileWebMcpRelease(capabilities, "https://acme.example");
  assert.match(release.code, /document\.modelContext\.registerTool/);
  assert.match(release.code, /credentials: "same-origin"/);
  assert.match(release.code, /EXECUTION_DEADLINE_MS = 15000/);
  assert.doesNotMatch(release.code, /testOverrides|bridge\.fetch|deadlineMs:/);
  assert.doesNotMatch(release.code, /registerPage2WebMCPTools\(execute\)/);
  assert.doesNotMatch(release.code, /navigator\.modelContext/);
  assert.match(release.contentHash, /^[a-f0-9]{64}$/);
  assert.match(release.integrity, /^sha256-[A-Za-z0-9+/]+=*$/);
});

test("compiler preserves the untrusted-content classification in its manifest and browser registration", async () => {
  const classified = [{ ...capabilities[0]!, untrustedContent: true }];
  const release = compileWebMcpRelease(classified, "https://acme.example");
  assert.equal(release.manifest.tools[0]?.untrustedContent, true);
  const { artifact, tools } = await loadArtifact("https://acme.example", classified);
  await registerWithFetch(artifact, async () => Response.json([]));
  assert.equal(tools[0]?.annotations?.untrustedContentHint, true);
});

test("vetted get_order_status metadata cannot be downgraded by a caller", () => {
  const release = compileWebMcpRelease([{
    name: "get_order_status",
    description: "get order status",
    readOnly: true,
    untrustedContent: false
  }], "https://acme.example");
  assert.equal(release.manifest.tools[0]?.untrustedContent, true);
  assert.match(release.code, /"untrustedContent":true/);
});

test("generated runtime enforces allowedOrigin before registration and immediately before execution", async () => {
  const wrong = await loadArtifact("https://evil.example");
  assert.deepEqual(await wrong.artifact.registerPage2WebMCPTools(), { supported: false, reason: "ORIGIN_MISMATCH" });
  assert.equal(wrong.tools.length, 0);

  const right = await loadArtifact("https://acme.example");
  await registerWithFetch(right.artifact, async () => Response.json([]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://evil.example" } } });
  await assert.rejects(
    right.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }),
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
  const { artifact, tools } = await loadArtifact("https://acme.example", [{
    name: "get_order_status",
    description: "get order status",
    readOnly: true,
    untrustedContent: true
  }]);
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
  const result = await tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }) as Array<Record<string, unknown>>;
  assert.equal(Object.getPrototypeOf(result[0]!), null);
});

test("generated runtime returns typed safe errors for HTTP failures and oversized bodies", async () => {
  const http = await loadArtifact("https://acme.example");
  await registerWithFetch(http.artifact, async () => new Response("upstream secret", { status: 502 }));
  await assert.rejects(http.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), (error: unknown) => {
    assert.equal((error as { code: string }).code, "HTTP_ERROR");
    assert.doesNotMatch(String((error as Error).message), /upstream secret/);
    return true;
  });

  const large = await loadArtifact("https://acme.example");
  await registerWithFetch(large.artifact, async () => new Response("x".repeat(65_537)));
  await assert.rejects(large.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "RESPONSE_TOO_LARGE" });
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
  const result = await recovered.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }) as Array<Record<string, unknown>>;
  assert.equal(result[0]!.id, "ORD-4812");
  assert.equal(recoveredCalls, 2);

  const bounded = await loadArtifact("https://acme.example");
  let boundedCalls = 0;
  await registerWithFetch(bounded.artifact, async () => {
    boundedCalls += 1;
    return boundedCalls < 3 ? new Response("still unavailable", { status: 429 }) : Response.json([]);
  });
  await assert.rejects(bounded.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "HTTP_ERROR" });
  assert.equal(boundedCalls, 2);
});

test("generated requests do not retry authentication or other non-retryable 4xx responses", async () => {
  for (const status of [400, 401, 403, 409]) {
    const generated = await loadArtifact("https://acme.example");
    let calls = 0;
    await registerWithFetch(generated.artifact, async () => { calls += 1; return new Response("rejected", { status }); });
    await assert.rejects(generated.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "HTTP_ERROR" });
    assert.equal(calls, 1);
  }
});

test("generated final POST recovers a dropped response with the same idempotency and confirmation evidence", async () => {
  const generated = await loadArtifact("https://acme.example");
  let confirmCalls = 0;
  let evidenceCalls = 0;
  let ticketCalls = 0;
  const mutationHeaders: Headers[] = [];
  const committedTicket = { ticketId: "TCK-committed", status: "open", priority: "high", createdAt: "2026-08-29T00:00:00.000Z" };
  await registerWithFetch(generated.artifact, async (request, init) => {
    if (String(request).endsWith("/api/confirmations")) {
      evidenceCalls += 1;
      return Response.json({ evidence: "proof-once" }, { status: 201 });
    }
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
  assert.equal(evidenceCalls, 1);
  assert.equal(ticketCalls, 2);
  assert.equal(mutationHeaders[0]!.get("idempotency-key"), mutationHeaders[1]!.get("idempotency-key"));
  assert.equal(mutationHeaders[0]!.get("x-page2webmcp-confirmation"), "proof-once");
  assert.equal(mutationHeaders[1]!.get("x-page2webmcp-confirmation"), "proof-once");
});

test("generated mutation reuses its pending key across a timed-out execute and a separate invocation", async () => {
  const generated = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 15 });
  const mutationKeys: string[] = [];
  let confirmationCalls = 0;
  let mutationCalls = 0;
  const committedTicket = {
    ticketId: "TCK-ambiguous",
    status: "open",
    priority: "high",
    createdAt: "2026-08-29T00:00:00.000Z"
  };
  await registerWithFetch(generated.artifact, async (request, init) => {
    if (String(request).endsWith("/api/confirmations")) {
      confirmationCalls += 1;
      return Response.json({ evidence: `proof-${confirmationCalls}` }, { status: 201 });
    }
    mutationCalls += 1;
    mutationKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (mutationCalls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return Response.json(committedTicket, { status: 201 });
  }, { confirm: async () => true });
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
  let evidenceCalls = 0;
  let ticketCalls = 0;
  await registerWithFetch(generated.artifact, async (request) => {
    if (String(request).endsWith("/api/confirmations")) {
      evidenceCalls += 1;
      return Response.json({ evidence: "proof-once" }, { status: 201 });
    }
    ticketCalls += 1;
    return new Response("conflict", { status: 409 });
  }, { confirm: async () => true });
  const tool = generated.tools.find(({ name }) => name === "create_support_ticket")!;
  await assert.rejects(tool.execute(
    { orderId: "ORD-4812", title: "Conflicting ticket", priority: "high" },
    { signal: new AbortController().signal },
  ), { code: "HTTP_ERROR" });
  assert.equal(evidenceCalls, 1);
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
  await assert.rejects(generated.tools[0]!.execute(
    { query: "ORD-4812" },
    { signal: new AbortController().signal },
  ), { code: "DEADLINE_EXCEEDED" });
  assert.equal(calls, 2);
});

test("generated runtime applies a deadline and honors caller cancellation", async () => {
  const timeout = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 5 });
  await registerWithFetch(timeout.artifact, async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
  await assert.rejects(timeout.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "DEADLINE_EXCEEDED" });

  const cancelled = await loadArtifact("https://acme.example");
  await registerWithFetch(cancelled.artifact, async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
  const caller = new AbortController();
  const pending = cancelled.tools[0]!.execute({ query: "ORD-4812" }, { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
});

test("generated deadline includes response body consumption", async () => {
  const delayedBody = await loadArtifact("https://acme.example", capabilities, { deadlineMs: 5 });
  await registerWithFetch(delayedBody.artifact, async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    })));
  const execution = delayedBody.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal });
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
  })));
  await assert.rejects(large.tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal }), { code: "RESPONSE_TOO_LARGE" });
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
  await Promise.all([first, second]);
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
    if (url.endsWith("/api/confirmations")) return Response.json({ evidence: "proof-once" }, { status: 201 });
    return Response.json({ ticketId: "TCK-safe", status: "open", priority: "high", createdAt: "2026-08-29T00:00:00.000Z" }, { status: 201 });
  };

  const missing = await loadArtifact("https://acme.example");
  await registerWithFetch(missing.artifact, fakeFetch);
  const missingTool = missing.tools.find(({ name }) => name === "create_support_ticket")!;
  const input = { orderId: "ORD-4812", title: "Damaged parcel", priority: "high" };
  await assert.rejects(missingTool.execute(input, { signal: new AbortController().signal }), { code: "CONFIRMATION_REQUIRED" });

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
  assert.equal(requests.length, 2);
  const mutationHeaders = new Headers(requests[1]!.init?.headers);
  assert.equal(mutationHeaders.get("x-page2webmcp-confirmation"), "proof-once");
  assert.match(mutationHeaders.get("idempotency-key") ?? "", /^[0-9a-f-]{36}$/);
});

test("host confirmation bridge cannot replace fetch execution semantics", async () => {
  const originalFetch = globalThis.fetch;
  let platformCalls = 0;
  let injectedCalls = 0;
  globalThis.fetch = async () => { platformCalls += 1; return Response.json([]); };
  try {
    const { artifact, tools } = await loadArtifact("https://acme.example");
    await artifact.registerPage2WebMCPTools({ fetch: async () => { injectedCalls += 1; return Response.json([]); } } as unknown as Parameters<GeneratedArtifact["registerPage2WebMCPTools"]>[0]);
    await tools[0]!.execute({ query: "ORD-4812" }, { signal: new AbortController().signal });
    assert.equal(platformCalls, 1);
    assert.equal(injectedCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  assert.throws(() => compileWebMcpRelease([{ ...capabilities[0]!, requestPlan: { method: "GET", path: "https://evil.example/orders" } }], "https://acme.example"), /unsafe request path/i);
  assert.throws(() => compileWebMcpRelease([{ ...capabilities[0]!, requestPlan: { method: "DELETE", path: "/api/orders" } as unknown as CompilableCapability["requestPlan"] }], "https://acme.example"), /unsupported request method/i);
  assert.throws(() => compileWebMcpRelease([{ name: "lookup", description: "Generic lookup", readOnly: true }], "https://acme.example"), /vetted request plan/i);
  assert.throws(() => compileWebMcpRelease([{
    name: "get_mutation",
    description: "Mutation disguised as a GET",
    readOnly: false,
    requiresConfirmation: true,
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    requestPlan: { method: "GET", path: "/api/mutate" },
    outputSchema: { type: "boolean" },
  }], "https://acme.example"), /mutation must use POST/i);

  const inheritedProperties = Object.create({ constructor: { type: "string" } }) as Record<string, { type: "string" }>;
  assert.throws(() => compileWebMcpRelease([{
    name: "prototype_schema",
    description: "Schema with an inherited field",
    readOnly: true,
    inputSchema: { type: "object", properties: inheritedProperties, required: ["constructor"], additionalProperties: false },
    requestPlan: { method: "GET", path: "/api/lookup" },
    outputSchema: { type: "boolean" },
  }], "https://acme.example"), /invalid required fields/i);
});
