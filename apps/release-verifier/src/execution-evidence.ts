import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { VerifierConfig } from "./config.ts";
import { mutatingRequestsWithin, type NetworkLog } from "./network-log.ts";
import { runTool, runToolWithConfirmation } from "./tool-invocation.ts";

/**
 * Execution evidence gathered by using the installed release the way an agent would: one
 * authenticated read, one mutation confirmed through the release's own confirmation UI with real
 * keyboard input, and one authoritative read back from the target. Every field is derived from an
 * observation; when an observation cannot be made the whole evidence block is null.
 */

export type InstalledExecutionEvidence = Readonly<{
  authenticatedRead: Readonly<{ toolName: string; authenticated: true; succeeded: true }>;
  confirmedReversibleMutation: Readonly<{
    toolName: string;
    confirmation: "explicit";
    reversible: true;
    succeeded: true;
    effectCount: 1;
  }>;
  authoritativeFinalState: Readonly<{ mutationToolName: string; source: "target"; verified: true }>;
}>;

export type ManifestPlan = Readonly<{
  tool: Readonly<{ name: string }>;
  annotations: Readonly<{ readOnly: boolean }>;
  authentication: Readonly<{ mode: string }>;
  effects: Readonly<{
    kind: string;
    reversible: boolean;
    confirmation: string;
    sourceNativeConfirmation?: unknown;
  }>;
}>;

const MARKER_TOKEN = "{{marker}}";

export async function collectExecutionEvidence(input: Readonly<{
  page: Page;
  config: VerifierConfig;
  log: NetworkLog;
  targetOrigin: string;
  plans: readonly ManifestPlan[];
  registeredTools: readonly string[];
}>): Promise<InstalledExecutionEvidence | null> {
  const plan = input.config.executionPlan;
  if (!plan || input.config.targetSessionCookies.length === 0) return null;
  const readPlan = input.plans.find((entry) => entry.tool.name === plan.read.toolName);
  const mutationPlan = input.plans.find((entry) => entry.tool.name === plan.mutation.toolName);
  if (!readPlan || !mutationPlan
    || !input.registeredTools.includes(plan.read.toolName)
    || !input.registeredTools.includes(plan.mutation.toolName)
    || readPlan.effects.kind !== "read" || !readPlan.annotations.readOnly
    || !["same_origin_cookie", "browser_oauth"].includes(readPlan.authentication.mode)
    || mutationPlan.effects.kind !== "mutation" || mutationPlan.annotations.readOnly
    || !mutationPlan.effects.reversible || mutationPlan.effects.confirmation !== "always"
    || mutationPlan.effects.sourceNativeConfirmation !== undefined) return null;

  const cookieNames = input.config.targetSessionCookies.map((cookie) => cookie.name);
  const readStartedAt = Date.now();
  const read = await runTool(input.page, plan.read.toolName, plan.read.input, input.config.timeouts.toolMs);
  if (!read.ok) return null;
  await input.log.settle();
  if (!authenticatedRequestObserved(input, cookieNames, readStartedAt, Date.now())) return null;

  const marker = `p2wm-${randomUUID()}`;
  const mutationStartedAt = Date.now();
  const mutation = await runToolWithConfirmation(
    input.page,
    plan.mutation.toolName,
    withMarker(plan.mutation.input, marker),
    input.config.timeouts.toolMs,
  );
  const mutationEndedAt = Date.now();
  if (!mutation.ok || !mutation.dialogObserved) return null;
  const effects = mutatingRequestsWithin(input.log, input.targetOrigin, mutationStartedAt, mutationEndedAt);
  if (effects.length !== 1) return null;

  const finalState = await runTool(
    input.page,
    plan.finalState.toolName,
    plan.finalState.input,
    input.config.timeouts.toolMs,
  );
  if (!finalState.ok || !JSON.stringify(finalState.output ?? null).includes(marker)) return null;

  return Object.freeze({
    authenticatedRead: Object.freeze({ toolName: plan.read.toolName, authenticated: true as const, succeeded: true as const }),
    confirmedReversibleMutation: Object.freeze({
      toolName: plan.mutation.toolName,
      confirmation: "explicit" as const,
      reversible: true as const,
      succeeded: true as const,
      effectCount: 1 as const,
    }),
    authoritativeFinalState: Object.freeze({
      mutationToolName: plan.mutation.toolName,
      source: "target" as const,
      verified: true as const,
    }),
  });
}

function authenticatedRequestObserved(
  input: Readonly<{ log: NetworkLog; targetOrigin: string }>,
  cookieNames: readonly string[],
  from: number,
  to: number,
): boolean {
  const requests = input.log.requests.filter((request) => {
    if (request.at < from - 50 || request.at > to) return false;
    try {
      return new URL(request.url).origin === input.targetOrigin;
    } catch {
      return false;
    }
  });
  const authenticated = requests.some((request) => cookieNames.some((name) => request.cookieNames.includes(name)));
  const successful = input.log.responses.some((response) => response.at >= from - 50 && response.at <= to + 250
    && response.status >= 200 && response.status < 300
    && requests.some((request) => request.url === response.url));
  return authenticated && successful;
}

function withMarker(
  input: Readonly<Record<string, unknown>>,
  marker: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    typeof value === "string" ? value.split(MARKER_TOKEN).join(marker) : value,
  ]));
}
