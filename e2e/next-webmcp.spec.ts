import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ACME_URL } from "./urls.ts";

type RegisteredGeneratedTool = {
  name: string;
  execute: (input: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<unknown>;
};

async function authenticate(request: APIRequestContext, context: BrowserContext): Promise<void> {
  const login = await request.post("/api/auth/login", {
    data: { email: "agent@example.test", password: "fixture-password" },
    headers: { origin: ACME_URL },
  });
  const cookie = login.headers()["set-cookie"]?.match(/acme_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();
  await context.addCookies([{ name: "acme_session", value: cookie!, url: ACME_URL, httpOnly: true }]);
}

async function installModelContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools: RegisteredGeneratedTool[] = [];
    Object.defineProperty(document, "modelContext", { value: {
      registerTool: async (tool: RegisteredGeneratedTool, options: { signal: AbortSignal }) => {
        if (tools.some((candidate) => candidate.name === tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
        tools.push(tool);
        options.signal.addEventListener("abort", () => {
          const index = tools.indexOf(tool);
          if (index >= 0) tools.splice(index, 1);
        }, { once: true });
      },
      getTools: async () => tools,
    } });
  });
}

async function tools(page: Page): Promise<string[]> {
  return page.evaluate(async () => ((document as Document & { modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> } }).modelContext.getTools()).then((registered) => registered.map((tool) => tool.name).sort()));
}

async function executeTool(page: Page, name: string, input: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async ({ name, input }) => {
    const registered = await (document as Document & { modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> } }).modelContext.getTools();
    const tool = registered.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool: ${name}`);
    return tool.execute(input, { signal: new AbortController().signal });
  }, { name, input });
}

async function executeToolError(page: Page, name: string, input: Record<string, unknown>): Promise<{ code?: string; message?: string }> {
  return page.evaluate(async ({ name, input }) => {
    const registered = await (document as Document & { modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> } }).modelContext.getTools();
    const tool = registered.find((candidate) => candidate.name === name);
    if (!tool) return { message: `missing tool: ${name}` };
    try {
      await tool.execute(input, { signal: new AbortController().signal });
      return {};
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    }
  }, { name, input });
}

test.beforeEach(async ({ page, request, context }) => {
  await authenticate(request, context);
  await installModelContext(page);
});

test("the generated artifact is the single idempotent registration path and executes its vetted read plan", async ({ page }) => {
  const initial = await page.goto("/orders/ORD-4812");
  expect(initial?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect.poll(() => tools(page)).toEqual(["create_support_ticket", "find_order", "get_order_status"]);
  await page.goto("/orders");
  await expect.poll(() => tools(page)).toEqual(["create_support_ticket", "find_order", "get_order_status"]);
  await expect(executeTool(page, "find_order", { query: "ORD-4812" })).resolves.toEqual([
    { id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" },
  ]);
});

test("the generated browser runtime rejects malformed input and surfaces safe HTTP errors", async ({ page }) => {
  await page.goto("/orders/ORD-4812");
  await expect.poll(() => tools(page)).toHaveLength(3);
  const malformed = await executeToolError(page, "find_order", { query: "ORD-4812", injected: true });
  expect(malformed).toEqual({ code: "INVALID_INPUT", message: "The tool input is invalid." });

  await page.route("**/api/orders?**", (route) => route.fulfill({ status: 502, body: "private upstream details" }));
  const failed = await executeToolError(page, "find_order", { query: "ORD-4812" });
  expect(failed).toEqual({ code: "HTTP_ERROR", message: "The tool request failed." });
});

test("the UI requires explicit confirmation and renders the ticket returned by the server", async ({ page }) => {
  await page.goto("/orders/ORD-4812");
  let prompt = "";
  page.once("dialog", async (dialog) => { prompt = dialog.message(); await dialog.accept(); });
  await page.getByLabel("Ticket title").fill("TEST browser returned ticket");
  await page.getByRole("button", { name: "Create ticket" }).click();
  expect(prompt).toContain("TEST browser returned ticket");
  const ticket = page.getByLabel("Tickets").getByRole("listitem").filter({ hasText: "TEST browser returned ticket" });
  await expect(ticket).toContainText(/TCK-[A-Za-z0-9_-]+/);
  await expect(ticket).not.toContainText("local-");
});

test("the UI recovers a committed ticket after a dropped response with one same-key replay", async ({ page }) => {
  let releaseDroppedResponse!: () => void;
  let markCommitted!: () => void;
  const droppedResponse = new Promise<void>((resolve) => { releaseDroppedResponse = resolve; });
  const committed = new Promise<void>((resolve) => { markCommitted = resolve; });
  const mutationHeaders: Array<{ idempotencyKey?: string; evidence?: string }> = [];
  let committedTicketId = "";
  let attempts = 0;
  await page.route("**/api/tickets", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    const headers = route.request().headers();
    mutationHeaders.push({ idempotencyKey: headers["idempotency-key"], evidence: headers["x-page2webmcp-confirmation"] });
    if (attempts === 1) {
      const response = await route.fetch();
      committedTicketId = ((await response.json()) as { ticketId: string }).ticketId;
      markCommitted();
      await droppedResponse;
      return route.abort("failed");
    }
    return route.continue();
  });

  await page.goto("/orders/ORD-4812");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Ticket title").fill("TEST recovered committed ticket");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await committed;
  await expect(page.getByRole("button", { name: "Create ticket" })).toBeDisabled();
  releaseDroppedResponse();

  const ticket = page.getByLabel("Tickets").getByRole("listitem").filter({ hasText: "TEST recovered committed ticket" });
  await expect(ticket).toContainText(committedTicketId);
  expect(attempts).toBe(2);
  expect(mutationHeaders[0]?.idempotencyKey).toBeTruthy();
  expect(mutationHeaders[1]?.idempotencyKey).toBe(mutationHeaders[0]?.idempotencyKey);
  expect(mutationHeaders[1]?.evidence).toBe(mutationHeaders[0]?.evidence);
});

test("the UI reuses a pending key on a separate submit after both committed responses are lost", async ({ page }) => {
  const mutationKeys: string[] = [];
  const evidenceValues: string[] = [];
  let committedTicketId = "";
  let attempts = 0;
  await page.route("**/api/tickets", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    const headers = route.request().headers();
    mutationKeys.push(headers["idempotency-key"] ?? "");
    evidenceValues.push(headers["x-page2webmcp-confirmation"] ?? "");
    if (attempts <= 2) {
      const response = await route.fetch();
      committedTicketId ||= ((await response.json()) as { ticketId: string }).ticketId;
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });

  await page.goto("/orders/ORD-4812");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Ticket title").fill("TEST separate submit recovery");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByText("Ticket failed")).toBeVisible();
  await page.getByRole("button", { name: "Create ticket" }).click();

  const ticket = page.getByLabel("Tickets").getByRole("listitem").filter({ hasText: "TEST separate submit recovery" });
  await expect(ticket).toContainText(committedTicketId);
  expect(attempts).toBe(3);
  expect(new Set(mutationKeys).size).toBe(1);
  expect(evidenceValues[1]).toBe(evidenceValues[0]);
  expect(evidenceValues[2]).not.toBe("");
});

test("the UI bounds a stalled ticket request with cancellation", async ({ page }) => {
  await page.goto("/orders/ORD-4812");
  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetTimeout(handler, timeout === 15_000 ? 0 : timeout, ...args)) as typeof window.setTimeout;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/tickets" && init?.method === "POST") {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return nativeFetch(input, init);
    }) as typeof window.fetch;
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Ticket title").fill("TEST timed out ticket");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByText("Ticket failed")).toBeVisible({ timeout: 1_000 });
});

test("the generated R1 tool fails closed when declined and creates only after explicit approval", async ({ page }) => {
  await page.goto("/orders/ORD-4812");
  await expect.poll(() => tools(page)).toHaveLength(3);
  const input = { orderId: "ORD-4812", title: "TEST generated confirmed ticket", priority: "high" };

  page.once("dialog", (dialog) => dialog.dismiss());
  const declined = await executeToolError(page, "create_support_ticket", input);
  expect(declined.code).toBe("CONFIRMATION_DECLINED");

  page.once("dialog", (dialog) => dialog.accept());
  const created = await executeTool(page, "create_support_ticket", input) as { ticketId: string };
  expect(created.ticketId).toMatch(/^TCK-/);
  await page.reload();
  await expect(page.getByText("TEST generated confirmed ticket")).toBeVisible();
});
