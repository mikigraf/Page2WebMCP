import type { WebsiteObservationInput } from "../../../../packages/providers/src/website-evidence.ts";
import type {
  AuthenticationObserver,
  AuthenticationObserverInput,
  CdpObserver,
  CdpObserverInput,
} from "../dependencies.ts";
import type { AuthenticationSignal } from "../stores/checkpoints.ts";
import { ALLOWED_AUTH_SIGNALS } from "../constants.ts";
import { CdpError, connectCdpSession, type CdpSession } from "./cdp-session.ts";
import { WEBSITE_PROBE_SCRIPT } from "./probe.ts";

const MAX_BLOCKED = 100;
const LOAD_TIMEOUT_MS = 20_000;

type ProbeResult = Readonly<{
  signals: readonly string[];
  signIn: boolean;
  forms: readonly Readonly<{
    action: string;
    label: string;
    controls: readonly Readonly<{ name: string; required: boolean }>[];
  }>[];
  url: string;
  origin: string;
}>;

type BlockedMutation = Readonly<{ method: string; path: string; reason: string }>;

async function attachedPage(session: CdpSession): Promise<string> {
  const targets = await session.send("Target.getTargets");
  const list = Array.isArray(targets.targetInfos) ? targets.targetInfos as Record<string, unknown>[] : [];
  const page = list.find((target) => target.type === "page" && typeof target.targetId === "string");
  if (!page) throw new CdpError("CDP_PAGE_TARGET_MISSING");
  const attached = await session.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  if (typeof attached.sessionId !== "string") throw new CdpError("CDP_ATTACH_FAILED");
  return attached.sessionId;
}

/**
 * Installs the deny-by-default interception before any navigation happens and
 * keeps it installed for the whole observation, so every request the page makes
 * passes through `allow` before it can leave the browser.
 */
function installRouteGate(
  session: CdpSession,
  pageSession: string,
  allow: (method: string, url: string) => boolean,
  blocked: BlockedMutation[],
): void {
  session.on("Fetch.requestPaused", (parameters, sessionId) => {
    if (sessionId !== pageSession) return;
    const requestId = parameters.requestId;
    const request = parameters.request as Record<string, unknown> | undefined;
    const method = typeof request?.method === "string" ? request.method : "GET";
    const url = typeof request?.url === "string" ? request.url : "";
    if (typeof requestId !== "string") return;
    if (allow(method, url)) {
      void session.send("Fetch.continueRequest", { requestId }, pageSession).catch(() => undefined);
      return;
    }
    if (blocked.length < MAX_BLOCKED && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      let path = "/";
      try { path = new URL(url).pathname; } catch { path = "/"; }
      blocked.push({ method, path, reason: "EGRESS_POLICY_DENIED" });
    }
    void session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, pageSession)
      .catch(() => undefined);
  });
}

async function navigateAndProbe(
  session: CdpSession,
  pageSession: string,
  sourceUrl: string,
  signal: AbortSignal,
): Promise<ProbeResult> {
  const loaded = new Promise<void>((resolve) => {
    session.on("Page.loadEventFired", (_parameters, sessionId) => {
      if (sessionId === pageSession) resolve();
    });
  });
  await session.send("Page.enable", {}, pageSession);
  await session.send("Runtime.enable", {}, pageSession);
  await session.send("Page.navigate", { url: sourceUrl }, pageSession);
  await Promise.race([
    loaded,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
      timer.unref?.();
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
  ]);
  const evaluated = await session.send("Runtime.evaluate", {
    expression: WEBSITE_PROBE_SCRIPT,
    returnByValue: true,
    awaitPromise: false,
  }, pageSession);
  const result = evaluated.result as Record<string, unknown> | undefined;
  if (typeof result?.value !== "string" || result.value.length > 64 * 1_024) {
    throw new CdpError("CDP_PROBE_FAILED");
  }
  let parsed: ProbeResult;
  try { parsed = JSON.parse(result.value) as ProbeResult; } catch { throw new CdpError("CDP_PROBE_FAILED"); }
  return parsed;
}

async function withSession<T>(
  cdpUrl: string,
  signal: AbortSignal,
  action: (session: CdpSession, pageSession: string) => Promise<T>,
): Promise<T> {
  const session = await connectCdpSession(cdpUrl, signal);
  try {
    const pageSession = await attachedPage(session);
    return await action(session, pageSession);
  } finally { session.close(); }
}

function observationsFrom(
  probe: ProbeResult,
  targetOrigin: string,
  blocked: readonly BlockedMutation[],
  observedAt: string,
): WebsiteObservationInput {
  const signals = probe.signals.filter((name) => ALLOWED_AUTH_SIGNALS.has(name)).slice(0, 3);
  return {
    navigations: probe.origin === targetOrigin ? [{ sequence: 0, url: probe.url, origin: targetOrigin }] : [],
    semanticTargets: [],
    network: [],
    forms: probe.forms.slice(0, 25).map((form, index) => ({
      logicalAction: `observed_form_${index + 1}`,
      title: form.label.slice(0, 120) || "Form",
      description: "Read-only form observed on the target page.",
      action: form.action,
      method: "GET" as const,
      authentication: signals.length > 0 ? ("same_origin_cookie" as const) : ("public" as const),
      effect: "read" as const,
      form: { kind: "role" as const, role: "form" as const, accessibleName: form.label.slice(0, 200) || "Form" },
      controls: form.controls.slice(0, 25).map((control) => ({
        field: control.name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 128),
        name: control.name,
        required: control.required,
        maxLength: 256,
      })),
      outputs: [],
      success: {
        locator: { kind: "role" as const, role: "status" as const, accessibleName: "result" },
        read: "text" as const,
        equals: "",
      },
      statusCodes: [200],
    })),
    dom: [],
    authSignals: signals.length > 0 ? [{ origin: targetOrigin, observedAt, signals: [...signals].sort() }] : [],
    blockedMutations: [...blocked],
    stateTransitions: [],
  };
}

/** Observes the target page through the session's own CDP endpoint. */
export function createCdpObserver(clock: () => Date): CdpObserver {
  return {
    async observe(input: CdpObserverInput) {
      const blocked: BlockedMutation[] = [];
      const probe = await withSession(input.cdpUrl, input.signal, async (session, pageSession) => {
        await session.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, pageSession);
        installRouteGate(session, pageSession, input.allow, blocked);
        return navigateAndProbe(session, pageSession, input.sourceUrl, input.signal);
      });
      const signals = probe.signals.filter((name) => ALLOWED_AUTH_SIGNALS.has(name));
      return {
        observations: observationsFrom(probe, input.targetOrigin, blocked, clock().toISOString()),
        requiresAuthentication: signals.length === 0 && probe.signIn,
      };
    },
  };
}

/**
 * Confirms a signed-in session on the target origin. It returns the three
 * permitted structural signals and nothing else; no credential, cookie or page
 * content is read or returned.
 */
export function createAuthenticationObserver(clock: () => Date): AuthenticationObserver {
  return {
    async observe(input: AuthenticationObserverInput): Promise<AuthenticationSignal> {
      const probe = await withSession(input.cdpUrl, input.signal, async (session, pageSession) =>
        navigateAndProbe(session, pageSession, `${input.targetOrigin}/`, input.signal));
      const signals = probe.signals.filter((name) => ALLOWED_AUTH_SIGNALS.has(name)).slice(0, 3);
      if (probe.origin !== input.targetOrigin || signals.length === 0) {
        throw new CdpError("AUTH_STATE_UNVERIFIED");
      }
      return {
        authenticatedOrigin: input.targetOrigin,
        observedAt: clock().toISOString(),
        signals: [...signals].sort(),
      };
    },
  };
}
