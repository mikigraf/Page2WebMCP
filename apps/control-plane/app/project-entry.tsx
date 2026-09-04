"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { CapabilityPlan } from "../../../packages/capability-ir/src/plan.ts";
import {
  analysisCompletion,
  githubProjectRecovery,
  releaseInstallationState,
  type AnalysisDiagnosticView,
  type GitHubProjectWorkflow,
} from "../src/project-entry-state.ts";
import { capabilityReviewPresentation } from "../src/workflow-presentation.ts";
import {
  clearClientWorkflow,
  clearWorkflow as clearStoredWorkflow,
  completeOperation,
  loadWorkflow,
  operationKey,
  recoverableAnalysisRunId,
  reconcileProjectRecovery,
  saveWorkflow,
  type PersistedWorkflow,
  type SourceConfiguration,
  type SourceType
} from "../src/client-workflow.ts";

type Capability = {
  id: string;
  stableName: string;
  riskTier: "R0" | "R1" | "R2" | "R3";
  status: "proposed" | "reviewed" | "verified" | "blocked";
  version: number;
  plan: CapabilityPlan;
  planDigest: string;
};
type ApiFailure = { code?: string };
type WebsiteAuthenticationState = {
  state: "waiting" | "ready" | "resumed" | "expired" | "failed" | "cancelled";
  targetOrigin: string;
  expiresAt: string;
  canAct: boolean;
  portalUrl?: string;
  endpoint: string;
};
type AnalysisStatus = {
  run: { id: string; status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled"; errorCode?: string };
  capabilities: Capability[];
  result?: {
    diagnostics?: AnalysisDiagnosticView[];
    release?: { contentHash: string };
  };
  websiteUserHandoff?: {
    authentication?: {
      endpoint: string;
      state: "waiting" | "resumed" | "expired" | "failed" | "cancelled";
    };
  };
};
type GitHubDraftPullRequest = {
  repository: { owner: string; name: string };
  number: number;
  url: string;
  branch: string;
  baseCommitSha: string;
  headCommitSha: string;
  check: { externalId: string; status: "queued" | "in_progress" | "completed"; conclusion?: string };
  phase: "publish" | "install_verify";
  draft: true;
  merged: false;
  createdAt: string;
};
type GitHubWorkflowStatus = {
  workflow: GitHubProjectWorkflow;
  outcome: "tested_patch_draft_pull_request_pending" | "tested_patch_draft_pull_request_check_preview_reconciled" | "github_workflow_terminal_without_installation";
  draftPullRequest?: GitHubDraftPullRequest;
};
type ProjectSummary = {
  id: string;
  name: string;
  sourceType: SourceType;
  url: string;
  status: string;
};
type ProjectSource = {
  sourceType: SourceType;
  sourceUrl: string;
  sourceConfiguration: SourceConfiguration;
};
type WebsiteOwnershipState =
  | { state: "pending"; method: "dns_txt"; targetOrigin: string; expiresAt: string;
    instructions: { recordName: string; recordType: "TXT"; recordValue: string } }
  | { state: "pending"; method: "well_known"; targetOrigin: string; expiresAt: string;
    instructions: { url: string; content: string } }
  | { state: "verified" | "expired" | "failed" | "missing"; targetOrigin: string; expiresAt?: string };
type ReleaseResult = {
  id: string;
  url: string;
  installation: {
    artifactUrl: string;
    downloadUrl: string;
    moduleScriptTag: string;
    manifest: unknown;
    integrity: string;
    contentHash: string;
    targetOrigin: string;
    verificationPageUrl: string;
    localOnly: boolean;
    compatibility: { moduleScripts: true; webMcp: "native-current-required" };
    previousRelease: null | { id: string; contentHash: string; integrity: string; artifactUrl: string };
    installed: boolean;
    productionVerified: boolean;
    attestation: null | {
      id: string;
      status: "pending_self_host" | "verified" | "failed";
      delivery: "hosted" | "self_hosted";
      pageUrl: string;
      selfHostedUrl: string | null;
      webMcpImplementation: string;
      verifierMode: "hermetic" | "local_live" | "live";
      registeredTools: string[];
      executedContentHash: string | null;
      normalPageLoad: boolean;
      routeInterception: boolean;
      injectedRegistration: boolean;
      syntheticHarness: boolean;
      verifiedAt: string | null;
    };
    selfHost: { required: boolean; guidance: string };
  };
};

const DEFAULT_URLS: Record<SourceType, string> = {
  website: "https://docs.example/",
  openapi: "https://api.example/openapi.json",
  github: "https://github.com/example/project"
};
const ANALYSIS_POLL_DEADLINE_MS = 10 * 60_000;
const anonymousCsrfRoutes = new Set([
  "/api/auth/login",
  "/api/auth/recovery",
  "/api/auth/refresh",
  "/api/auth/signup"
]);

export function ProjectEntry({ authState }: Readonly<{ authState?: "verified" | "recovery" }> = {}) {
  const [sourceType, setSourceType] = useState<SourceType>("website");
  const [url, setUrl] = useState(DEFAULT_URLS.website);
  const [targetOrigin, setTargetOrigin] = useState("https://api.example");
  const [testPageUrl, setTestPageUrl] = useState("https://api.example/");
  const [environment, setEnvironment] = useState<"test" | "staging" | "production">("test");
  const [message, setMessage] = useState(authState === "recovery"
    ? "Choose a new password to finish recovery."
    : authState === "verified"
      ? "Email verified. Your personal organization is ready."
      : "");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [diagnostics, setDiagnostics] = useState<readonly AnalysisDiagnosticView[]>([]);
  const [analysisNextStepReady, setAnalysisNextStepReady] = useState<boolean>();
  const [workflowRunId, setWorkflowRunId] = useState<string>();
  const [githubOutcome, setGitHubOutcome] = useState<GitHubWorkflowStatus["outcome"]>();
  const [githubAction, setGitHubAction] = useState<ReturnType<typeof githubProjectRecovery>["action"]>();
  const [githubDraftPullRequest, setGitHubDraftPullRequest] = useState<GitHubDraftPullRequest>();
  const [projectId, setProjectId] = useState<string>();
  const [analysisRunId, setAnalysisRunId] = useState<string>();
  const [releaseUrl, setReleaseUrl] = useState<string>();
  const [release, setRelease] = useState<ReleaseResult>();
  const [verificationEligible, setVerificationEligible] = useState<boolean>();
  const [selfHostedUrl, setSelfHostedUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedInRole, setSignedInRole] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [nextProjectsCursor, setNextProjectsCursor] = useState<string>();
  const [recoveryMode, setRecoveryMode] = useState(authState === "recovery");
  const [busy, setBusy] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [websiteOwnership, setWebsiteOwnership] = useState<WebsiteOwnershipState>();
  const [websiteAuthentication, setWebsiteAuthentication] = useState<WebsiteAuthenticationState>();
  const [websiteHandoffError, setWebsiteHandoffError] = useState<string>();
  const websiteAuthenticationRequestEpoch = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void loadServerSession(controller.signal).then(async (session) => {
      if (!session || controller.signal.aborted) return;
      setSignedInRole(session.role);
      const listed = await requestJson<{ projects: ProjectSummary[]; nextCursor?: string } & ApiFailure>("/api/projects?limit=50", {
        cache: "no-store",
        signal: controller.signal
      });
      if (listed.response.ok && !controller.signal.aborted) {
        setProjects(listed.body.projects);
        setNextProjectsCursor(listed.body.nextCursor);
      }
    }).catch(() => {
      if (!controller.signal.aborted) setSignedInRole("");
    });
    return () => controller.abort();
  }, []);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { response, body } = await requestJson<{ role?: string } & ApiFailure>("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!response.ok) throw new Error(body.code ?? "AUTH_REQUIRED");
      setSignedInRole(body.role ?? "");
      setPassword("");
      setMessage("");
      const listed = await requestJson<{ projects: ProjectSummary[]; nextCursor?: string } & ApiFailure>(
        "/api/projects?limit=50",
        { cache: "no-store" }
      );
      if (listed.response.ok) {
        setProjects(listed.body.projects);
        setNextProjectsCursor(listed.body.nextCursor);
      }
      if (analysisRunId) {
        try {
          const completed = await waitForAnalysis(analysisRunId);
          await applyAnalysisStatus(completed, sourceType);
        } catch (error) {
          if (error instanceof AnalysisRunError && error.terminal && projectId) {
            setAnalysisRunId(undefined);
            persistWorkflow({ sourceType, url, projectId });
          }
          setMessage(`Analysis recovery failed: ${errorCode(error)}`);
        }
      }
    } catch (error) {
      setMessage(`Sign in failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function signUp() {
    setBusy(true);
    try {
      const { response, body } = await requestJson<{
        emailVerificationRequired?: boolean;
        role?: string;
      } & ApiFailure>("/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (!response.ok) throw new Error(body.code ?? "SIGNUP_FAILED");
      if (body.role) setSignedInRole(body.role);
      setPassword("");
      setMessage(body.emailVerificationRequired
        ? "Check your email to verify this account before signing in."
        : "Account created.");
    } catch (error) {
      setMessage(`Sign up failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function recoverPassword() {
    setBusy(true);
    try {
      const { response, body } = await requestJson<ApiFailure>("/api/auth/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email })
      });
      if (!response.ok) throw new Error(body.code ?? "PASSWORD_RECOVERY_FAILED");
      setMessage("If the account exists, a password recovery email has been sent.");
    } catch (error) {
      setMessage(`Password recovery failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const { response, body } = await requestJson<ApiFailure>("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error(body.code ?? "SIGNOUT_FAILED");
      setSignedInRole("");
      setProjects([]);
      setNextProjectsCursor(undefined);
      resetWorkflow();
      setMessage("Signed out.");
    } catch (error) {
      setMessage(`Sign out failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revokeAllSessions() {
    setBusy(true);
    try {
      const { response, body } = await requestJson<ApiFailure>("/api/auth/revoke", { method: "POST" });
      if (!response.ok) throw new Error(body.code ?? "SESSION_REVOCATION_FAILED");
      setSignedInRole("");
      setProjects([]);
      setNextProjectsCursor(undefined);
      resetWorkflow();
      setMessage("All sessions revoked. Sign in again to continue.");
    } catch (error) {
      setMessage(`Session revocation failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function setNewPassword() {
    setBusy(true);
    try {
      const { response, body } = await requestJson<ApiFailure>("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!response.ok) throw new Error(body.code ?? "PASSWORD_UPDATE_FAILED");
      setPassword("");
      setRecoveryMode(false);
      setMessage("Password updated. Other sessions were revoked.");
    } catch (error) {
      setMessage(`Password update failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreProjects() {
    if (!nextProjectsCursor) return;
    setBusy(true);
    try {
      const query = new URLSearchParams({ limit: "50", cursor: nextProjectsCursor });
      const { response, body } = await requestJson<{
        projects?: ProjectSummary[];
        nextCursor?: string;
      } & ApiFailure>(`/api/projects?${query}`, { cache: "no-store" });
      if (!response.ok || !body.projects) throw new Error(body.code ?? "PROJECT_LIST_FAILED");
      setProjects((current) => [...current, ...body.projects!.filter((candidate) =>
        !current.some((project) => project.id === candidate.id)
      )]);
      setNextProjectsCursor(body.nextCursor);
    } catch (error) {
      setMessage(`Project list failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const sourceValidationError = validateSourceConfiguration(activeSourceConfiguration());
    if (sourceValidationError) {
      setMessage(sourceValidationError);
      return;
    }
    setBusy(true);
    clearWorkflowView();
    removePersistedWorkflow();
    try {
      const { response, body } = await postIdempotent<{ id?: string } & ApiFailure>(
        "/api/projects",
        { sourceType, url, sourceConfiguration: activeSourceConfiguration() },
        "create-project"
      );
      if (!response.ok || !body.id) throw new Error(body.code ?? "PROJECT_CREATE_FAILED");
      setProjectId(body.id);
      setProjects((current) => [{
        id: body.id!,
        name: new URL(url).hostname,
        sourceType,
        url,
        status: "created"
      }, ...current.filter((project) => project.id !== body.id)]);
      persistWorkflow({ sourceType, url, sourceConfiguration: activeSourceConfiguration(), projectId: body.id });
      setMessage(`Project ${body.id} created`);
      if (sourceType === "website") await refreshWebsiteOwnership(body.id);
    } catch (error) {
      setMessage(`Project creation failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshProject(id: string, signal?: AbortSignal) {
    invalidateWebsiteAuthenticationView();
    setWebsiteHandoffError(undefined);
    const { response, body } = await requestJson<{
      project?: ProjectSummary;
      source?: ProjectSource;
      latestAnalysis?: { id: string; status: AnalysisStatus["run"]["status"] };
      capabilities?: Capability[];
      release?: ReleaseResult;
      draftPullRequest?: GitHubDraftPullRequest;
      githubWorkflow?: GitHubProjectWorkflow;
    } & ApiFailure>(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok || !body.project || !body.source) throw new Error(body.code ?? "PROJECT_LOAD_FAILED");
    const storage = browserStorage();
    const recoveredAnalysisRunId = recoverableAnalysisRunId(body.latestAnalysis);
    const recovery = reconcileProjectRecovery(storage ? loadWorkflow(storage) : undefined, {
      sourceType: body.source.sourceType,
      url: body.source.sourceUrl,
      sourceConfiguration: body.source.sourceConfiguration,
      projectId: body.project.id,
      analysisRunId: recoveredAnalysisRunId,
    }, body.release);
    const githubRecovery = body.source.sourceType === "github"
      ? githubProjectRecovery(body.githubWorkflow, body.draftPullRequest)
      : undefined;
    const recovered = githubRecovery
      ? withWorkflowRunId(recovery.workflow, githubRecovery.workflowRunId)
      : recovery.workflow;
    applySource(body.source);
    setProjectId(body.project.id);
    setAnalysisRunId(recoveredAnalysisRunId);
    setCapabilities(body.capabilities ?? []);
    setWorkflowRunId(recovered.workflowRunId);
    setReleaseUrl(body.release?.url);
    setRelease(recovery.release);
    setGitHubDraftPullRequest(body.source.sourceType === "github" ? body.draftPullRequest : undefined);
    setGitHubOutcome(githubRecovery?.outcome);
    setGitHubAction(githubRecovery?.action);
    persistWorkflow(recovered);
    if (body.source.sourceType === "website") {
      await refreshWebsiteOwnership(body.project.id, signal);
    } else {
      setWebsiteOwnership(undefined);
      setWebsiteHandoffError(undefined);
    }
    if (body.latestAnalysis && (["succeeded", "waiting"].includes(body.latestAnalysis.status)
      || body.source.sourceType === "website" && ["failed", "cancelled"].includes(body.latestAnalysis.status))) {
      const completed = await analysisStatus(body.latestAnalysis.id, signal);
      await applyAnalysisStatus(completed, body.source.sourceType, signal);
    } else {
      setDiagnostics([]);
      setAnalysisNextStepReady(undefined);
      invalidateWebsiteAuthenticationView();
    }
    return { ...body, project: body.project, source: body.source };
  }

  async function resumeProject(id: string) {
    setBusy(true);
    try {
      const body = await refreshProject(id);
      if (body.latestAnalysis?.status !== "succeeded") {
        setMessage(body.latestAnalysis ? `Resumed ${body.project.name}` : `Loaded ${body.project.name}`);
      }
    } catch (error) {
      setMessage(`Project load failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function analyze() {
    if (!projectId) {
      setMessage("Create this project before analysis");
      return;
    }
    if (sourceType === "website" && websiteOwnership?.state !== "verified") {
      setMessage("Verify ownership of this exact website source before analysis.");
      return;
    }
    setBusy(true);
    if (!analysisRunId) {
      setCapabilities([]);
      setWorkflowRunId(undefined);
      setGitHubOutcome(undefined);
      setGitHubAction("create");
      setGitHubDraftPullRequest(undefined);
      setReleaseUrl(undefined);
      invalidateWebsiteAuthenticationView();
    }
    try {
      let runId = analysisRunId;
      if (!runId) {
        const accepted = await postIdempotent<{ runId?: string } & ApiFailure>(
          "/api/projects/analyze",
          { projectId },
          `analyze:${projectId}`
        );
        if (!accepted.response.ok || !accepted.body.runId) {
          throw new Error(accepted.body.code ?? "ANALYSIS_FAILED");
        }
        runId = accepted.body.runId;
        setAnalysisRunId(runId);
        persistWorkflow({ sourceType, url, sourceConfiguration: activeSourceConfiguration(), projectId, analysisRunId: runId });
      }
      const completed = await waitForAnalysis(runId);
      await applyAnalysisStatus(completed, sourceType);
    } catch (error) {
      if (error instanceof AnalysisRunError && error.terminal) {
        setAnalysisRunId(undefined);
        persistWorkflow({ sourceType, url, sourceConfiguration: activeSourceConfiguration(), projectId });
      }
      setMessage(analysisFailureMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function review(capability: Capability, action: "approve" | "block") {
    setBusy(true);
    try {
      const { response, body } = await requestJson<{ capability?: Capability } & ApiFailure>(
        `/api/capabilities/${encodeURIComponent(capability.id)}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, expectedVersion: capability.version })
        }
      );
      if (!response.ok || !body.capability) throw new Error(body.code ?? "REVIEW_FAILED");
      setVerificationEligible(undefined);
      if (analysisRunId) {
        applyCompletedAnalysis(await analysisStatus(analysisRunId), sourceType);
      } else {
        setCapabilities((current) => current.map((item) =>
          item.id === capability.id ? body.capability! : item
        ));
        setAnalysisNextStepReady(false);
        setMessage("");
      }
    } catch (error) {
      if (analysisRunId) {
        try {
          const refreshed = await analysisStatus(analysisRunId);
          const expectedStatus = action === "approve" ? "reviewed" : "blocked";
          if (refreshed.capabilities.some((item) =>
            item.id === capability.id && item.status === expectedStatus
          )) {
            applyCompletedAnalysis(refreshed, sourceType);
            return;
          }
          setCapabilities(refreshed.capabilities);
        } catch {
          // Preserve the original stable failure when reconciliation is unavailable.
        }
      }
      setMessage(`Review failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!projectId || !analysisRunId) {
      setMessage("Complete analysis before publication");
      return;
    }
    setBusy(true);
    try {
      if (sourceType === "github") {
        let runId = workflowRunId;
        if (!runId) {
          const started = await postIdempotent<{ workflow?: { id: string }; outcome?: GitHubWorkflowStatus["outcome"] } & ApiFailure>(
            `/api/projects/${encodeURIComponent(projectId)}/workflows`,
            { analysisRunId },
            `github-workflow:${projectId}:${analysisRunId}`
          );
          if (!started.response.ok || !started.body.workflow?.id) throw new Error(started.body.code ?? "GITHUB_WORKFLOW_FAILED");
          runId = started.body.workflow.id;
          setWorkflowRunId(runId);
          setGitHubOutcome(started.body.outcome);
          setGitHubAction("resume");
          persistWorkflow({ sourceType, url, sourceConfiguration: activeSourceConfiguration(), projectId, analysisRunId, workflowRunId: runId });
        }
        const completed = await waitForGitHubWorkflow(runId);
        const githubRecovery = githubProjectRecovery(completed.workflow, completed.draftPullRequest);
        setWorkflowRunId(githubRecovery.workflowRunId);
        setGitHubOutcome(githubRecovery.outcome);
        setGitHubAction(githubRecovery.action);
        setGitHubDraftPullRequest(completed.draftPullRequest);
        persistWorkflow(withWorkflowRunId({
          sourceType,
          url,
          sourceConfiguration: activeSourceConfiguration(),
          projectId,
          analysisRunId,
        }, githubRecovery.workflowRunId));
        setMessage(gitHubWorkflowMessage(completed));
        return;
      }
      const published = await postIdempotent<{ release?: ReleaseResult } & ApiFailure>(
        `/api/projects/${encodeURIComponent(projectId)}/releases`,
        { analysisRunId },
        `publish:${projectId}:${analysisRunId}`
      );
      if (!published.response.ok || !published.body.release) {
        throw new Error(published.body.code ?? "RELEASE_FAILED");
      }
      setReleaseUrl(published.body.release.url);
      setRelease(published.body.release);
      persistWorkflow({ sourceType, url, sourceConfiguration: activeSourceConfiguration(), projectId, analysisRunId, releaseUrl: published.body.release.url });
      setMessage("Immutable release published");
    } catch (error) {
      if (sourceType === "github" && error instanceof GitHubWorkflowRunError && error.terminal) {
        setWorkflowRunId(undefined);
        setGitHubOutcome("github_workflow_terminal_without_installation");
        setGitHubAction("retry");
        persistWorkflow({ sourceType, url, sourceConfiguration: activeSourceConfiguration(), projectId, analysisRunId });
      }
      setMessage(`${sourceType === "github" ? "GitHub workflow" : "Publication"} failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function verifyExactCandidate() {
    if (!projectId || !analysisRunId) return;
    setBusy(true);
    try {
      const { response, body } = await requestJson<{ verification?: { eligible: boolean } } & ApiFailure>(
        "/api/capabilities/verify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, analysisRunId })
        }
      );
      if (!response.ok || !body.verification) throw new Error(body.code ?? "VERIFICATION_FAILED");
      setVerificationEligible(body.verification.eligible);
      setMessage(body.verification.eligible ? "Exact candidate verified" : "Verification checks failed; publication remains blocked");
    } catch (error) {
      setVerificationEligible(false);
      setMessage(`Verification failed: ${errorCode(error)}`);
    } finally { setBusy(false); }
  }

  async function copyTrustedLoaderScript() {
    if (!release) return;
    try {
      await navigator.clipboard.writeText(release.installation.moduleScriptTag);
      setMessage("Trusted-loader script copied");
    } catch { setMessage("Copy failed: CLIPBOARD_UNAVAILABLE"); }
  }

  async function checkInstalledTarget() {
    if (!projectId || !release) return;
    setBusy(true);
    try {
      const pageUrl = release.installation.verificationPageUrl;
      const { response, body } = await postIdempotent<{ installation?: { status: string } } & ApiFailure>(
        `/api/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(release.id)}/installation`,
        { pageUrl, ...(selfHostedUrl ? { selfHostedUrl } : {}) },
        `installation:${release.id}:${pageUrl}:${selfHostedUrl}`
      );
      if (!response.ok || !body.installation) throw new Error(body.code ?? "INSTALLATION_CHECK_FAILED");
      await refreshProject(projectId);
      setMessage(body.installation.status === "verified"
        ? "Installed target verified without route interception"
        : `Installation state: ${body.installation.status}`);
    } catch (error) { setMessage(`Installed-target check failed: ${errorCode(error)}`); }
    finally { setBusy(false); }
  }

  async function refreshWebsiteOwnership(id: string, signal?: AbortSignal): Promise<void> {
    try {
      const { response, body } = await requestJson<{ ownership?: WebsiteOwnershipState } & ApiFailure>(
        `/api/projects/${encodeURIComponent(id)}/website-ownership`,
        { cache: "no-store", ...(signal ? { signal } : {}) },
      );
      if (!response.ok || !body.ownership) throw new Error(body.code ?? "WEBSITE_HANDOFF_UNAVAILABLE");
      setWebsiteOwnership(body.ownership);
      setWebsiteHandoffError(undefined);
    } catch (error) {
      if (signal?.aborted) return;
      setWebsiteOwnership(undefined);
      setWebsiteHandoffError(errorCode(error));
    }
  }

  async function mutateWebsiteOwnership(action: "challenge" | "check") {
    if (!projectId) return;
    setHandoffBusy(true);
    try {
      const result = await postIdempotent<{ ownership?: WebsiteOwnershipState } & ApiFailure>(
        `/api/projects/${encodeURIComponent(projectId)}/website-ownership`,
        { action },
        `website-ownership:${projectId}:${action}`,
      );
      if (!result.response.ok || !result.body.ownership) {
        throw new Error(result.body.code ?? "WEBSITE_HANDOFF_UNAVAILABLE");
      }
      setWebsiteOwnership(result.body.ownership);
      setWebsiteHandoffError(undefined);
      setMessage(result.body.ownership.state === "verified"
        ? "Website ownership verified for the exact active source."
        : "Ownership challenge loaded. Complete the instruction below, then check ownership.");
    } catch (error) {
      setWebsiteHandoffError(errorCode(error));
    } finally {
      setHandoffBusy(false);
    }
  }

  async function refreshWebsiteAuthentication(
    status: AnalysisStatus,
    signal?: AbortSignal,
  ): Promise<WebsiteAuthenticationState> {
    const requestEpoch = invalidateWebsiteAuthenticationView();
    setWebsiteHandoffError(undefined);
    const projection = status.websiteUserHandoff?.authentication;
    const expectedEndpoint = `/api/workflow-runs/${encodeURIComponent(status.run.id)}/website-authentication`;
    if (!projection || projection.endpoint !== expectedEndpoint) {
      throw new Error("WEBSITE_AUTHENTICATION_HANDOFF_STATE_REQUIRED");
    }
    try {
      const { response, body } = await requestJson<{
        authentication?: Omit<WebsiteAuthenticationState, "endpoint">;
      } & ApiFailure>(projection.endpoint, { cache: "no-store", ...(signal ? { signal } : {}) });
      if (!response.ok || !body.authentication) {
        throw new Error(body.code ?? "WEBSITE_HANDOFF_UNAVAILABLE");
      }
      if (requestEpoch !== websiteAuthenticationRequestEpoch.current) {
        throw new Error("WEBSITE_AUTHENTICATION_CONTEXT_CHANGED");
      }
      const authentication = { ...body.authentication, endpoint: projection.endpoint };
      setWebsiteAuthentication(authentication);
      setWebsiteHandoffError(undefined);
      return authentication;
    } catch (error) {
      if (!signal?.aborted && requestEpoch === websiteAuthenticationRequestEpoch.current) {
        setWebsiteAuthentication(undefined);
        setWebsiteHandoffError(errorCode(error));
      }
      throw error;
    }
  }

  async function mutateWebsiteAuthentication(action: "check" | "cancel") {
    if (!analysisRunId || !websiteAuthentication?.endpoint || !websiteAuthentication.canAct) return;
    const requestEpoch = websiteAuthenticationRequestEpoch.current;
    setHandoffBusy(true);
    try {
      const result = await postIdempotent<{
        authentication?: Omit<WebsiteAuthenticationState, "endpoint">;
      } & ApiFailure>(
        websiteAuthentication.endpoint,
        { action },
        `website-authentication:${analysisRunId}:${action}`,
      );
      if (!result.response.ok || !result.body.authentication) {
        throw new Error(result.body.code ?? "WEBSITE_HANDOFF_UNAVAILABLE");
      }
      if (requestEpoch !== websiteAuthenticationRequestEpoch.current) return;
      const authentication: WebsiteAuthenticationState = {
        ...result.body.authentication,
        endpoint: websiteAuthentication.endpoint,
        ...(result.body.authentication.portalUrl
          ? {}
          : websiteAuthentication.portalUrl ? { portalUrl: websiteAuthentication.portalUrl } : {}),
      };
      setWebsiteAuthentication(authentication);
      setWebsiteHandoffError(undefined);
      if (authentication.state === "resumed") {
        setMessage("Authentication verified from gateway evidence. Website analysis resumed.");
        const next = await waitForAnalysis(analysisRunId);
        await applyAnalysisStatus(next, sourceType);
      } else if (["cancelled", "expired", "failed"].includes(authentication.state)) {
        setAnalysisRunId(undefined);
        persistWorkflow({ sourceType, url, sourceConfiguration: activeSourceConfiguration(), projectId });
        setMessage(authentication.state === "cancelled"
          ? "Website analysis cancelled; gateway cleanup is restart-safe."
          : authenticationMessage(authentication));
      } else {
        setMessage(authenticationMessage(authentication));
      }
    } catch (error) {
      if (requestEpoch === websiteAuthenticationRequestEpoch.current) {
        setWebsiteHandoffError(errorCode(error));
      }
    } finally {
      setHandoffBusy(false);
    }
  }

  function selectSource(next: SourceType) {
    setSourceType(next);
    setUrl(DEFAULT_URLS[next]);
    resetWorkflow();
    setMessage("");
  }

  function activeSourceConfiguration(): SourceConfiguration {
    return sourceType === "openapi"
      ? { kind: "openapi", targetOrigin, testPageUrl, environment }
      : { kind: sourceType };
  }

  function applySource(source: ProjectSource) {
    setSourceType(source.sourceType);
    setUrl(source.sourceUrl);
    if (source.sourceConfiguration.kind === "openapi") {
      setTargetOrigin(source.sourceConfiguration.targetOrigin);
      setTestPageUrl(source.sourceConfiguration.testPageUrl);
      setEnvironment(source.sourceConfiguration.environment);
    }
  }

  function resetWorkflow() {
    const storage = browserStorage();
    if (storage) {
      try { clearClientWorkflow(storage); } catch { /* Browser storage is an optional recovery aid. */ }
    }
    clearWorkflowView();
  }

  function invalidateWebsiteAuthenticationView(): number {
    websiteAuthenticationRequestEpoch.current += 1;
    setWebsiteAuthentication(undefined);
    return websiteAuthenticationRequestEpoch.current;
  }

  function clearWorkflowView() {
    setProjectId(undefined);
    setAnalysisRunId(undefined);
    setCapabilities([]);
    setDiagnostics([]);
    setAnalysisNextStepReady(undefined);
    setWorkflowRunId(undefined);
    setGitHubOutcome(undefined);
    setGitHubAction(undefined);
    setGitHubDraftPullRequest(undefined);
    setReleaseUrl(undefined);
    setRelease(undefined);
    setVerificationEligible(undefined);
    setWebsiteOwnership(undefined);
    invalidateWebsiteAuthenticationView();
    setWebsiteHandoffError(undefined);
  }

  async function applyAnalysisStatus(
    status: AnalysisStatus,
    completedSourceType: SourceType,
    signal?: AbortSignal,
  ): Promise<void> {
    const projection = status.websiteUserHandoff?.authentication;
    if (completedSourceType === "website" && projection
      && ["expired", "failed", "cancelled"].includes(projection.state)) {
      setCapabilities(status.capabilities);
      setDiagnostics(status.result?.diagnostics ?? []);
      setAnalysisNextStepReady(false);
      setVerificationEligible(undefined);
      const authentication = await refreshWebsiteAuthentication(status, signal);
      setMessage(authenticationMessage(authentication));
      return;
    }
    if (status.run.status === "waiting") {
      setCapabilities(status.capabilities);
      setDiagnostics(status.result?.diagnostics ?? []);
      setAnalysisNextStepReady(false);
      setVerificationEligible(undefined);
      if (completedSourceType !== "website") throw new Error("ANALYSIS_WAIT_STATE_INVALID");
      const authentication = await refreshWebsiteAuthentication(status, signal);
      setMessage(authenticationMessage(authentication));
      return;
    }
    invalidateWebsiteAuthenticationView();
    applyCompletedAnalysis(status, completedSourceType);
  }

  function applyCompletedAnalysis(completed: AnalysisStatus, completedSourceType: SourceType) {
    const completion = analysisCompletion(completedSourceType, completed);
    setCapabilities(completed.capabilities);
    setDiagnostics(completion.diagnostics);
    setAnalysisNextStepReady(completion.nextStepReady);
    setVerificationEligible(undefined);
    setMessage(completion.summary);
  }

  useEffect(() => {
    const storage = browserStorage();
    const restored = storage ? loadWorkflow(storage) : undefined;
    if (!restored) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      applySource({
        sourceType: restored.sourceType,
        sourceUrl: restored.url,
        sourceConfiguration: restored.sourceConfiguration ?? defaultSourceConfiguration(restored.sourceType, restored.url)
      });
      setProjectId(restored.projectId);
      setAnalysisRunId(restored.analysisRunId);
      setWorkflowRunId(restored.workflowRunId);
      if (restored.projectId) void refreshProject(restored.projectId, controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) setMessage(`Project recovery failed: ${errorCode(error)}`);
      });
      if (!restored.analysisRunId) return;
      setBusy(true);
      void waitForAnalysis(restored.analysisRunId, controller.signal)
        .then(async (completed) => {
          await applyAnalysisStatus(completed, restored.sourceType, controller.signal);
          if (restored.sourceType === "github" && restored.workflowRunId) {
            const workflow = await waitForGitHubWorkflow(restored.workflowRunId, controller.signal);
            const githubRecovery = githubProjectRecovery(workflow.workflow, workflow.draftPullRequest);
            setWorkflowRunId(githubRecovery.workflowRunId);
            setGitHubOutcome(githubRecovery.outcome);
            setGitHubAction(githubRecovery.action);
            setGitHubDraftPullRequest(workflow.draftPullRequest);
            persistWorkflow(withWorkflowRunId(restored, githubRecovery.workflowRunId));
            setMessage(gitHubWorkflowMessage(workflow));
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof GitHubWorkflowRunError && error.terminal) {
            setWorkflowRunId(undefined);
            setGitHubOutcome("github_workflow_terminal_without_installation");
            setGitHubAction("retry");
            persistWorkflow(withWorkflowRunId(restored, undefined));
          } else if (error instanceof AnalysisRunError && error.terminal) {
            setAnalysisRunId(undefined);
            persistWorkflow({ ...restored, analysisRunId: undefined, releaseUrl: undefined });
          }
          setMessage(`${error instanceof GitHubWorkflowRunError ? "GitHub workflow" : "Analysis recovery"} failed: ${errorCode(error)}`);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    });
    return () => controller.abort();
    // Recovery intentionally consumes only the immutable snapshot loaded once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayedInstallationState = release
    ? releaseInstallationState({
      installed: release.installation.installed,
      productionVerified: release.installation.productionVerified,
      ...(release.installation.attestation ? { attestation: release.installation.attestation } : {}),
    })
    : undefined;

  return <section aria-labelledby="project-entry-heading">
    <h2 id="project-entry-heading">Create a project</h2>
    <form onSubmit={signIn}>
      <label>Email <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>Password <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <button type="submit" disabled={busy}>Sign in</button>
      <button type="button" disabled={busy || password.length < 12} onClick={signUp}>Create account</button>
      <button type="button" disabled={busy || !email} onClick={recoverPassword}>Recover password</button>
    </form>
    {recoveryMode && <p><button type="button" disabled={busy || password.length < 12}
      onClick={setNewPassword}>Set new password</button></p>}
    {signedInRole && <p>Signed in with current {signedInRole} membership. <button type="button" disabled={busy} onClick={signOut}>Sign out</button>{" "}
      <button type="button" disabled={busy} onClick={revokeAllSessions}>Sign out all devices</button></p>}
    {projects.length > 0 && <section aria-labelledby="existing-projects-heading">
      <h3 id="existing-projects-heading">Your projects</h3>
      <ul>{projects.map((project) => <li key={project.id}>
        {project.name} ({project.sourceType}, {project.status}) <button type="button" disabled={busy}
          onClick={() => resumeProject(project.id)}>Open and resume</button>
      </li>)}</ul>
      {nextProjectsCursor && <button type="button" disabled={busy} onClick={loadMoreProjects}>Load more projects</button>}
    </section>}
    <form onSubmit={createProject}>
      <label htmlFor="source-type">Source type</label>
      <select id="source-type" value={sourceType} onChange={(event) => selectSource(event.target.value as SourceType)}>
        <option value="website">Website URL</option>
        <option value="openapi">OpenAPI URL</option>
        <option value="github">GitHub repository</option>
      </select>
      <p id="source-guidance">Choose a public source you are authorized to inspect. Browser recovery is only an aid; reopening a project reloads its source configuration from the server.</p>
      <label>{sourceType === "openapi" ? "OpenAPI source URL" : sourceType === "github" ? "GitHub repository URL" : "Website URL"} <input type="url" value={url} onChange={(event) => { setUrl(event.target.value); resetWorkflow(); }} required /></label>
      {sourceType === "openapi" && <fieldset aria-describedby="openapi-guidance">
        <legend>OpenAPI verification context</legend>
        <p id="openapi-guidance">Use a same-origin test page for local or staging analysis. Production selections require explicit verification before publication.</p>
        <label>Target origin <input type="url" value={targetOrigin} onChange={(event) => { setTargetOrigin(event.target.value); resetWorkflow(); }} required /></label>
        <label>Same-origin test page URL <input type="url" value={testPageUrl} onChange={(event) => { setTestPageUrl(event.target.value); resetWorkflow(); }} required /></label>
        <label>Environment <select value={environment} onChange={(event) => { setEnvironment(event.target.value as "test" | "staging" | "production"); resetWorkflow(); }}>
          <option value="test">Test</option><option value="staging">Staging</option><option value="production">Production</option>
        </select></label>
      </fieldset>}
      <button type="submit" disabled={busy || !signedInRole}>Create project</button>
    </form>
    {sourceType === "website" && projectId && <section aria-labelledby="website-ownership-heading">
      <h3 id="website-ownership-heading">Verify website ownership</h3>
      <p>Ownership is bound to this exact active website source. Page2WebMCP will not start Browser Use discovery before the external proof is verified.</p>
      {websiteOwnership?.state === "verified"
        ? <p>Ownership verified for <code>{websiteOwnership.targetOrigin}</code>.</p>
        : <button type="button" disabled={busy || handoffBusy}
          onClick={() => mutateWebsiteOwnership("challenge")}>Create ownership challenge</button>}
      {websiteOwnership?.state === "pending" && <>
        <p>Challenge expires at {websiteOwnership.expiresAt}.</p>
        {websiteOwnership.method === "dns_txt" ? <dl>
          <dt>DNS record</dt><dd><code>{websiteOwnership.instructions.recordName}</code></dd>
          <dt>Type</dt><dd>{websiteOwnership.instructions.recordType}</dd>
          <dt>Value</dt><dd><code>{websiteOwnership.instructions.recordValue}</code></dd>
        </dl> : <dl>
          <dt>File URL</dt><dd><code>{websiteOwnership.instructions.url}</code></dd>
          <dt>Exact file content</dt><dd><pre>{websiteOwnership.instructions.content}</pre></dd>
        </dl>}
        <button type="button" disabled={busy || handoffBusy}
          onClick={() => mutateWebsiteOwnership("check")}>Check ownership</button>
      </>}
      {websiteOwnership && ["expired", "failed"].includes(websiteOwnership.state)
        && <p>Ownership state: {websiteOwnership.state}. Create a fresh challenge.</p>}
    </section>}
    {sourceType === "website" && websiteAuthentication && <section aria-labelledby="website-authentication-heading">
      <h3 id="website-authentication-heading">
        {["waiting", "ready"].includes(websiteAuthentication.state) ? "Authentication required" : "Website authentication"}
      </h3>
      <p>Sign in through the bounded gateway portal. Page2WebMCP receives deterministic evidence, never your credentials.</p>
      <dl>
        <dt>Target origin</dt><dd><code>{websiteAuthentication.targetOrigin}</code></dd>
        <dt>Checkpoint expires</dt><dd>{websiteAuthentication.expiresAt}</dd>
        <dt>State</dt><dd>{websiteAuthentication.state}</dd>
      </dl>
      {websiteAuthentication.canAct && websiteAuthentication.portalUrl && <p>
        <a href={websiteAuthentication.portalUrl} target="_blank" rel="noopener noreferrer">Open sign-in</a>
      </p>}
      {websiteAuthentication.canAct && <p>
        <button type="button" disabled={busy || handoffBusy}
          onClick={() => mutateWebsiteAuthentication("check")}>Check sign-in state</button>{" "}
        <button type="button" disabled={busy || handoffBusy}
          onClick={() => mutateWebsiteAuthentication("cancel")}>Cancel website analysis</button>
      </p>}
      {!websiteAuthentication.canAct && websiteAuthentication.state === "waiting"
        && <p>Your current membership can view this wait but cannot open or update the authentication handoff.</p>}
      {websiteAuthentication.state === "expired"
        && <p>The authentication checkpoint expired. Start website analysis again to create a fresh session.</p>}
      {websiteAuthentication.state === "failed"
        && <p>The authentication gateway failed closed. Retry website analysis after the operator resolves the gateway.</p>}
      {websiteAuthentication.state === "cancelled" && <p>This website analysis was cancelled.</p>}
    </section>}
    <p>Local-live processing uses durable local services and a real provider, but it is not production verification. Production requires a stored native installation attestation for the exact published hash.</p>
    <button type="button" onClick={analyze}
      disabled={busy || !projectId || sourceType === "website" && websiteOwnership?.state !== "verified"}>
      {analysisRunId ? "Resume analysis" : `Analyze ${sourceType}`}
    </button>
    {message && <p role="status">{message}</p>}
    {websiteHandoffError && <p role="alert">Website handoff unavailable: <code>{websiteHandoffError}</code></p>}
    {diagnostics.length > 0 && <section aria-labelledby="analysis-diagnostics-heading">
      <h3 id="analysis-diagnostics-heading">Analysis diagnostics</h3>
      <ul>{diagnostics.map((diagnostic) => <li key={`${diagnostic.code}:${diagnostic.operationKey}`}>
        <code>{diagnostic.code}</code>: <code>{diagnostic.operationKey}</code> — {diagnostic.reason ?? "no additional reason"}
      </li>)}</ul>
    </section>}
    {capabilities.length > 0 && <ul aria-label="Capabilities">{capabilities.map((capability) => {
      const exact = capabilityReviewPresentation(capability);
      return <li key={capability.id}><details><summary>Exact reviewed capability <code>{capability.stableName}</code>: {capability.status}</summary>
        <dl>
          <dt>Plan digest</dt><dd><code>{exact.planDigest}</code> (version {exact.version})</dd>
          <dt>Risk and effects</dt><dd>{exact.risk.tier}; {exact.risk.effect}; {exact.risk.confirmation}; {exact.risk.reversible ? "reversible" : "not reversible"}; {exact.risk.summary}</dd>
          <dt>Authentication</dt><dd>{exact.authentication.mode}; CSRF {exact.authentication.csrf ? "reviewed" : "not applicable"}</dd>
          <dt>Required scopes</dt><dd>{exact.authentication.requiredScopes.join(", ") || "none"}</dd>
          <dt>Request plan</dt><dd>{exact.request.adapter}; {exact.request.method}; <code>{exact.request.target}</code>; {exact.request.idempotency}</dd>
          <dt>Input schema</dt><dd><code>{JSON.stringify(exact.schemas.input)}</code></dd>
          <dt>Output schema</dt><dd><code>{JSON.stringify(exact.schemas.output)}</code></dd>
          <dt>Evidence provenance</dt><dd>{exact.provenance.map(({ source, reference }) =>
            <code key={`${source}:${reference}`}>{source}: {reference} </code>)}</dd>
        </dl></details> {capability.status !== "blocked" && <>
        <button type="button" disabled={busy} onClick={() => review(capability, "approve")}>Approve {capability.stableName}</button>
        <button type="button" disabled={busy} onClick={() => review(capability, "block")}>Block {capability.stableName}</button>
      </>}</li>;
    })}</ul>}
    {sourceType !== "github" && <button type="button" onClick={verifyExactCandidate} disabled={busy || !analysisRunId || analysisNextStepReady !== true}>Verify exact candidate</button>}
    {verificationEligible === false && <p>Verification is not eligible; publish and install remain blocked.</p>}
    <button type="button" onClick={publish} disabled={busy || !analysisRunId || analysisNextStepReady !== true
      || (sourceType !== "github" && verificationEligible !== true)
      || (sourceType === "github" && ["complete", "blocked"].includes(githubAction ?? "create"))}>
      {sourceType === "github"
        ? githubAction === "complete"
          ? "Draft PR created"
          : githubAction === "blocked"
            ? "GitHub workflow state unavailable"
          : workflowRunId
            ? "Resume tested patch workflow"
            : githubOutcome === "github_workflow_terminal_without_installation"
              ? "Retry tested patch and draft PR"
              : "Create tested patch and draft PR"
        : "Publish immutable release"}
    </button>
    {releaseUrl && <a href={releaseUrl}>Download immutable release</a>}
    {release && <section aria-label="Installation">
      <h3>Immutable release</h3>
      {displayedInstallationState && <p>{displayedInstallationState.label}</p>}
      <dl>
        <dt>SHA-256</dt><dd><code>{release.installation.contentHash}</code></dd>
        <dt>SRI</dt><dd><code>{release.installation.integrity}</code></dd>
        <dt>Expected target origin</dt><dd><code>{release.installation.targetOrigin}</code></dd>
        <dt>WebMCP compatibility</dt><dd>{release.installation.compatibility.webMcp}</dd>
        <dt>Previous immutable release</dt><dd>{release.installation.previousRelease
          ? <code>{release.installation.previousRelease.contentHash}</code>
          : "none"}</dd>
      </dl>
      {release.installation.attestation && <details><summary>Installed-target attestation</summary><dl>
        <dt>Status</dt><dd>{release.installation.attestation.status}</dd>
        <dt>Verifier mode</dt><dd>{release.installation.attestation.verifierMode}</dd>
        <dt>Delivery</dt><dd>{release.installation.attestation.delivery}</dd>
        <dt>Verified page</dt><dd><code>{release.installation.attestation.pageUrl}</code></dd>
        <dt>Executed SHA-256</dt><dd><code>{release.installation.attestation.executedContentHash ?? "not executed"}</code></dd>
        <dt>Registered tools</dt><dd>{release.installation.attestation.registeredTools.join(", ") || "none"}</dd>
        <dt>Verified at</dt><dd>{release.installation.attestation.verifiedAt ?? "not verified"}</dd>
      </dl></details>}
      <details><summary>Manifest</summary><pre>{JSON.stringify(release.installation.manifest, null, 2)}</pre></details>
      <details><summary>Module script tag</summary><pre>{release.installation.moduleScriptTag}</pre></details>
      <button type="button" disabled={busy} onClick={copyTrustedLoaderScript}>Copy trusted-loader script</button>{" "}
      <a href={release.installation.downloadUrl}>Download exact artifact bytes</a>
      {release.installation.localOnly && <p>Local-only artifact: self-host these exact bytes before production installation.</p>}
      <p>{release.installation.selfHost.guidance}</p>
      <label>Self-hosted artifact URL <input type="url" value={selfHostedUrl}
        onChange={(event) => setSelfHostedUrl(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={checkInstalledTarget}>Check installed target</button>
    </section>}
    {githubDraftPullRequest && <section aria-labelledby="github-draft-heading">
      <h3 id="github-draft-heading">Real GitHub draft pull request</h3>
      <p><a href={githubDraftPullRequest.url} target="_blank" rel="noreferrer">
        {githubDraftPullRequest.repository.owner}/{githubDraftPullRequest.repository.name} #{githubDraftPullRequest.number}
      </a></p>
      <dl>
        <dt>Branch</dt><dd><code>{githubDraftPullRequest.branch}</code></dd>
        <dt>Base commit</dt><dd><code>{githubDraftPullRequest.baseCommitSha}</code></dd>
        <dt>Head commit</dt><dd><code>{githubDraftPullRequest.headCommitSha}</code></dd>
        <dt>Check</dt><dd>{githubDraftPullRequest.check.status}{githubDraftPullRequest.check.conclusion
          ? ` / ${githubDraftPullRequest.check.conclusion}` : ""}</dd>
      </dl>
      <p>This pull request is draft-only. Page2WebMCP never merged or installed it.</p>
    </section>}
    {githubOutcome === "tested_patch_draft_pull_request_pending" && !githubDraftPullRequest
      && <p>GitHub workflow pending; no draft pull request is claimed yet.</p>}
  </section>;
}

class AnalysisRunError extends Error {
  constructor(message: string, readonly terminal: boolean) {
    super(message);
  }
}

class GitHubWorkflowRunError extends Error {
  constructor(message: string, readonly terminal: boolean) {
    super(message);
  }
}

async function waitForAnalysis(
  runId: string,
  signal?: AbortSignal,
): Promise<AnalysisStatus> {
  const deadline = Date.now() + ANALYSIS_POLL_DEADLINE_MS;
  let delayMs = 250;
  while (Date.now() < deadline) {
    const body = await analysisStatus(runId, signal);
    if (body.run.status === "succeeded" || body.run.status === "waiting") return body;
    if (body.run.status === "failed" || body.run.status === "cancelled") {
      throw new AnalysisRunError(body.run.errorCode ?? "ANALYSIS_FAILED", true);
    }
    await abortableDelay(delayMs, signal);
    delayMs = Math.min(Math.round(delayMs * 1.5), 2_000);
  }
  throw new AnalysisRunError("ANALYSIS_DEADLINE_EXCEEDED", false);
}

async function analysisStatus(runId: string, signal?: AbortSignal): Promise<AnalysisStatus> {
  const { response, body } = await requestJson<AnalysisStatus & ApiFailure>(
    `/api/analysis-runs/${encodeURIComponent(runId)}`,
    { cache: "no-store", signal }
  );
  if (!response.ok) throw new Error(body.code ?? "ANALYSIS_STATUS_FAILED");
  return body;
}

async function waitForGitHubWorkflow(runId: string, signal?: AbortSignal): Promise<GitHubWorkflowStatus> {
  const deadline = Date.now() + ANALYSIS_POLL_DEADLINE_MS;
  let delayMs = 250;
  while (Date.now() < deadline) {
    const { response, body } = await requestJson<GitHubWorkflowStatus & ApiFailure>(
      `/api/workflow-runs/${encodeURIComponent(runId)}`,
      { cache: "no-store", signal }
    );
    if (!response.ok) throw new Error(body.code ?? "GITHUB_WORKFLOW_STATUS_FAILED");
    if (body.workflow.status === "succeeded") return body;
    if (body.workflow.status === "failed" || body.workflow.status === "cancelled") {
      throw new GitHubWorkflowRunError(body.workflow.errorCode ?? "GITHUB_WORKFLOW_FAILED", true);
    }
    await abortableDelay(delayMs, signal);
    delayMs = Math.min(Math.round(delayMs * 1.5), 2_000);
  }
  throw new GitHubWorkflowRunError("GITHUB_WORKFLOW_DEADLINE_EXCEEDED", false);
}

function gitHubWorkflowMessage(status: GitHubWorkflowStatus): string {
  if (status.draftPullRequest) {
    return `Draft pull request #${status.draftPullRequest.number} reconciled at the exact head commit; nothing was merged or installed.`;
  }
  if (status.workflow.status === "failed" || status.workflow.status === "cancelled") {
    return `GitHub workflow ${status.workflow.status}; no draft pull request is claimed.`;
  }
  return "GitHub workflow has no persisted draft pull request identity yet; no pull request is claimed.";
}

function authenticationMessage(authentication: WebsiteAuthenticationState): string {
  if (authentication.state === "waiting") {
    return authentication.canAct
      ? "Authentication required. Open sign-in, then ask the server to check gateway evidence."
      : "Website analysis is waiting for authentication by an owner or editor.";
  }
  if (authentication.state === "ready") return "Authentication evidence is ready for server-side verification.";
  if (authentication.state === "resumed") return "Authentication verified; website analysis resumed.";
  if (authentication.state === "expired") return "Authentication checkpoint expired. Start website analysis again.";
  if (authentication.state === "cancelled") return "Website analysis cancelled.";
  return "Authentication gateway failed closed. Retry after the operator resolves the gateway.";
}

async function postIdempotent<T extends ApiFailure>(url: string, body: unknown, operation: string) {
  const requestBody = JSON.stringify(body);
  const storage = browserStorage();
  let key = crypto.randomUUID();
  if (storage) {
    try { key = operationKey(storage, operation, requestBody); } catch { /* Continue without persistence. */ }
  }
  let last: Awaited<ReturnType<typeof requestJson<T>>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      last = await requestJson<T>(url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: requestBody
      });
      if (!isRetryableStatus(last.response.status)) {
        if (storage) {
          try { completeOperation(storage, operation, key); } catch { /* Continue without persistence. */ }
        }
        return last;
      }
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return last!;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const headers = new Headers(init.headers);
    if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
      headers.set("x-csrf-token", await currentCsrfToken(signal, anonymousCsrfRoutes.has(url)));
    }
    const response = await fetch(url, { ...init, headers, signal });
    const body = await response.json() as T;
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function currentCsrfToken(signal: AbortSignal, anonymousOnly = false): Promise<string> {
  if (!anonymousOnly) {
    const session = await fetch("/api/auth/session", { cache: "no-store", signal });
    if (session.ok) {
      const body = await session.json() as { csrfToken?: string };
      if (body.csrfToken) return body.csrfToken;
    }
  }
  const anonymous = await fetch("/api/auth/csrf", { cache: "no-store", signal });
  const body = await anonymous.json() as { csrfToken?: string; code?: string };
  if (!anonymous.ok || !body.csrfToken) throw new Error(body.code ?? "CSRF_TOKEN_REQUIRED");
  return body.csrfToken;
}

async function loadServerSession(signal: AbortSignal): Promise<{ role: string } | undefined> {
  const response = await fetch("/api/auth/session", { cache: "no-store", signal });
  if (!response.ok) return undefined;
  const body = await response.json() as { actor?: { role?: string } };
  return body.actor?.role ? { role: body.actor.role } : undefined;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function browserStorage(): Storage | undefined {
  try { return globalThis.sessionStorage; } catch { return undefined; }
}

function persistWorkflow(workflow: PersistedWorkflow): void {
  const storage = browserStorage();
  if (!storage) return;
  try { saveWorkflow(storage, workflow); } catch { /* Browser storage is an optional recovery aid. */ }
}

function withWorkflowRunId(workflow: PersistedWorkflow, workflowRunId: string | undefined): PersistedWorkflow {
  const recovered = { ...workflow };
  delete recovered.workflowRunId;
  return workflowRunId ? { ...recovered, workflowRunId } : recovered;
}

function removePersistedWorkflow(): void {
  const storage = browserStorage();
  if (!storage) return;
  try { clearStoredWorkflow(storage); } catch { /* Browser storage is an optional recovery aid. */ }
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
    ? error.message
    : "REQUEST_FAILED";
}

function analysisFailureMessage(error: unknown): string {
  const code = errorCode(error);
  return code === "PROVIDER_UNAVAILABLE" ? `Source provider unavailable: ${code}` : `Analysis failed: ${code}`;
}

function defaultSourceConfiguration(sourceType: SourceType, sourceUrl: string): SourceConfiguration {
  if (sourceType !== "openapi") return { kind: sourceType };
  const origin = new URL(sourceUrl).origin;
  return { kind: "openapi", targetOrigin: origin, testPageUrl: `${origin}/`, environment: "test" };
}

function validateSourceConfiguration(configuration: SourceConfiguration): string | undefined {
  if (configuration.kind !== "openapi") return undefined;
  try {
    const target = new URL(configuration.targetOrigin);
    const testPage = new URL(configuration.testPageUrl);
    if (target.protocol !== "https:" || testPage.protocol !== "https:" || target.origin !== testPage.origin
      || target.username || target.password || target.pathname !== "/" || target.search || target.hash
      || testPage.username || testPage.password || testPage.search || testPage.hash) {
      return "OpenAPI verification context invalid: TEST_PAGE_SAME_ORIGIN_REQUIRED";
    }
  } catch {
    return "OpenAPI verification context invalid: TEST_PAGE_SAME_ORIGIN_REQUIRED";
  }
  return undefined;
}
