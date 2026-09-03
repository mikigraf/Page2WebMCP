import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CapabilityPlan } from "../../../../packages/capability-ir/src/plan.ts";
import { compileWebMcpRelease, type CompiledRelease } from "../../../../packages/compiler/src/compiler.ts";

export type TargetFixture = Readonly<{
  origin: string;
  release: CompiledRelease;
  servedBytes: string;
  createdTickets: readonly string[];
  mutationRequestCount: number;
  pageRequestCount: number;
  close(): Promise<void>;
}>;

export type TargetFixtureOptions = Readonly<{
  plans: (targetOrigin: string) => CapabilityPlan[];
  tamperServedBytes?: boolean;
  installCompatibilityShim?: boolean;
  registrationDelayMs?: number;
  start?: boolean;
}>;

const SESSION_COOKIE = "fixture_session=fixture-session-value";

/**
 * A minimal real target: it serves its own page and its own artifact over loopback HTTP and keeps
 * authoritative ticket state. Nothing here is a verifier harness; the verifier only navigates to it.
 */
export async function startTargetFixture(options: TargetFixtureOptions): Promise<TargetFixture> {
  const state = { tickets: [] as string[], mutations: 0, pageRequests: 0 };
  const served: { release?: CompiledRelease; bytes: string } = { bytes: "" };
  const server = createServer((request, response) => {
    handle(request, response, () => served.release!, () => served.bytes, state, options);
  });
  if (options.start === false) {
    return fixtureView("http://127.0.0.1:1", compileFor("http://127.0.0.1:1", options), "", state, server);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  served.release = compileFor(origin, options);
  served.bytes = options.tamperServedBytes ? `${served.release.code}\n// tampered\n` : served.release.code;
  return fixtureView(origin, served.release, served.bytes, state, server);
}

function compileFor(origin: string, options: TargetFixtureOptions): CompiledRelease {
  return compileWebMcpRelease(options.plans(origin));
}

function fixtureView(
  origin: string,
  release: CompiledRelease,
  servedBytes: string,
  state: { tickets: string[]; mutations: number; pageRequests: number },
  server: Server,
): TargetFixture {
  return {
    origin,
    release,
    servedBytes,
    get createdTickets() {
      return [...state.tickets];
    },
    get mutationRequestCount() {
      return state.mutations;
    },
    get pageRequestCount() {
      return state.pageRequests;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      if (!server.listening) resolve();
    }),
  };
}

function handle(
  request: IncomingMessage,
  response: ServerResponse,
  release: () => CompiledRelease,
  servedBytes: () => string,
  state: { tickets: string[]; mutations: number; pageRequests: number },
  options: TargetFixtureOptions,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const authenticated = (request.headers.cookie ?? "").includes(SESSION_COOKIE);
  if (url.pathname === "/") {
    send(response, 200, "text/html; charset=utf-8",
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>Fixture</title></head>"
      + "<body><h1>Fixture home</h1></body></html>");
    return;
  }
  if (url.pathname === "/support") {
    state.pageRequests += 1;
    send(response, 200, "text/html; charset=utf-8",
      supportPage(release(), options.installCompatibilityShim === true, options.registrationDelayMs ?? 0));
    return;
  }
  if (url.pathname === `/releases/${release().contentHash}.js`) {
    send(response, 200, "text/javascript; charset=utf-8", servedBytes());
    return;
  }
  if (url.pathname === "/api/orders" && request.method === "GET") {
    if (!authenticated) {
      send(response, 401, "application/json", JSON.stringify({ error: "LOGGED_OUT" }));
      return;
    }
    const latest = state.tickets.at(-1) ?? "no ticket";
    send(response, 200, "application/json", JSON.stringify([{ id: "ORD-4812", title: latest }]));
    return;
  }
  if (url.pathname === "/api/tickets" && request.method === "POST") {
    if (!authenticated) {
      send(response, 401, "application/json", JSON.stringify({ error: "LOGGED_OUT" }));
      return;
    }
    readBody(request).then((body) => {
      state.mutations += 1;
      const title = String((JSON.parse(body || "{}") as { title?: string }).title ?? "");
      state.tickets.push(title);
      send(response, 201, "application/json", JSON.stringify({ ticketId: `TCK-${state.tickets.length}`, status: "open" }));
    }).catch(() => send(response, 400, "application/json", JSON.stringify({ error: "VALIDATION_FAILED" })));
    return;
  }
  send(response, 404, "application/json", JSON.stringify({ error: "STALE_TARGET" }));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
    if (Buffer.concat(chunks).byteLength > 64 * 1024) throw new Error("BODY_TOO_LARGE");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

/**
 * The page registers its tools through the browser's own WebMCP surface. It installs a shim only
 * when a test explicitly asks for one, so the default page is what a real target looks like. An
 * optional per-tool delay reproduces a slow real registration (many capabilities, a slow native
 * implementation) without depending on real browser timing.
 */
function supportPage(release: CompiledRelease, installCompatibilityShim: boolean, registrationDelayMs: number): string {
  const shim = !installCompatibilityShim ? "" : `<script>
(() => {
  const tools = [];
  Object.defineProperty(document, "modelContext", { value: Object.freeze({
    registerTool: async (tool) => {
      if (${registrationDelayMs} > 0) await new Promise((resolve) => setTimeout(resolve, ${registrationDelayMs}));
      tools.push(tool);
    },
    getTools: async () => tools.slice(),
  }), configurable: false });
})();
</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture support</title>${shim}
<script type="module" src="/releases/${release.contentHash}.js" integrity="${release.integrity}"
  crossorigin="anonymous" data-page2webmcp-content-hash="${release.contentHash}"
  data-page2webmcp-target-origin="${release.allowedOrigin}"></script>
</head><body><h1>Fixture support desk</h1></body></html>`;
}
