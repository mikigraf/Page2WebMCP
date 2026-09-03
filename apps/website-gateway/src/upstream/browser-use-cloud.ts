import {
  BROWSER_USE_CLOUD_API_VERSION,
  BROWSER_USE_CLOUD_MODEL,
  browserUseCloudV4PolicyDigest,
  type BrowserUseCloudV4Request,
} from "../../../../packages/providers/src/browser-use-v4.ts";
import { MAX_CONTROL_BYTES, UPSTREAM_TIMEOUT_MS } from "../constants.ts";
import { isPlainRecord } from "../canonical.ts";
import type {
  BrowserUseStartedSession,
  BrowserUseUpstream,
  BrowserUseUpstreamAttestation,
} from "../dependencies.ts";

/**
 * Browser Use Cloud v4 paths. They are the single integration point an operator
 * must confirm against their account before this gateway can be trusted; the
 * live round trip is deliberately not covered by a stubbed test.
 */
export const BROWSER_USE_CLOUD_PATHS = Object.freeze({
  // Browser Use Cloud has no account route; a bounded sessions listing is the
  // cheapest authenticated v4 call and returns 401 for a bad key.
  credentials: "/api/v4/sessions?limit=1",
  // v4 "browsers" are the managed Chrome instances a client drives over CDP.
  browsers: "/api/v4/browsers",
  browser: (id: string) => `/api/v4/browsers/${encodeURIComponent(id)}`,
});

const MINUTE_MS = 60_000;
const MINIMUM_TIMEOUT_MINUTES = 1;
const ACTIVE_STATUS = "active";
const TERMINAL_STATUSES = Object.freeze(["stopped", "terminated", "finished", "failed", "cancelled", "timeout"]);

export class UpstreamError extends Error {
  constructor(code: string) { super(code); this.name = "UpstreamError"; }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CONTROL_BYTES)) {
    throw new UpstreamError("BROWSER_USE_UPSTREAM_RESPONSE_TOO_LARGE");
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_CONTROL_BYTES) throw new UpstreamError("BROWSER_USE_UPSTREAM_RESPONSE_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new UpstreamError("BROWSER_USE_UPSTREAM_RESPONSE_INVALID"); }
  if (!isPlainRecord(parsed)) throw new UpstreamError("BROWSER_USE_UPSTREAM_RESPONSE_INVALID");
  return parsed;
}

function pick(record: Record<string, unknown>, ...names: readonly string[]): string | undefined {
  for (const name of names) if (typeof record[name] === "string") return record[name] as string;
  return undefined;
}

/**
 * Maps the pinned Page2WebMCP session request onto the v4 browsers API. The
 * upstream only takes a minute timeout, an optional proxy country, a profile,
 * and metadata; the pinned allowlist and proxy policy are enforced by this
 * gateway's egress controls, and the policy digest is recorded as metadata so
 * the browser can be traced back to the exact request it was started for.
 */
function browserCreateBody(request: BrowserUseCloudV4Request, now: Date): Record<string, unknown> {
  const remainingMs = Date.parse(request.expiresAt) - now.getTime();
  if (!Number.isFinite(remainingMs)) throw new UpstreamError("BROWSER_USE_UPSTREAM_REQUEST_INVALID");
  const timeout = Math.max(MINIMUM_TIMEOUT_MINUTES, Math.ceil(remainingMs / MINUTE_MS));
  return {
    timeout,
    metadata: {
      page2webmcpPolicyDigest: browserUseCloudV4PolicyDigest(request),
      page2webmcpExpiresAt: request.expiresAt,
    },
  };
}

function cdpWebSocketUrl(cdpUrl: string | undefined): string | undefined {
  if (!cdpUrl) return undefined;
  let parsed: URL;
  try { parsed = new URL(cdpUrl); } catch { return undefined; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "wss:") return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  return `wss://${parsed.host}${parsed.pathname === "" ? "/" : parsed.pathname}`;
}

export function createBrowserUseCloudUpstream(
  origin: string,
  apiKey: string,
  dependencies: Readonly<{ fetch?: typeof fetch; clock?: () => Date }> = {},
): BrowserUseUpstream {
  const transport = dependencies.fetch ?? fetch;
  const clock = dependencies.clock ?? (() => new Date());
  const call = async (
    path: string,
    method: "GET" | "POST" | "PATCH",
    payload: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("BROWSER_USE_UPSTREAM_ABORTED"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("BROWSER_USE_UPSTREAM_TIMEOUT")), UPSTREAM_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await transport(`${origin}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "x-browser-use-api-key": apiKey,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new UpstreamError("BROWSER_USE_UPSTREAM_UNAUTHORIZED");
      }
      if (response.status < 200 || response.status > 299) {
        throw new UpstreamError("BROWSER_USE_UPSTREAM_REJECTED");
      }
      return await boundedJson(response);
    } catch (error) {
      // Upstream error text can carry account or session detail: it never escapes.
      throw error instanceof UpstreamError ? error : new UpstreamError("BROWSER_USE_UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };

  return {
    async verifyCredentials(signal): Promise<BrowserUseUpstreamAttestation> {
      const listing = await call(BROWSER_USE_CLOUD_PATHS.credentials, "GET", undefined, signal);
      if (!Array.isArray(listing.sessions)) throw new UpstreamError("BROWSER_USE_UPSTREAM_RESPONSE_INVALID");
      return {
        apiVersion: BROWSER_USE_CLOUD_API_VERSION,
        authenticated: true,
        model: BROWSER_USE_CLOUD_MODEL,
      };
    },
    async startSession(request: BrowserUseCloudV4Request, signal): Promise<BrowserUseStartedSession> {
      const created = await call(BROWSER_USE_CLOUD_PATHS.browsers, "POST", browserCreateBody(request, clock()), signal);
      const providerSessionId = pick(created, "id");
      const liveUrl = pick(created, "liveUrl", "live_url");
      const cdpUrl = cdpWebSocketUrl(pick(created, "cdpUrl", "cdp_url"));
      if (!providerSessionId || pick(created, "status") !== ACTIVE_STATUS
        || !liveUrl?.startsWith("https://") || !cdpUrl) {
        throw new UpstreamError("BROWSER_USE_UPSTREAM_RESPONSE_INVALID");
      }
      return { providerSessionId, liveUrl, cdpUrl };
    },
    async stopSession(providerSessionId, _reason, signal): Promise<void> {
      // v4 has a single stop action; the Page2WebMCP reason stays in gateway evidence.
      await call(BROWSER_USE_CLOUD_PATHS.browser(providerSessionId), "PATCH", { action: "stop" }, signal);
    },
    async reconcileSession(providerSessionId, signal): Promise<Readonly<{ terminated: true }>> {
      const state = await call(BROWSER_USE_CLOUD_PATHS.browser(providerSessionId), "GET", undefined, signal);
      const status = pick(state, "status", "state");
      if (!status || !TERMINAL_STATUSES.includes(status.toLowerCase())) {
        throw new UpstreamError("BROWSER_USE_UPSTREAM_TERMINATION_UNPROVEN");
      }
      return { terminated: true };
    },
  };
}
