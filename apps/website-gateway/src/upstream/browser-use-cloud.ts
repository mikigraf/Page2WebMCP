import {
  BROWSER_USE_CLOUD_API_VERSION,
  BROWSER_USE_CLOUD_MODEL,
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
  me: "/api/v4/me",
  sessions: "/api/v4/sessions",
  session: (id: string) => `/api/v4/sessions/${encodeURIComponent(id)}`,
  stop: (id: string) => `/api/v4/sessions/${encodeURIComponent(id)}/stop`,
});

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

export function createBrowserUseCloudUpstream(origin: string, apiKey: string): BrowserUseUpstream {
  const call = async (
    path: string,
    method: "GET" | "POST",
    payload: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("BROWSER_USE_UPSTREAM_ABORTED"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("BROWSER_USE_UPSTREAM_TIMEOUT")), UPSTREAM_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(`${origin}${path}`, {
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
      await call(BROWSER_USE_CLOUD_PATHS.me, "GET", undefined, signal);
      return {
        apiVersion: BROWSER_USE_CLOUD_API_VERSION,
        authenticated: true,
        model: BROWSER_USE_CLOUD_MODEL,
      };
    },
    async startSession(request: BrowserUseCloudV4Request, signal): Promise<BrowserUseStartedSession> {
      const created = await call(BROWSER_USE_CLOUD_PATHS.sessions, "POST", request, signal);
      const providerSessionId = pick(created, "id", "sessionId", "session_id");
      const liveUrl = pick(created, "liveUrl", "live_url");
      const cdpUrl = pick(created, "cdpUrl", "cdp_url");
      if (!providerSessionId || !liveUrl?.startsWith("https://") || !cdpUrl?.startsWith("wss://")) {
        throw new UpstreamError("BROWSER_USE_UPSTREAM_RESPONSE_INVALID");
      }
      return { providerSessionId, liveUrl, cdpUrl };
    },
    async stopSession(providerSessionId, reason, signal): Promise<void> {
      await call(BROWSER_USE_CLOUD_PATHS.stop(providerSessionId), "POST", { reason }, signal);
    },
    async reconcileSession(providerSessionId, signal): Promise<Readonly<{ terminated: true }>> {
      const state = await call(BROWSER_USE_CLOUD_PATHS.session(providerSessionId), "GET", undefined, signal);
      const status = pick(state, "status", "state");
      if (!status || !["stopped", "terminated", "finished", "failed", "cancelled"].includes(status.toLowerCase())) {
        throw new UpstreamError("BROWSER_USE_UPSTREAM_TERMINATION_UNPROVEN");
      }
      return { terminated: true };
    },
  };
}
