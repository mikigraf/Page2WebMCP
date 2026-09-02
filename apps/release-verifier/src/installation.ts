import type { InstalledVerificationReport } from "../../control-plane/src/release-verification.ts";
import { fetchServedArtifact } from "./artifact-fetch.ts";
import { openBrowserSession } from "./browser.ts";
import { secureTargetOrigin, targetOriginAllowed, type VerifierConfig } from "./config.ts";
import { collectExecutionEvidence, type ManifestPlan } from "./execution-evidence.ts";
import { attachNetworkLog, countForeignRequests, type NetworkLog } from "./network-log.ts";
import {
  observeModuleExecution,
  observeRegisteredTools,
  observeScriptTag,
  observeTargetOrigin,
  observeWebMcpSurface,
  probeDuplicateLoad,
} from "./page-observations.ts";
import { parseInstallationPayload, type InstallationPayload } from "./payload.ts";

/**
 * Installation verification: navigate a real Chromium page to the exact page URL, then report
 * only what was observed. No route is intercepted, no request is stubbed, no script is injected,
 * and no field is filled with an optimistic default. When something cannot be observed the
 * corresponding field is negative (false / null / empty) or the whole request fails closed.
 */

export type InstallationOutcome =
  | Readonly<{ ok: true; report: InstalledVerificationReport }>
  | Readonly<{ ok: false; code: string }>;

export type InstallationScopeFacts = Readonly<{
  pageUrl: string;
  targetOrigin: string;
  selectedHash: string;
}>;

const REGISTRATION_POLL_MS = 250;
const REGISTRATION_WINDOW_MS = 8_000;

export async function verifyInstalledRelease(input: Readonly<{
  config: VerifierConfig;
  payload: unknown;
  deadline: number;
  scope?: InstallationScopeFacts;
}>): Promise<InstallationOutcome> {
  const payload = parseInstallationPayload(input.payload);
  if (!payload) return failure("RELEASE_VERIFIER_PAYLOAD_INVALID");
  if (input.scope && (input.scope.pageUrl !== payload.pageUrl
    || input.scope.targetOrigin !== payload.targetOrigin
    || input.scope.selectedHash !== payload.contentHash)) {
    return failure("RELEASE_VERIFIER_SCOPE_MISMATCH");
  }
  if (!targetOriginAllowed(input.config, payload.targetOrigin)) {
    return failure("RELEASE_VERIFIER_TARGET_ORIGIN_FORBIDDEN");
  }
  const executedUrl = payload.selfHostedUrl ?? payload.artifactUrl;
  if (!secureTargetOrigin(new URL(executedUrl).origin, input.config.allowLoopbackTargets)) {
    return failure("RELEASE_VERIFIER_ARTIFACT_ORIGIN_FORBIDDEN");
  }
  const fetchTimeout = boundedRemaining(input.deadline, input.config.timeouts.navigationMs);
  if (fetchTimeout <= 0) return failure("RELEASE_VERIFIER_DEADLINE_EXCEEDED");
  const served = await fetchServedArtifact({
    url: executedUrl,
    maxBytes: input.config.limits.maxArtifactBytes,
    timeoutMs: fetchTimeout,
  });
  if (!served || served.status !== 200) return failure("RELEASE_VERIFIER_ARTIFACT_UNREACHABLE");
  const download = await fetchServedArtifact({
    url: payload.downloadUrl,
    maxBytes: input.config.limits.maxArtifactBytes,
    timeoutMs: fetchTimeout,
  });
  const observedDownloadUrl = download && download.status === 200
    && download.contentHash === served.contentHash ? payload.downloadUrl : "";

  const session = await openBrowserSession({ config: input.config, targetOrigin: payload.targetOrigin });
  try {
    const log = attachNetworkLog(session.page, executedUrl);
    const response = await session.page.goto(payload.pageUrl, {
      waitUntil: "load",
      timeout: Math.min(input.config.timeouts.navigationMs, boundedRemaining(input.deadline, 1_000)),
    }).catch(() => undefined);
    const normalPageLoad = response?.status() === 200 && session.page.url() === payload.pageUrl;
    const observedTargetOrigin = await observeTargetOrigin(session.page).catch(() => "");
    const scriptTag = await observeScriptTag(session.page, executedUrl).catch(() => undefined);
    const releaseId = manifestReleaseId(payload.manifest);
    await waitForRegistration(session.page, releaseId, input.deadline);
    const surface = await observeWebMcpSurface(session.page);
    const registeredTools = await observeRegisteredTools(session.page);
    const execution = releaseId ? await observeModuleExecution(session.page, releaseId) : undefined;
    const executed = execution?.status === "registered" || execution?.status === "registering";
    const executedContentHash = executed ? await log.artifactBodyHash() ?? null : null;
    const csp = cspDisposition(log, executedUrl);
    if (!csp) return failure("RELEASE_VERIFIER_CSP_DISPOSITION_UNOBSERVED");
    const duplicateLoadHarmless = executed
      ? await probeDuplicateLoad(session.page, executedUrl).catch(() => false)
      : null;
    const evidence = executed && registeredTools.length > 0
      ? await collectExecutionEvidence({
        page: session.page,
        config: input.config,
        log,
        targetOrigin: payload.targetOrigin,
        plans: manifestPlans(payload.manifest),
        registeredTools,
      })
      : null;
    const foreign = countForeignRequests(log, [input.config.controlPlaneOrigin, ...input.config.modelOrigins]);
    if (foreign > 0) return failure("RELEASE_VERIFIER_FORBIDDEN_NETWORK_ACTIVITY");
    return {
      ok: true,
      report: Object.freeze({
        observedArtifactUrl: scriptTag?.src ?? "",
        observedDownloadUrl,
        observedLocalOnly: loopbackArtifact(executedUrl),
        observedIntegrity: scriptTag?.integrity ?? "",
        executedArtifactUrl: executed ? log.artifactResponseUrl() ?? executedUrl : null,
        servedContentHash: served.contentHash,
        executedContentHash,
        observedTargetOrigin,
        registeredTools,
        webMcpImplementation: surface.native ? "native" : "compatibility_shim",
        normalPageLoad,
        routeInterception: false,
        injectedRegistration: false,
        syntheticHarness: false,
        duplicateLoadHarmless,
        executionEvidence: evidence,
        csp,
      }),
    };
  } catch {
    return failure("RELEASE_VERIFIER_OBSERVATION_FAILED");
  } finally {
    await session.close().catch(() => undefined);
  }
}

function failure(code: string): InstallationOutcome {
  return Object.freeze({ ok: false, code });
}

function boundedRemaining(deadline: number, minimum: number): number {
  return Math.max(minimum, Math.min(deadline - Date.now(), 120_000));
}

async function waitForRegistration(
  page: Parameters<typeof observeRegisteredTools>[0],
  releaseId: string | undefined,
  deadline: number,
): Promise<void> {
  const until = Math.min(Date.now() + REGISTRATION_WINDOW_MS, deadline);
  while (Date.now() < until) {
    const execution = releaseId ? await observeModuleExecution(page, releaseId).catch(() => undefined) : undefined;
    if (execution?.status === "registered") return;
    const tools = await observeRegisteredTools(page).catch(() => []);
    if (tools.length > 0 && !releaseId) return;
    await new Promise((resolve) => setTimeout(resolve, REGISTRATION_POLL_MS));
  }
}

function cspDisposition(log: NetworkLog, artifactUrl: string): InstalledVerificationReport["csp"] | undefined {
  const status = log.artifactStatus();
  if (status !== undefined && status >= 200 && status < 400) return Object.freeze({ hosted: "allowed" as const });
  const message = log.consoleErrors.find((entry) => entry.includes("Content Security Policy")
    && entry.includes(artifactUrl.slice(0, 200)));
  if (!message) return undefined;
  const directive = message.match(/directive:\s*"([^"]{1,512})"/)?.[1];
  return Object.freeze({
    hosted: "blocked" as const,
    ...(directive && /^[ -~]+$/.test(directive) ? { directive } : {}),
  });
}

function loopbackArtifact(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    return parsed.protocol !== "https:" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return true;
  }
}

function manifestReleaseId(manifest: unknown): string | undefined {
  const releaseId = (manifest as { releaseId?: unknown })?.releaseId;
  return typeof releaseId === "string" && /^[0-9a-f]{64}$/.test(releaseId) ? releaseId : undefined;
}

function manifestPlans(manifest: unknown): readonly ManifestPlan[] {
  const plans = (manifest as { plans?: unknown })?.plans;
  if (!Array.isArray(plans)) return [];
  return plans.filter((plan): plan is ManifestPlan => !!plan && typeof plan === "object"
    && typeof (plan as ManifestPlan).tool?.name === "string");
}

export type { InstallationPayload };
