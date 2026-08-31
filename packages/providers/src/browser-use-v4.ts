import { createHash } from "node:crypto";
import { validateTargetUrl } from "../../security/src/security.ts";

export const BROWSER_USE_CLOUD_API_VERSION = "v4" as const;
export const BROWSER_USE_CLOUD_MODEL = "browser-use-2.0" as const;
const MAX_SESSION_TTL_MS = 10 * 60 * 1_000;
const secretReferencePattern = /^secretref:[A-Za-z0-9._:-]{1,200}$/;

export type BrowserUseCloudV4Request = Readonly<{
  apiVersion: typeof BROWSER_USE_CLOUD_API_VERSION;
  model: typeof BROWSER_USE_CLOUD_MODEL;
  allowedDomains: readonly string[];
  allowedOrigins: readonly string[];
  proxy: Readonly<{ denyByDefault: true; policyReference: string }>;
  session: Readonly<{
    ephemeral: true;
    keepAlive: true;
    recording: false;
    profile: null;
    workspace: null;
    persistMemory: false;
  }>;
  features: Readonly<{ downloads: false; uploads: false; skills: false; agentmail: false }>;
  expiresAt: string;
}>;

export type BrowserUseSessionInput = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  targetOrigin: string;
  expiresAt: string;
  proxyPolicyReference: Readonly<{ reference: string; expiresAt: string }>;
}>;

export type BrowserUseSession = Readonly<{
  apiVersion: typeof BROWSER_USE_CLOUD_API_VERSION;
  model: typeof BROWSER_USE_CLOUD_MODEL;
  targetOrigin: string;
  expiresAt: string;
  leaseId: string;
  liveReference: string;
  cdpReference: string;
  policyDigest: string;
}>;

export type BrowserUseCloudV4Controls = Readonly<{
  clock?: () => Date;
  signal?: AbortSignal;
  leases: {
    claim(input: Readonly<{
      organizationId: string;
      projectId: string;
      runId: string;
      targetOrigin: string;
      expiresAt: string;
      policyDigest: string;
    }>): Promise<Readonly<{ leaseId: string }>>;
    release(leaseId: string): Promise<void>;
  };
  secretReferences: {
    put(input: Readonly<{
      value: string;
      purpose: "browser_live_url" | "browser_cdp_url";
      expiresAt: string;
    }>): Promise<Readonly<{ reference: string; expiresAt: string }>>;
    revoke(reference: string): Promise<void>;
  };
  transport: {
    start(request: BrowserUseCloudV4Request, signal: AbortSignal): Promise<Readonly<{
      providerSessionId: string;
      liveUrl: string;
      cdpUrl: string;
      appliedPolicyDigest: string;
    }>>;
    stop(providerSessionId: string, reason: "completed" | "failed" | "cancelled"): Promise<void>;
    reconcile(providerSessionId: string): Promise<void>;
  };
}>;

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareCodePoints).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function browserUseCloudV4PolicyDigest(request: BrowserUseCloudV4Request): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

function exactOrigin(value: string, code: string): URL {
  if (!validateTargetUrl(value).ok) throw new Error(code);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(code); }
  if (parsed.origin !== value || parsed.href !== `${value}/`) throw new Error(code);
  return parsed;
}

function validateIdentifier(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

type BrowserSessionStopCode = "BROWSER_SESSION_ABORTED" | "BROWSER_SESSION_EXPIRED";

function createBrowserSessionDeadline(
  remainingMs: number,
  callerSignal: AbortSignal | undefined,
): Readonly<{
  signal: AbortSignal;
  stopped: Promise<never>;
  code(): BrowserSessionStopCode | undefined;
  dispose(): void;
}> {
  const controller = new AbortController();
  let terminalCode: BrowserSessionStopCode | undefined;
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  // The promise can reject before action() is reached (for example while a
  // lease claim finishes). Keep it observed until it is raced below.
  void stopped.catch(() => undefined);
  const stop = (code: BrowserSessionStopCode) => {
    if (terminalCode) return;
    terminalCode = code;
    const error = new Error(code);
    rejectStopped(error);
    controller.abort(error);
  };
  const abort = () => stop("BROWSER_SESSION_ABORTED");
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => stop("BROWSER_SESSION_EXPIRED"), Math.max(0, remainingMs));
  timeout.unref?.();
  return {
    signal: controller.signal,
    stopped,
    code: () => terminalCode,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}

function validatedRequest(input: BrowserUseSessionInput, now: Date): BrowserUseCloudV4Request {
  if (![input.organizationId, input.projectId, input.runId].every(validateIdentifier)) {
    throw new Error("BROWSER_SESSION_INPUT_INVALID");
  }
  const origin = exactOrigin(input.targetOrigin, "BROWSER_TARGET_ORIGIN_INVALID");
  const expiry = Date.parse(input.expiresAt);
  const proxyExpiry = Date.parse(input.proxyPolicyReference?.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry - now.getTime() > MAX_SESSION_TTL_MS) {
    throw new Error("BROWSER_SESSION_TTL_INVALID");
  }
  if (!secretReferencePattern.test(input.proxyPolicyReference?.reference ?? "")
    || !Number.isFinite(proxyExpiry) || proxyExpiry < expiry) {
    throw new Error("BROWSER_PROXY_POLICY_REQUIRED");
  }
  return {
    apiVersion: BROWSER_USE_CLOUD_API_VERSION,
    model: BROWSER_USE_CLOUD_MODEL,
    allowedDomains: [origin.hostname],
    allowedOrigins: [origin.origin],
    proxy: { denyByDefault: true, policyReference: input.proxyPolicyReference.reference },
    session: {
      ephemeral: true,
      keepAlive: true,
      recording: false,
      profile: null,
      workspace: null,
      persistMemory: false,
    },
    features: { downloads: false, uploads: false, skills: false, agentmail: false },
    expiresAt: input.expiresAt,
  };
}

function assertControls(controls: BrowserUseCloudV4Controls): void {
  if (!controls?.leases || typeof controls.leases.claim !== "function" || typeof controls.leases.release !== "function"
    || !controls.secretReferences || typeof controls.secretReferences.put !== "function" || typeof controls.secretReferences.revoke !== "function"
    || !controls.transport || typeof controls.transport.start !== "function" || typeof controls.transport.stop !== "function"
    || typeof controls.transport.reconcile !== "function") {
    throw new Error("BROWSER_PROVIDER_CONTROLS_REQUIRED");
  }
}

function assertProviderSessionId(
  result: Awaited<ReturnType<BrowserUseCloudV4Controls["transport"]["start"]>>,
): string {
  if (!result || !validateIdentifier(result.providerSessionId)) throw new Error("BROWSER_PROVIDER_RESPONSE_INVALID");
  return result.providerSessionId;
}

function assertRawSession(result: Awaited<ReturnType<BrowserUseCloudV4Controls["transport"]["start"]>>): void {
  if (typeof result.liveUrl !== "string" || !result.liveUrl.startsWith("https://")
    || typeof result.cdpUrl !== "string" || !result.cdpUrl.startsWith("wss://")) {
    throw new Error("BROWSER_PROVIDER_RESPONSE_INVALID");
  }
}

async function captureReference(
  controls: BrowserUseCloudV4Controls,
  value: string,
  purpose: "browser_live_url" | "browser_cdp_url",
  expiresAt: string,
): Promise<string> {
  const stored = await controls.secretReferences.put({ value, purpose, expiresAt });
  if (!stored || !secretReferencePattern.test(stored.reference) || stored.expiresAt !== expiresAt
    || stored.reference.includes(value)) throw new Error("BROWSER_SECRET_REFERENCE_INVALID");
  return stored.reference;
}

export async function withBrowserUseCloudV4Session<T>(
  input: BrowserUseSessionInput,
  controls: BrowserUseCloudV4Controls,
  action: (session: BrowserUseSession, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertControls(controls);
  const now = (controls.clock ?? (() => new Date()))();
  const request = validatedRequest(input, now);
  const initialRemainingMs = Date.parse(input.expiresAt) - now.getTime();
  const monotonicStartedAt = Date.now();
  const policyDigest = browserUseCloudV4PolicyDigest(request);
  const lease = await controls.leases.claim({
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    targetOrigin: input.targetOrigin,
    expiresAt: input.expiresAt,
    policyDigest,
  });
  if (!lease || !validateIdentifier(lease.leaseId)) throw new Error("BROWSER_SESSION_LEASE_INVALID");
  const deadline = createBrowserSessionDeadline(
    initialRemainingMs - (Date.now() - monotonicStartedAt),
    controls.signal,
  );

  let providerSessionId: string | undefined;
  let providerStartAttempted = false;
  const references: string[] = [];
  let primaryError: unknown;
  let outcome: "completed" | "failed" | "cancelled" = "failed";
  try {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    providerStartAttempted = true;
    const started = await controls.transport.start(request, deadline.signal);
    providerSessionId = assertProviderSessionId(started);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    assertRawSession(started);
    if (started.appliedPolicyDigest !== policyDigest) throw new Error("BROWSER_PROVIDER_CONTROL_ATTESTATION_FAILED");
    const liveReference = await captureReference(controls, started.liveUrl, "browser_live_url", input.expiresAt);
    references.push(liveReference);
    const cdpReference = await captureReference(controls, started.cdpUrl, "browser_cdp_url", input.expiresAt);
    references.push(cdpReference);
    const session: BrowserUseSession = {
      apiVersion: BROWSER_USE_CLOUD_API_VERSION,
      model: BROWSER_USE_CLOUD_MODEL,
      targetOrigin: input.targetOrigin,
      expiresAt: input.expiresAt,
      leaseId: lease.leaseId,
      liveReference,
      cdpReference,
      policyDigest,
    };
    const value = await Promise.race([action(session, deadline.signal), deadline.stopped]);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    outcome = "completed";
    return value;
  } catch (error) {
    const deadlineCode = deadline.code();
    const normalized = deadlineCode ? new Error(deadlineCode) : error;
    primaryError = normalized;
    if (normalized instanceof Error && ["BROWSER_SESSION_ABORTED", "BROWSER_SESSION_EXPIRED"].includes(normalized.message)) {
      outcome = "cancelled";
    }
    throw normalized;
  } finally {
    const cleanupErrors: unknown[] = [];
    let terminationProven = !providerStartAttempted;
    for (const reference of references.reverse()) {
      try { await controls.secretReferences.revoke(reference); } catch (error) { cleanupErrors.push(error); }
    }
    if (providerSessionId) {
      try {
        await controls.transport.stop(providerSessionId, outcome);
        terminationProven = true;
      } catch (error) { cleanupErrors.push(error); }
      try {
        await controls.transport.reconcile(providerSessionId);
        terminationProven = true;
      } catch (error) { cleanupErrors.push(error); }
    }
    // An attempted start may have reached the provider even when its response was
    // lost. Keep the exclusive durable lease until its TTL unless a terminal
    // stop/reconciliation result was positively attested by the transport.
    if (terminationProven) {
      try { await controls.leases.release(lease.leaseId); } catch (error) { cleanupErrors.push(error); }
    }
    deadline.dispose();
    if (primaryError === undefined && cleanupErrors.length > 0) throw new Error("BROWSER_SESSION_CLEANUP_FAILED");
  }
}

export type WebsiteAuthInput = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  targetOrigin: string;
  liveReference: string;
  expiresAt: string;
}>;

export type WebsiteAuthControls = Readonly<{
  clock?: () => Date;
  signal?: AbortSignal;
  store: {
    open(input: WebsiteAuthInput): Promise<Readonly<{ handoffId: string }>>;
    wait(handoffId: string, signal: AbortSignal): Promise<unknown>;
    close(handoffId: string, outcome: "completed" | "failed" | "cancelled"): Promise<void>;
  };
}>;

export type WebsiteAuthEvidence = Readonly<{
  source: "runtime";
  content: string;
  reference: string;
  targetOrigin: string;
}>;

const allowedAuthSignals = new Set(["account_control", "authenticated_status", "logout_control"]);
const credentialKey = /authorization|cookie|password|token|secret|csrf|otp|session|credential|api[-_]?key/i;

function containsCredentialMaterial(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return typeof value === "string" && /\bbearer\s+\S+/i.test(value);
  if (seen.has(value as object)) return true;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some((item) => containsCredentialMaterial(item, seen));
  return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => credentialKey.test(key) || containsCredentialMaterial(child, seen));
}

export async function awaitWebsiteAuthentication(
  input: WebsiteAuthInput,
  controls: WebsiteAuthControls,
): Promise<WebsiteAuthEvidence> {
  if (!controls?.store || typeof controls.store.open !== "function" || typeof controls.store.wait !== "function"
    || typeof controls.store.close !== "function") throw new Error("AUTH_HANDOFF_CONTROLS_REQUIRED");
  const now = (controls.clock ?? (() => new Date()))();
  exactOrigin(input.targetOrigin, "AUTH_HANDOFF_INVALID");
  if (![input.organizationId, input.projectId, input.runId].every(validateIdentifier)
    || !secretReferencePattern.test(input.liveReference)) throw new Error("AUTH_HANDOFF_INVALID");
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) throw new Error("AUTH_HANDOFF_EXPIRED");
  if (expiry - now.getTime() > MAX_SESSION_TTL_MS) throw new Error("AUTH_HANDOFF_INVALID");
  const opened = await controls.store.open(input);
  if (!opened || !validateIdentifier(opened.handoffId)) throw new Error("AUTH_HANDOFF_STATE_INVALID");
  const controller = new AbortController();
  let outcome: "completed" | "failed" | "cancelled" = "failed";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = () => controller.abort(new Error("AUTH_HANDOFF_CANCELLED"));
  if (controls.signal?.aborted) abort();
  else controls.signal?.addEventListener("abort", abort, { once: true });
  try {
    const completion = await Promise.race([
      controls.store.wait(opened.handoffId, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("AUTH_HANDOFF_EXPIRED"));
          reject(new Error("AUTH_HANDOFF_EXPIRED"));
        }, expiry - now.getTime());
      }),
      new Promise<never>((_resolve, reject) => {
        if (controls.signal?.aborted) reject(new Error("AUTH_HANDOFF_CANCELLED"));
        else controls.signal?.addEventListener("abort", () => reject(new Error("AUTH_HANDOFF_CANCELLED")), { once: true });
      }),
    ]);
    if (containsCredentialMaterial(completion)) throw new Error("AUTH_CREDENTIAL_MATERIAL_BLOCKED");
    if (!completion || typeof completion !== "object") throw new Error("AUTH_STATE_UNVERIFIED");
    const record = completion as Record<string, unknown>;
    if (record.authenticatedOrigin !== input.targetOrigin) throw new Error("AUTH_ORIGIN_MISMATCH");
    if (!Array.isArray(record.signals) || record.signals.length === 0 || record.signals.length > 3
      || record.signals.some((signal) => typeof signal !== "string" || !allowedAuthSignals.has(signal))) {
      throw new Error("AUTH_STATE_UNVERIFIED");
    }
    const observedAt = typeof record.observedAt === "string" ? record.observedAt : "";
    const observedTime = Date.parse(observedAt);
    if (!Number.isFinite(observedTime) || observedTime < now.getTime() - 5 * 60_000 || observedTime > expiry) {
      throw new Error("AUTH_STATE_UNVERIFIED");
    }
    const content = canonicalJson({
      authenticatedOrigin: input.targetOrigin,
      observedAt,
      signals: [...new Set(record.signals as string[])].sort(compareCodePoints),
      version: 1,
    });
    outcome = "completed";
    return {
      source: "runtime",
      content,
      reference: `urn:sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
      targetOrigin: input.targetOrigin,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_HANDOFF_CANCELLED") outcome = "cancelled";
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    controls.signal?.removeEventListener("abort", abort);
    await controls.store.close(opened.handoffId, outcome);
  }
}
