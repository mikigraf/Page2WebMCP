import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AcmeError, AcmeSupport } from "./app.ts";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let value = "";
  for await (const chunk of request) value += chunk;
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}

function session(request: IncomingMessage): string {
  return request.headers.cookie?.match(/acme_session=([^;]+)/)?.[1] ?? "";
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function startAcmeServer() {
  const app = new AcmeSupport();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/openapi.json") return json(response, 200, app.openApiDocument());
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const input = await body(request);
        const value = app.login(String(input.email), String(input.password));
        response.setHeader("set-cookie", `acme_session=${value}; HttpOnly; SameSite=Strict`);
        return json(response, 200, { authenticated: true });
      }
      if (request.method === "GET" && url.pathname === "/api/orders") return json(response, 200, app.searchOrders(session(request), url.searchParams.get("q") ?? ""));
      if (request.method === "GET" && /^\/api\/orders\/[A-Z0-9-]+$/.test(url.pathname)) return json(response, 200, app.getOrderStatus(session(request), url.pathname.split("/").at(-1) ?? ""));
      if (request.method === "POST" && url.pathname === "/api/tickets") return json(response, 201, app.createTicket(session(request), await body(request) as { orderId: string; title: string; priority: "low" | "medium" | "high" }));
      if (request.method === "DELETE" && url.pathname === "/api/account") return app.deleteAccount(session(request));
      return json(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      const code = error instanceof AcmeError ? error.code : "INTERNAL_ERROR";
      const status = code === "AUTH_REQUIRED" ? 401 : code === "HIGH_RISK_ACTION" ? 403 : code === "NOT_FOUND" ? 404 : 400;
      return json(response, status, { code });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
