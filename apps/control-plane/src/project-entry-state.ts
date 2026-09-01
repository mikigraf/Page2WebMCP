export type AnalysisDiagnosticView = Readonly<{
  code: string;
  operationKey: string;
  reason?: string;
}>;

type AnalysisCompletionInput = Readonly<{
  capabilities: readonly Readonly<{
    riskTier: "R0" | "R1" | "R2" | "R3";
    status: "proposed" | "reviewed" | "verified" | "blocked";
  }>[];
  result?: Readonly<{
    diagnostics?: readonly AnalysisDiagnosticView[];
    release?: unknown;
  }>;
}>;

export type AnalysisCompletion = Readonly<{
  candidateAvailable: boolean;
  diagnostics: readonly AnalysisDiagnosticView[];
  nextStepReady: boolean;
  summary: string;
}>;

type ReleaseInstallationInput = Readonly<{
  installed: boolean;
  productionVerified?: boolean;
  attestation?: Readonly<{
    status: string;
    verifierMode: string;
    webMcpImplementation: string;
  }>;
}>;

export type GitHubProjectWorkflow = Readonly<{
  id: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  currentPhase: string;
  errorCode?: string;
}>;

type GitHubProjectDraftPullRequest = Readonly<{
  phase: "publish" | "install_verify";
  check: Readonly<{
    status: "queued" | "in_progress" | "completed";
    conclusion?: string;
  }>;
}>;

export type GitHubRecoveryOutcome =
  | "tested_patch_draft_pull_request_pending"
  | "tested_patch_draft_pull_request_check_preview_reconciled"
  | "github_workflow_terminal_without_installation";

export type GitHubProjectRecovery = Readonly<{
  workflowRunId?: string;
  outcome?: GitHubRecoveryOutcome;
  action: "create" | "resume" | "retry" | "complete" | "blocked";
}>;

/**
 * Converts the durable analysis result into an honest user-facing outcome.
 * A terminal succeeded run can still be unsupported; only a stored candidate
 * backed by at least one capability enables verification or publication.
 */
export function analysisCompletion(
  sourceType: "website" | "openapi" | "github",
  input: AnalysisCompletionInput,
): AnalysisCompletion {
  const diagnostics = [...(input.result?.diagnostics ?? [])];
  const candidateAvailable = input.result?.release !== undefined && input.capabilities.length > 0;
  const sourceLabel = sourceType === "openapi" ? "OpenAPI" : sourceType === "github" ? "GitHub" : "Website";
  if (!candidateAvailable) {
    return {
      candidateAvailable,
      diagnostics,
      nextStepReady: false,
      summary: `Analysis finished without a publishable ${sourceLabel} candidate.${diagnosticSuffix(diagnostics.length, "Review")}`,
    };
  }
  const selectable = input.capabilities.filter(({ status, riskTier }) => status !== "blocked" && riskTier !== "R3");
  const unsafeCapability = input.capabilities.some(({ status, riskTier }) => status !== "blocked" && riskTier === "R3");
  const reviewComplete = selectable.every(({ riskTier, status }) =>
    riskTier === "R0" || status === "reviewed" || status === "verified");
  const nextStepReady = selectable.length > 0 && !unsafeCapability && reviewComplete
    && (sourceType !== "github" || selectable.length === input.capabilities.length);
  if (!nextStepReady) {
    return {
      candidateAvailable,
      diagnostics,
      nextStepReady,
      summary: sourceType === "github"
        ? `GitHub analysis produced a candidate. Approve every supported capability before creating a draft pull request.${diagnosticSuffix(diagnostics.length, "Review")}`
        : `${sourceLabel} analysis produced a candidate. Review or block each risky capability before verification.${diagnosticSuffix(diagnostics.length, "Review")}`,
    };
  }
  return {
    candidateAvailable,
    diagnostics,
    nextStepReady,
    summary: sourceType === "github"
      ? `GitHub analysis produced a candidate ready for the tested draft-PR workflow.${diagnosticSuffix(diagnostics.length, diagnostics.length === 1 ? "One operation was skipped; review" : `${diagnostics.length} operations were skipped; review`)}`
      : `${sourceLabel} analysis produced a candidate ready for verification.${diagnosticSuffix(diagnostics.length, diagnostics.length === 1 ? "One operation was skipped; review" : `${diagnostics.length} operations were skipped; review`)}`,
  };
}

/** Production wording is derived only from the persisted native/live proof. */
export function releaseInstallationState(input: ReleaseInstallationInput): Readonly<{
  productionVerified: boolean;
  label: string;
}> {
  const attestation = input.attestation;
  if (!input.installed) {
    return { productionVerified: false, label: "Awaiting installed-target verification" };
  }
  if (input.productionVerified === true
    && attestation?.status === "verified" && attestation.webMcpImplementation === "native"
    && attestation.verifierMode === "live") {
    return { productionVerified: true, label: "Production verified" };
  }
  if (attestation?.status === "verified" && attestation.webMcpImplementation === "native"
    && ["hermetic", "local_live"].includes(attestation.verifierMode)) {
    const mode = attestation.verifierMode === "local_live" ? "local-live" : "hermetic";
    return {
      productionVerified: false,
      label: `Installation verified in ${mode} mode; production verification is still required`,
    };
  }
  return {
    productionVerified: false,
    label: "Installation evidence is incomplete; production verification is still required",
  };
}

/**
 * Browser storage is never authoritative for GitHub side effects. Only an
 * active server-reported run is resumable, and only a durable PR record makes
 * the workflow complete. A terminal run without that record remains retryable.
 */
export function githubProjectRecovery(
  workflow: GitHubProjectWorkflow | undefined,
  draftPullRequest: GitHubProjectDraftPullRequest | undefined,
): GitHubProjectRecovery {
  if (workflow && ["queued", "running", "waiting"].includes(workflow.status)) {
    return {
      workflowRunId: workflow.id,
      outcome: "tested_patch_draft_pull_request_pending",
      action: "resume",
    };
  }
  const installVerificationComplete = draftPullRequest?.phase === "install_verify"
    && draftPullRequest.check.status === "completed"
    && draftPullRequest.check.conclusion === "success";
  if (workflow?.status === "succeeded" && installVerificationComplete) {
    return {
      outcome: "tested_patch_draft_pull_request_check_preview_reconciled",
      action: "complete",
    };
  }
  if (workflow) {
    return {
      outcome: "github_workflow_terminal_without_installation",
      action: "retry",
    };
  }
  if (draftPullRequest) {
    return {
      outcome: "github_workflow_terminal_without_installation",
      action: "blocked",
    };
  }
  return { action: "create" };
}

function diagnosticSuffix(count: number, prefix: string): string {
  if (count === 0) return "";
  return ` ${prefix} the diagnostic${count === 1 ? "" : "s"} below.`;
}
