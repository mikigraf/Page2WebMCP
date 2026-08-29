import { createHash, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { ACME_URL, CONTROL_PLANE_OWNER_PASSWORD, CONTROL_PLANE_URL } from "./urls.ts";

type RegisteredGeneratedTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<unknown>;
};

test("the exact reviewed and published bytes execute on the allowed Acme origin", async ({ page, request, context }) => {
  const controlCookie = await loginControlPlane(request);
  const project = await controlPost<{ id: string }>(request, controlCookie, "/api/projects", {
    sourceType: "website",
    url: "https://acme.example"
  });
  const accepted = await controlPost<{ runId: string }>(request, controlCookie, "/api/projects/analyze", {
    projectId: project.id
  });
  const analysis = await waitForAnalysis(request, controlCookie, accepted.runId);
  const ticket = analysis.capabilities.find((capability) => capability.stableName === "create_support_ticket");
  expect(ticket).toBeTruthy();
  const reviewed = await request.post(
    `${CONTROL_PLANE_URL}/api/capabilities/${ticket!.id}/review`,
    {
      headers: controlHeaders(controlCookie),
      data: { action: "approve", expectedVersion: ticket!.version }
    }
  );
  expect(reviewed.status()).toBe(200);

  const published = await controlPost<{ release: { contentHash: string; sri: string; url: string } }>(
    request,
    controlCookie,
    `/api/projects/${project.id}/releases`,
    { analysisRunId: accepted.runId }
  );
  const artifactResponse = await request.get(`${CONTROL_PLANE_URL}${published.release.url}`);
  expect(artifactResponse.status()).toBe(200);
  const artifact = await artifactResponse.text();
  const digest = createHash("sha256").update(artifact).digest();
  expect(digest.toString("hex")).toBe(published.release.contentHash);
  expect(`sha256-${digest.toString("base64")}`).toBe(published.release.sri);
  expect(artifactResponse.headers()["x-page2webmcp-integrity"]).toBe(published.release.sri);
  expect(artifactResponse.headers()["access-control-allow-origin"]).toBe("https://acme.example");
  expect(artifactResponse.headers()["cross-origin-resource-policy"]).toBe("cross-origin");

  const acmeSession = await loginAcme(request);
  await context.addCookies([{
    name: "acme_session",
    value: acmeSession,
    domain: "acme.example",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Strict"
  }]);
  await installModelContext(page);
  await page.route("https://acme.example/**", (route) => proxyAcme(route, artifact, published.release));

  await page.goto("https://acme.example/published-release-harness");
  await expect.poll(async () => {
    const diagnostics = await page.evaluate(() => (
      window as Window & { __page2webmcpDiagnostics?: unknown[] }
    ).__page2webmcpDiagnostics ?? []);
    if (diagnostics.length > 0) return `diagnostic:${JSON.stringify(diagnostics)}`;
    return (await registeredTools(page)).join(",");
  }).toBe("create_support_ticket,find_order,get_order_status");
  await expect.poll(() => registeredToolAnnotations(page, "get_order_status"))
    .toEqual({ readOnlyHint: true, untrustedContentHint: true });
  const statusRequests: string[] = [];
  page.on("request", (outbound) => {
    const target = new URL(outbound.url());
    if (target.hostname === "acme.example" && target.pathname.startsWith("/api/orders/")) {
      statusRequests.push(target.pathname);
    }
  });
  await expect(executeToolFailureCode(page, "get_order_status", { query: "x".repeat(64) }))
    .resolves.toBe("HTTP_ERROR");
  await expect.poll(() => statusRequests).toContain(`/api/orders/${"x".repeat(64)}`);
  const requestsAtBoundary = statusRequests.length;
  await expect(executeToolFailureCode(page, "get_order_status", { query: "x".repeat(65) }))
    .resolves.toBe("INVALID_INPUT");
  expect(statusRequests).toHaveLength(requestsAtBoundary);
  await expect(executeTool(page, "find_order", { query: "ORD-4812" })).resolves.toEqual([
    { id: "ORD-4812", email: "customer@example.test", shipmentStatus: "delayed" }
  ]);

  const title = `TEST published release ${randomUUID()}`;
  page.once("dialog", (dialog) => dialog.accept());
  const created = await executeTool(page, "create_support_ticket", {
    orderId: "ORD-4812",
    title,
    priority: "high"
  }) as { ticketId: string };
  expect(created.ticketId).toMatch(/^TCK-/);
  const tickets = await page.evaluate(async () => {
    const response = await fetch("/api/tickets?orderId=ORD-4812", { credentials: "same-origin" });
    if (!response.ok) throw new Error(`ticket lookup failed: ${response.status}`);
    return response.json() as Promise<Array<{ title: string }>>;
  });
  expect(tickets.some((item) => item.title === title)).toBe(true);
});

async function loginControlPlane(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${CONTROL_PLANE_URL}/api/auth/login`, {
    headers: { origin: CONTROL_PLANE_URL, "sec-fetch-site": "same-origin" },
    data: { email: "owner@example.test", password: CONTROL_PLANE_OWNER_PASSWORD }
  });
  const responseBody = await response.text();
  expect(response.status(), responseBody).toBe(200);
  const token = response.headers()["set-cookie"]?.match(/page2webmcp_session=([^;]+)/)?.[1];
  expect(token).toBeTruthy();
  return `page2webmcp_session=${token}`;
}

async function loginAcme(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${ACME_URL}/api/auth/login`, {
    headers: { origin: ACME_URL, "sec-fetch-site": "same-origin" },
    data: { email: "agent@example.test", password: "fixture-password" }
  });
  expect(response.status()).toBe(200);
  const token = response.headers()["set-cookie"]?.match(/acme_session=([^;]+)/)?.[1];
  expect(token).toBeTruthy();
  return token!;
}

async function controlPost<T>(
  request: APIRequestContext,
  cookie: string,
  path: string,
  data: unknown
): Promise<T> {
  const response = await request.post(`${CONTROL_PLANE_URL}${path}`, {
    headers: { ...controlHeaders(cookie), "idempotency-key": randomUUID() },
    data
  });
  expect(response.status(), await response.text()).toBeGreaterThanOrEqual(200);
  expect(response.status()).toBeLessThan(300);
  return response.json() as Promise<T>;
}

function controlHeaders(cookie: string) {
  return { cookie, origin: CONTROL_PLANE_URL, "sec-fetch-site": "same-origin" };
}

async function waitForAnalysis(request: APIRequestContext, cookie: string, runId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await request.get(`${CONTROL_PLANE_URL}/api/analysis-runs/${runId}`, {
      headers: { cookie }
    });
    expect(response.status()).toBe(200);
    const body = await response.json() as {
      run: { status: string; errorCode?: string };
      capabilities: Array<{ id: string; stableName: string; version: number }>;
    };
    if (body.run.status === "succeeded") return body;
    if (body.run.status === "failed" || body.run.status === "cancelled") throw new Error(body.run.errorCode ?? "ANALYSIS_FAILED");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("ANALYSIS_POLL_TIMEOUT");
}

async function proxyAcme(
  route: Route,
  artifact: string,
  release: { contentHash: string; sri: string }
): Promise<void> {
  const logicalUrl = new URL(route.request().url());
  if (logicalUrl.pathname === "/published-release-harness") {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><main>Published release harness</main><script type="module">
        import { registerPage2WebMCPTools } from "/published-release.js";
        const report = (detail) => window.dispatchEvent(new CustomEvent("page2webmcp:diagnostic", { detail }));
        await registerPage2WebMCPTools({
          confirm: () => window.confirm("Confirm generated mutation"),
          onDiagnostic: report
        });
      </script></body></html>`
    });
    return;
  }
  if (logicalUrl.pathname === "/published-release.js") {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: artifact,
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "cross-origin-resource-policy": "cross-origin",
        "x-page2webmcp-content-hash": release.contentHash,
        "x-page2webmcp-integrity": release.sri
      }
    });
    return;
  }
  const headers: Record<string, string> = { ...route.request().headers(), origin: ACME_URL };
  delete headers.host;
  delete headers["content-length"];
  const response = await route.fetch({
    url: `${ACME_URL}${logicalUrl.pathname}${logicalUrl.search}`,
    headers
  });
  await route.fulfill({ response });
}

async function installModelContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tools: RegisteredGeneratedTool[] = [];
    const diagnostics: unknown[] = [];
    Object.defineProperty(window, "__page2webmcpDiagnostics", { value: diagnostics });
    window.addEventListener("page2webmcp:diagnostic", (event) => {
      diagnostics.push((event as CustomEvent).detail);
    });
    Object.defineProperty(document, "modelContext", { value: {
      registerTool: async (tool: RegisteredGeneratedTool, options: { signal: AbortSignal }) => {
        if (tools.some((candidate) => candidate.name === tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
        tools.push(tool);
        options.signal.addEventListener("abort", () => {
          const index = tools.indexOf(tool);
          if (index >= 0) tools.splice(index, 1);
        }, { once: true });
      },
      getTools: async () => tools
    } });
  });
}

async function registeredTools(page: Page): Promise<string[]> {
  return page.evaluate(async () => (
    (document as Document & { modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> } })
      .modelContext.getTools()
  ).then((tools) => tools.map((tool) => tool.name).sort()));
}

async function registeredToolAnnotations(
  page: Page,
  name: string
): Promise<RegisteredGeneratedTool["annotations"]> {
  return page.evaluate(async (toolName) => {
    const tools = await (document as Document & {
      modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> };
    }).modelContext.getTools();
    return tools.find((tool) => tool.name === toolName)?.annotations;
  }, name);
}

async function executeTool(page: Page, name: string, input: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(async ({ name, input }) => {
    const tools = await (document as Document & {
      modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> };
    }).modelContext.getTools();
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool: ${name}`);
    return tool.execute(input, { signal: new AbortController().signal });
  }, { name, input });
}

async function executeToolFailureCode(page: Page, name: string, input: Record<string, unknown>): Promise<string> {
  return page.evaluate(async ({ name, input }) => {
    const tools = await (document as Document & {
      modelContext: { getTools: () => Promise<RegisteredGeneratedTool[]> };
    }).modelContext.getTools();
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool: ${name}`);
    try {
      await tool.execute(input, { signal: new AbortController().signal });
      return "NO_ERROR";
    } catch (error) {
      return String((error as { code?: unknown }).code ?? "UNKNOWN");
    }
  }, { name, input });
}
