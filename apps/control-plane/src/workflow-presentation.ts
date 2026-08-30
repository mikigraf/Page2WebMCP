import type { CapabilityPlan } from "../../../packages/capability-ir/src/plan.ts";
import type {
  AnalysisDiagnostic,
  ReleaseVerificationCheckRecord,
} from "../../../packages/database/src/control-plane.ts";
import type {
  WorkflowPhase,
  WorkflowRunStatus,
  WorkflowTaskStatus,
} from "../../../packages/database/src/workflow.ts";

type ReviewCapability = Readonly<{
  id: string;
  stableName: string;
  riskTier: "R0" | "R1" | "R2" | "R3";
  status: "proposed" | "reviewed" | "verified" | "blocked";
  version: number;
  plan: CapabilityPlan;
  planDigest: string;
}>;

export type CapabilityReviewPresentation = Readonly<{
  title: string;
  stableName: string;
  version: number;
  planDigest: string;
  risk: Readonly<{
    tier: CapabilityPlan["effects"]["riskTier"];
    effect: CapabilityPlan["effects"]["kind"];
    reversible: boolean;
    confirmation: CapabilityPlan["effects"]["confirmation"];
    summary: string;
  }>;
  authentication: Readonly<{
    mode: CapabilityPlan["authentication"]["mode"];
    requiredScopes: string[];
    csrf: boolean;
  }>;
  request: Readonly<{
    adapter: CapabilityPlan["request"]["adapter"];
    method: string;
    target: string;
    idempotency: string;
  }>;
  schemas: CapabilityPlan["schemas"];
  provenance: CapabilityPlan["evidence"];
}>;

export function capabilityReviewPresentation(capability: ReviewCapability): CapabilityReviewPresentation {
  const { plan } = capability;
  return {
    title: plan.tool.title,
    stableName: capability.stableName,
    version: capability.version,
    planDigest: capability.planDigest,
    risk: {
      tier: plan.effects.riskTier,
      effect: plan.effects.kind,
      reversible: plan.effects.reversible,
      confirmation: plan.effects.confirmation,
      summary: plan.effects.summary,
    },
    authentication: {
      mode: plan.authentication.mode,
      requiredScopes: [...plan.authentication.requiredScopes],
      csrf: plan.authentication.csrf !== undefined,
    },
    request: {
      adapter: plan.request.adapter,
      method: requestMethod(plan.request),
      target: requestTarget(plan.request),
      idempotency: `${plan.idempotency.strategy} / ${plan.idempotency.retry} / ${plan.idempotency.verified ? "verified" : "unverified"}`,
    },
    schemas: plan.schemas,
    provenance: [...plan.evidence],
  };
}

type WorkflowPresentationInput = Readonly<{
  sourceType: "website" | "openapi" | "github";
  run?: Readonly<{
    id: string;
    status: WorkflowRunStatus;
    currentPhase: WorkflowPhase;
    version: number;
    errorCode?: string;
  }>;
  tasks?: readonly Readonly<{
    phase: WorkflowPhase;
    status: WorkflowTaskStatus;
    waitReason?: string;
    errorCode?: string;
  }>[];
  diagnostics: readonly AnalysisDiagnostic[];
  verification?: Readonly<{
    eligible: boolean;
    checks: readonly ReleaseVerificationCheckRecord[];
  }>;
  release?: Readonly<{
    url: string;
    downloadUrl: string;
    selfHostRequired: boolean;
  }>;
  installation?: Readonly<{ status: "pending_self_host" | "verified" | "failed" }>;
  versionConflict?: Readonly<{ expected: number; actual: number }>;
}>;

export type WorkflowPresentationState =
  | "not_started"
  | "queued"
  | "running"
  | "ownership_required"
  | "browser_auth_required"
  | "review_required"
  | "cancelled"
  | "failed"
  | "unsupported"
  | "verification_failed"
  | "ready_for_verification"
  | "published"
  | "self_host_required"
  | "installed"
  | "version_conflict";

export type WorkflowAction = Readonly<{
  id: "refresh" | "resume" | "cancel" | "retry" | "verify" | "publish" | "install" | "copy_script" | "download" | "self_host" | "installed_check";
  enabled: boolean;
  reason?: string;
}>;

export type WorkflowPresentation = Readonly<{
  state: WorkflowPresentationState;
  productionReady: boolean;
  actions: readonly WorkflowAction[];
  diagnostics: readonly AnalysisDiagnostic[];
}>;

export function workflowPresentation(input: WorkflowPresentationInput): WorkflowPresentation {
  const diagnostics = [...input.diagnostics].sort((left, right) => {
    const byCode = compareStrings(left.code, right.code);
    return byCode === 0 ? compareStrings(left.operationKey, right.operationKey) : byCode;
  });
  if (input.versionConflict) return presented("version_conflict", false, [action("refresh", true)], diagnostics);
  if (diagnostics.some(({ code }) => isBlockingDiagnostic(code))) {
    return presented("unsupported", false, [
      action("publish", false, "Resolve blocking diagnostics before publication."),
      action("install", false, "Only an exact verified release can be installed."),
    ], diagnostics);
  }
  if (input.installation?.status === "verified") return presented("installed", true, [action("installed_check", true)], diagnostics);
  if (input.installation?.status === "pending_self_host") {
    return presented("self_host_required", false, [
      action("copy_script", true), action("download", true), action("self_host", true), action("installed_check", true),
    ], diagnostics);
  }
  if (input.release) {
    return presented("published", false, [
      action("copy_script", true), action("download", true), action("self_host", input.release.selfHostRequired), action("installed_check", true),
    ], diagnostics);
  }
  if (input.verification && !input.verification.eligible) {
    return presented("verification_failed", false, [action("verify", true), action("publish", false)], diagnostics);
  }
  if (!input.run) return presented("not_started", false, [action("verify", false), action("publish", false)], diagnostics);
  if (input.run.status === "failed") return presented("failed", false, [action("retry", true), action("refresh", true)], diagnostics);
  if (input.run.status === "cancelled") return presented("cancelled", false, [action("retry", true), action("refresh", true)], diagnostics);
  if (input.run.status === "queued") return presented("queued", false, [action("refresh", true), action("cancel", true)], diagnostics);
  if (input.run.status === "running") return presented("running", false, [action("refresh", true), action("cancel", true)], diagnostics);
  if (input.run.status === "waiting") {
    const state = input.run.currentPhase === "ownership"
      ? "ownership_required"
      : input.run.currentPhase === "browser_auth"
        ? "browser_auth_required"
        : "review_required";
    return presented(state, false, [action("resume", true), action("cancel", true), action("retry", false)], diagnostics);
  }
  return presented("ready_for_verification", false, [
    action("verify", input.verification === undefined),
    action("publish", input.verification?.eligible === true),
  ], diagnostics);
}

function requestMethod(request: CapabilityPlan["request"]): string {
  if (request.adapter === "semantic_dom") return request.action.kind === "read" ? "READ" : "CLICK";
  return request.method;
}

function requestTarget(request: CapabilityPlan["request"]): string {
  if (request.adapter === "json_api") return request.pathTemplate;
  if (request.adapter === "html_form") return request.action;
  return JSON.stringify(request.scope);
}

function isBlockingDiagnostic(code: string): boolean {
  return /(?:UNSUPPORTED|REQUIRED|AMBIGUOUS|HIGH_RISK|MALFORMED|INVALID|REJECTED)/.test(code);
}

function action(id: WorkflowAction["id"], enabled: boolean, reason?: string): WorkflowAction {
  return reason ? { id, enabled, reason } : { id, enabled };
}

function presented(
  state: WorkflowPresentationState,
  productionReady: boolean,
  actions: readonly WorkflowAction[],
  diagnostics: readonly AnalysisDiagnostic[],
): WorkflowPresentation {
  return { state, productionReady, actions, diagnostics };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
