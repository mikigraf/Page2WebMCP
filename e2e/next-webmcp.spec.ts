import { expect, test } from "@playwright/test";

type RegisteredGeneratedTool = {
  name: string;
  execute: (input: Record<string, string>, context: { signal: AbortSignal }) => Promise<unknown>;
};

test("registered WebMCP tools drive an authenticated low-risk fixture workflow", async ({ page, request, context }) => {
  const login = await request.post("/api/auth/login", { data: { email: "agent@example.test", password: "fixture-password" } });
  const cookie = login.headers()["set-cookie"]?.match(/acme_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  await context.addCookies([{ name: "acme_session", value: cookie!, url: "http://127.0.0.1:3200", httpOnly: true }]);
  await page.addInitScript(() => {
    const tools: Array<{ name: string }> = [];
    Object.defineProperty(document, "modelContext", { value: {
      registerTool: async (tool: { name: string }, options: { signal: AbortSignal }) => {
        tools.push(tool);
        options.signal.addEventListener("abort", () => {
          const index = tools.indexOf(tool);
          if (index >= 0) tools.splice(index, 1);
        }, { once: true });
      },
      getTools: async () => tools
    } });
  });
  await page.goto("/orders/ORD-4812");
  await expect.poll(() => page.evaluate(async () => ((document as Document & { modelContext: { getTools: () => Promise<Array<{ name: string }>> } }).modelContext.getTools()).then((tools) => tools.map((tool) => tool.name).sort()))).toEqual(["create_support_ticket", "find_order", "get_order_status"]);
  await page.getByLabel("Ticket title").fill("TEST browser ticket");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByLabel("Tickets").getByText("TEST browser ticket", { exact: true })).toBeVisible();
});

test("the immutable compiled release installs and executes against the fixture origin", async ({ page, request, context }) => {
  const login = await request.post("/api/auth/login", { data: { email: "agent@example.test", password: "fixture-password" } });
  const cookie = login.headers()["set-cookie"]?.match(/acme_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  await context.addCookies([{ name: "acme_session", value: cookie!, url: "http://127.0.0.1:3200", httpOnly: true }]);
  await page.addInitScript(() => {
    const tools: RegisteredGeneratedTool[] = [];
    Object.defineProperty(document, "modelContext", { value: {
      registerTool: async (tool: RegisteredGeneratedTool, options: { signal: AbortSignal }) => {
        tools.push(tool);
        options.signal.addEventListener("abort", () => tools.splice(tools.indexOf(tool), 1), { once: true });
      },
      getTools: async () => tools
    } });
  });
  await page.goto("/orders/ORD-4812");
  const result = await page.evaluate(async () => {
    const source = await fetch("/api/releases/acme").then((response) => response.text());
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const artifact = await import(/* webpackIgnore: true */ url) as {
      registerPage2WebMCPTools: (execute: (name: string, input: Record<string, string>, signal: AbortSignal) => Promise<unknown>) => Promise<void>;
      executeSameOrigin: (path: string, init?: RequestInit) => Promise<unknown>;
    };
    await artifact.registerPage2WebMCPTools((name, input, signal) => {
      if (name !== "find_order") throw new Error("unexpected generated tool execution");
      return artifact.executeSameOrigin(`/api/orders?q=${encodeURIComponent(input.query)}`, { signal });
    });
    const modelContext = (document as Document & { modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> } }).modelContext;
    const tool = (await modelContext.getTools()).find((candidate) => candidate.name === "find_order");
    return tool?.execute({ query: "ORD-4812" }, { signal: new AbortController().signal });
  });
  expect(result).toEqual([{ id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" }]);
});

test("the installed generated R1 tool creates a ticket and the fixture UI reflects it", async ({ page, request, context }) => {
  const login = await request.post("/api/auth/login", { data: { email: "agent@example.test", password: "fixture-password" } });
  const cookie = login.headers()["set-cookie"]?.match(/acme_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  await context.addCookies([{ name: "acme_session", value: cookie!, url: "http://127.0.0.1:3200", httpOnly: true }]);
  await page.addInitScript(() => {
    const tools: RegisteredGeneratedTool[] = [];
    Object.defineProperty(document, "modelContext", { value: { registerTool: async (tool: RegisteredGeneratedTool) => tools.push(tool), getTools: async () => tools } });
  });
  await page.goto("/orders/ORD-4812");
  await page.evaluate(async () => {
    const source = await fetch("/api/releases/acme").then((response) => response.text());
    const artifact = await import(/* webpackIgnore: true */ URL.createObjectURL(new Blob([source], { type: "text/javascript" }))) as {
      registerPage2WebMCPTools: (execute: (name: string, input: Record<string, string>, signal: AbortSignal, options: { requiresConfirmation: boolean }) => Promise<unknown>) => Promise<void>;
      executeSameOrigin: (path: string, init?: RequestInit) => Promise<unknown>;
    };
    await artifact.registerPage2WebMCPTools((name, input, signal, options) => {
      if (name !== "create_support_ticket" || !options.requiresConfirmation) throw new Error("R1 confirmation metadata is required");
      return artifact.executeSameOrigin("/api/tickets", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    });
    const modelContext = (document as Document & { modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> } }).modelContext;
    const tool = (await modelContext.getTools()).find((candidate) => candidate.name === "create_support_ticket");
    await tool?.execute({ orderId: "ORD-4812", title: "TEST generated ticket", priority: "high" }, { signal: new AbortController().signal });
  });
  await page.reload();
  await expect(page.getByText("TEST generated ticket")).toBeVisible();
});
