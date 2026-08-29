import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { AcmeError, AcmeSupport, acmeErrorStatus, normalizeLoginInput } from "./app.ts";

const MAX_REQUEST_BYTES = 16_384;

async function body(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new AcmeError("PAYLOAD_TOO_LARGE");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new AcmeError("PAYLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) throw new Error("empty");
    return JSON.parse(text) as unknown;
  } catch {
    throw new AcmeError("INVALID_JSON");
  }
}

function session(request: IncomingMessage): string {
  return request.headers.cookie?.match(/(?:^|;\s*)acme_session=([^;]+)/)?.[1] ?? "";
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function requireSameOrigin(request: IncomingMessage): void {
  const origin = header(request, "origin");
  const host = header(request, "host");
  if (!origin || !host || origin !== `http://${host}`) throw new AcmeError("ORIGIN_MISMATCH");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function startAcmeServer(app = new AcmeSupport()) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/openapi.json") return json(response, 200, app.openApiDocument());
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        requireSameOrigin(request);
        const input = normalizeLoginInput(await body(request));
        const value = app.login(input.email, input.password);
        response.setHeader("set-cookie", `acme_session=${value}; Max-Age=1800; Path=/; HttpOnly; Secure; SameSite=Strict; Priority=High`);
        return json(response, 200, { authenticated: true });
      }
      if (request.method === "GET" && url.pathname === "/api/orders") return json(response, 200, app.searchOrders(session(request), url.searchParams.get("q") ?? ""));
      if (request.method === "GET" && /^\/api\/orders\/[A-Z0-9-]+$/.test(url.pathname)) return json(response, 200, app.getOrderStatus(session(request), url.pathname.split("/").at(-1) ?? ""));
      if (request.method === "POST" && url.pathname === "/api/confirmations") {
        requireSameOrigin(request);
        return json(response, 201, { evidence: app.issueConfirmation(session(request), await body(request)) });
      }
      if (request.method === "POST" && url.pathname === "/api/tickets") {
        requireSameOrigin(request);
        const result = app.createTicket(
          session(request),
          await body(request),
          header(request, "idempotency-key"),
          header(request, "x-page2webmcp-confirmation"),
        );
        return json(response, 201, result);
      }
      if (request.method === "DELETE" && url.pathname === "/api/account") return app.deleteAccount(session(request));
      return json(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      const code = error instanceof AcmeError ? error.code : "INTERNAL_ERROR";
      return json(response, acmeErrorStatus(code), { code });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
