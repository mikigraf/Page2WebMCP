import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import type { CandidateVerificationReport, ReleaseVerificationCheck }
  from "../../control-plane/src/release-verification.ts";
import { openBrowserSession } from "./browser.ts";
import { targetOriginAllowed, type VerifierConfig } from "./config.ts";
import { attachNetworkLog, countForeignRequests, mutatingRequestsWithin, type NetworkLog } from "./network-log.ts";
import { observeRegisteredTools } from "./page-observations.ts";
import { parseCandidatePayload } from "./payload.ts";
import { runTool, runToolWithConfirmation } from "./tool-invocation.ts";

/**
 * Candidate verification: hash the submitted bytes first, then evaluate exactly those bytes on a
 * real page at the reviewed target origin and exercise the release's own tools. Unlike the
 * installation lane this one is a loader by definition - the bytes are not installed anywhere
 * yet - so the verifier supplies the WebMCP surface when the page has none, and the report makes
 * no claim about native support.
 *
 * Every check status comes from an observation. When the observations cannot be made at all (for
 * example no execution plan is configured) the request fails closed instead of reporting checks
 * that were never run.
 */

export type CandidateOutcome =
  | Readonly<{ ok: true; report: CandidateVerificationReport }>
  | Readonly<{ ok: false; code: string }>;

const CHECK_NAMES = [
  "authentication", "cancellation", "confirmation", "final_state", "no_control_plane_or_model_calls",
  "origin", "read", "replay_idempotency", "reversible_mutation", "schema", "secret_leakage",
  "tool_selection", "trusted_loader",
] as const;

type CheckName = (typeof CHECK_NAMES)[number];
type Statuses = Partial<Record<CheckName, ReleaseVerificationCheck>>;

/** Error codes a release may report when a caller cancels an in-flight tool call. */
const ABORT_CODES: readonly string[] = ["ABORTED", "CANCELLED"];

export async function verifyCandidateRelease(input: Readonly<{
  config: VerifierConfig;
  payload: unknown;
  deadline: number;
  scope: Readonly<{ targetOrigin: string; contentHash: string }>;
}>): Promise<CandidateOutcome> {
  const payload = parseCandidatePayload(input.payload);
  if (!payload) return { ok: false, code: "RELEASE_VERIFIER_PAYLOAD_INVALID" };
  if (payload.targetOrigin !== input.scope.targetOrigin || payload.contentHash !== input.scope.contentHash) {
    return { ok: false, code: "RELEASE_VERIFIER_SCOPE_MISMATCH" };
  }
  if (!targetOriginAllowed(input.config, payload.targetOrigin)) {
    return { ok: false, code: "RELEASE_VERIFIER_TARGET_ORIGIN_FORBIDDEN" };
  }
  const plan = input.config.executionPlan;
  if (!plan || input.config.targetSessionCookies.length === 0) {
    return { ok: false, code: "RELEASE_VERIFIER_CANDIDATE_EXECUTION_CONTROLS_REQUIRED" };
  }

  // Trusted loader: the bytes are hashed here, before anything evaluates them.
  const evaluatedContentHash = createHash("sha256").update(payload.code).digest("hex");
  const evaluatedIntegrity = `sha384-${createHash("sha384").update(payload.code).digest("base64")}`;
  const trustedLoader = Object.freeze({ enforcedBeforeEvaluation: true, evaluatedContentHash });
  const csp = await observeCandidateCsp(payload.targetOrigin, input.config);
  if (evaluatedContentHash !== payload.contentHash || evaluatedIntegrity !== payload.integrity) {
    return {
      ok: true,
      report: report({
        payload,
        trustedLoader,
        registeredTools: [],
        csp,
        controlPlaneRequests: 0,
        modelRequests: 0,
        checks: allFailed("TRUSTED_LOADER_REQUIRED"),
      }),
    };
  }

  const session = await openBrowserSession({ config: input.config, targetOrigin: payload.targetOrigin });
  try {
    const log = attachNetworkLog(session.page, `${payload.targetOrigin}/`);
    await session.page.goto(`${payload.targetOrigin}/`, {
      waitUntil: "load",
      timeout: input.config.timeouts.navigationMs,
    });
    const statuses: Statuses = {
      trusted_loader: passed("trusted_loader"),
    };
    const loaded = await evaluateUnderTrustedLoader(session.page, payload.code);
    if (!loaded.registered) {
      return {
        ok: true,
        report: report({
          payload,
          trustedLoader,
          registeredTools: [],
          csp,
          controlPlaneRequests: 0,
          modelRequests: 0,
          checks: merge(statuses, allFailed(loaded.reason === "ORIGIN_MISMATCH" ? "ORIGIN_MISMATCH" : "WEBMCP_UNAVAILABLE"), {
            trusted_loader: passed("trusted_loader"),
          }),
        }),
      };
    }
    statuses.schema = check("schema", deepEqual(loaded.manifest, payload.manifest), "INVALID_OUTPUT");
    statuses.origin = check("origin", loaded.manifestTargetOrigin === payload.targetOrigin, "ORIGIN_MISMATCH");
    const registeredTools = await observeRegisteredTools(session.page);
    statuses.tool_selection = check(
      "tool_selection",
      sameNames(registeredTools, payload.expectedTools),
      "INVALID_OUTPUT",
    );
    await exerciseTools(session.page, input.config, log, payload.targetOrigin, statuses);
    const controlPlaneRequests = countForeignRequests(log, [input.config.controlPlaneOrigin]);
    const modelRequests = countForeignRequests(log, input.config.modelOrigins);
    statuses.no_control_plane_or_model_calls = check(
      "no_control_plane_or_model_calls",
      controlPlaneRequests === 0 && modelRequests === 0,
      controlPlaneRequests > 0 ? "CONTROL_PLANE_REQUEST" : "MODEL_REQUEST",
    );
    return {
      ok: true,
      report: report({
        payload,
        trustedLoader,
        registeredTools,
        csp,
        controlPlaneRequests,
        modelRequests,
        checks: statuses,
      }),
    };
  } catch {
    return { ok: false, code: "RELEASE_VERIFIER_OBSERVATION_FAILED" };
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function exerciseTools(
  page: Page,
  config: VerifierConfig,
  log: NetworkLog,
  targetOrigin: string,
  statuses: Statuses,
): Promise<void> {
  const plan = config.executionPlan!;
  const cookieValues = config.targetSessionCookies.map((cookie) => cookie.value);
  const read = await runTool(page, plan.read.toolName, plan.read.input, config.timeouts.toolMs);
  statuses.read = check("read", read.ok, "INVALID_OUTPUT");
  statuses.authentication = check("authentication", read.ok, "LOGGED_OUT");
  const repeated = [
    await runTool(page, plan.read.toolName, plan.read.input, config.timeouts.toolMs),
    await runTool(page, plan.read.toolName, plan.read.input, config.timeouts.toolMs),
  ];
  statuses.replay_idempotency = check(
    "replay_idempotency",
    read.ok && repeated.every((outcome) => outcome.ok
      && JSON.stringify(outcome.output ?? null) === JSON.stringify(read.output ?? null)),
    "WRONG_STATE",
  );
  const cancelled = await runTool(page, plan.read.toolName, plan.read.input, config.timeouts.toolMs, {
    abortImmediately: true,
  });
  // Only the release's own abort code counts: a tool that was never reachable, or a surface that
  // cannot express cancellation at all, must not be reported as a cancellation that worked.
  statuses.cancellation = check(
    "cancellation",
    !cancelled.ok && ABORT_CODES.includes(cancelled.error ?? ""),
    "CANCELLED",
  );

  const declinedAt = Date.now();
  const declined = await runToolWithConfirmation(
    page, plan.mutation.toolName, plan.mutation.input, config.timeouts.toolMs, "decline",
  );
  const declinedEffects = mutatingRequestsWithin(log, targetOrigin, declinedAt, Date.now());
  statuses.confirmation = check(
    "confirmation",
    declined.dialogObserved && !declined.ok && declinedEffects.length === 0,
    "DUPLICATE_REGISTRATION",
  );

  const marker = `p2wm-candidate-${Date.now()}`;
  const mutationAt = Date.now();
  const mutation = await runToolWithConfirmation(
    page,
    plan.mutation.toolName,
    Object.fromEntries(Object.entries(plan.mutation.input).map(([key, value]) => [
      key,
      typeof value === "string" ? value.split("{{marker}}").join(marker) : value,
    ])),
    config.timeouts.toolMs,
  );
  const effects = mutatingRequestsWithin(log, targetOrigin, mutationAt, Date.now());
  statuses.reversible_mutation = check(
    "reversible_mutation",
    mutation.ok && mutation.dialogObserved && effects.length === 1,
    "WRONG_STATE",
  );
  const finalState = await runTool(page, plan.finalState.toolName, plan.finalState.input, config.timeouts.toolMs);
  statuses.final_state = check(
    "final_state",
    finalState.ok && JSON.stringify(finalState.output ?? null).includes(marker),
    "WRONG_STATE",
  );
  const outputs = JSON.stringify([read.output ?? null, mutation.output ?? null, finalState.output ?? null]);
  statuses.secret_leakage = check(
    "secret_leakage",
    cookieValues.every((value) => value.length > 0 && !outputs.includes(value)),
    "SECRET_LEAKAGE",
  );
}

/**
 * Evaluates exactly the hashed bytes inside the page under the lane's own compatibility surface.
 *
 * The candidate lane is a loader lane by definition - the bytes are not installed anywhere yet -
 * and its checks include cancellation, which is expressed through the caller `AbortSignal` the
 * release's own tool contract accepts. The native `ModelContext.executeTool` has no caller signal,
 * so a candidate run on the native surface could never exercise that contract. The surface is
 * therefore always supplied here, shadowing any native one with an own property on the document,
 * and the candidate report makes no claim about native support.
 */
async function evaluateUnderTrustedLoader(page: Page, code: string): Promise<Readonly<{
  registered: boolean;
  reason?: string;
  manifest?: unknown;
  manifestTargetOrigin?: string;
}>> {
  // Evaluated as a source expression rather than a serialized function so the bytes reaching the
  // page are exactly the hashed bytes, with no transpiler helper injected around them.
  const expression = `(async () => {
    const source = ${JSON.stringify(code)};
    const tools = [];
    Object.defineProperty(document, "modelContext", {
      value: Object.freeze({
        registerTool: async (tool) => { tools.push(tool); return undefined; },
        getTools: async () => tools.slice(),
      }),
      configurable: false,
    });
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      const module = await import(url);
      const outcome = await (module.autoRegistration ?? module.registerPage2WebMCPTools?.());
      return {
        registered: outcome?.supported === true,
        reason: outcome?.reason ?? "",
        manifest: module.releaseManifest ?? null,
        manifestTargetOrigin: module.releaseManifest?.targetOrigin ?? "",
      };
    } catch (error) {
      return { registered: false, reason: "WEBMCP_UNAVAILABLE" };
    } finally {
      URL.revokeObjectURL(url);
    }
  })()`;
  return await page.evaluate(expression) as Readonly<{
    registered: boolean;
    reason?: string;
    manifest?: unknown;
    manifestTargetOrigin?: string;
  }>;
}

async function observeCandidateCsp(
  targetOrigin: string,
  config: VerifierConfig,
): Promise<CandidateVerificationReport["csp"]> {
  try {
    const response = await fetch(`${targetOrigin}/`, { method: "GET", redirect: "error", credentials: "omit" });
    const header = response.headers.get("content-security-policy") ?? "";
    const directive = header.split(";").map((entry) => entry.trim())
      .find((entry) => entry.startsWith("script-src") || entry.startsWith("default-src"));
    if (!directive) return { hosted: "allowed" };
    const artifactOrigin = config.artifactOrigin;
    const permitted = directive.includes("*") || directive.includes("https:")
      || (artifactOrigin !== undefined && directive.includes(artifactOrigin));
    return permitted
      ? { hosted: "allowed" }
      : { hosted: "blocked", ...(/^[ -~]{1,512}$/.test(directive) ? { directive } : {}) };
  } catch {
    return { hosted: "blocked" };
  }
}

function report(input: Readonly<{
  payload: NonNullable<ReturnType<typeof parseCandidatePayload>>;
  trustedLoader: CandidateVerificationReport["trustedLoader"];
  registeredTools: readonly string[];
  csp: CandidateVerificationReport["csp"];
  controlPlaneRequests: number;
  modelRequests: number;
  checks: Statuses;
}>): CandidateVerificationReport {
  return Object.freeze({
    observedContentHash: input.trustedLoader.evaluatedContentHash,
    observedIntegrity: input.payload.integrity,
    observedReleaseId: input.payload.manifest.releaseId,
    observedTargetOrigin: input.payload.targetOrigin,
    registeredTools: Object.freeze([...input.registeredTools]),
    trustedLoader: input.trustedLoader,
    controlPlaneRequestsDuringExecution: input.controlPlaneRequests,
    modelRequestsDuringExecution: input.modelRequests,
    checks: Object.freeze(CHECK_NAMES.map((name) => input.checks[name]
      ?? { name, status: "failed" as const, code: "DEADLINE_EXCEEDED" as const })),
    csp: input.csp,
  });
}

function merge(...sources: Statuses[]): Statuses {
  return Object.assign({}, ...sources) as Statuses;
}

function allFailed(code: ReleaseVerificationCheck["code"]): Statuses {
  return Object.fromEntries(CHECK_NAMES.map((name) => [name, { name, status: "failed" as const, code }])) as Statuses;
}

function passed(name: CheckName): ReleaseVerificationCheck {
  return { name, status: "passed" };
}

function check(
  name: CheckName,
  condition: boolean,
  code: NonNullable<ReleaseVerificationCheck["code"]>,
): ReleaseVerificationCheck {
  return condition ? { name, status: "passed" } : { name, status: "failed", code };
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}
