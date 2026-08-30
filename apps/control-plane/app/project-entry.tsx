"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  clearClientWorkflow,
  clearWorkflow as clearStoredWorkflow,
  completeOperation,
  loadWorkflow,
  operationKey,
  saveWorkflow,
  type PersistedWorkflow,
  type SourceType
} from "../src/client-workflow.ts";

type Capability = {
  id: string;
  stableName: string;
  riskTier: "R0" | "R1" | "R2" | "R3";
  status: "proposed" | "reviewed" | "verified" | "blocked";
  version: number;
};
type ApiFailure = { code?: string };
type AnalysisStatus = {
  run: { status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; errorCode?: string };
  capabilities: Capability[];
};
type GitHubWorkflowStatus = {
  workflow: { status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled"; errorCode?: string };
  outcome: "tested_patch_draft_pull_request_pending" | "tested_patch_draft_pull_request_check_preview_reconciled" | "github_workflow_terminal_without_installation";
};
type ProjectSummary = {
  id: string;
  name: string;
  sourceType: SourceType;
  url: string;
  status: string;
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
  const [message, setMessage] = useState(authState === "recovery"
    ? "Choose a new password to finish recovery."
    : authState === "verified"
      ? "Email verified. Your personal organization is ready."
      : "");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [workflowRunId, setWorkflowRunId] = useState<string>();
  const [githubOutcome, setGitHubOutcome] = useState<GitHubWorkflowStatus["outcome"]>();
  const [projectId, setProjectId] = useState<string>();
  const [analysisRunId, setAnalysisRunId] = useState<string>();
  const [releaseUrl, setReleaseUrl] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedInRole, setSignedInRole] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [nextProjectsCursor, setNextProjectsCursor] = useState<string>();
  const [recoveryMode, setRecoveryMode] = useState(authState === "recovery");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const storage = browserStorage();
    const restored = storage ? loadWorkflow(storage) : undefined;
    if (!restored) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setSourceType(restored.sourceType);
      setUrl(restored.url);
      setProjectId(restored.projectId);
      setAnalysisRunId(restored.analysisRunId);
      setWorkflowRunId(restored.workflowRunId);
      setReleaseUrl(restored.releaseUrl);
      if (!restored.analysisRunId) return;
      setBusy(true);
      void waitForAnalysis(restored.analysisRunId, controller.signal)
        .then(async (completed) => {
          setCapabilities(completed.capabilities);
          if (restored.sourceType === "github" && restored.workflowRunId) {
            const workflow = await waitForGitHubWorkflow(restored.workflowRunId, controller.signal);
            setGitHubOutcome(workflow.outcome);
            setMessage(workflow.outcome === "tested_patch_draft_pull_request_check_preview_reconciled"
              ? "Tested patch and draft pull request reconciled"
              : `GitHub workflow ${workflow.workflow.status}`);
          } else setMessage(`Analysis complete for ${restored.sourceType}`);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof AnalysisRunError && error.terminal) {
            setAnalysisRunId(undefined);
            persistWorkflow({ ...restored, analysisRunId: undefined, releaseUrl: undefined });
          }
          setMessage(`Analysis recovery failed: ${errorCode(error)}`);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    });
    return () => controller.abort();
  }, []);

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
          setCapabilities(completed.capabilities);
          setMessage(`Analysis complete for ${sourceType}`);
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
    setBusy(true);
    clearWorkflowView();
    removePersistedWorkflow();
    try {
      const { response, body } = await postIdempotent<{ id?: string } & ApiFailure>(
        "/api/projects",
        { sourceType, url },
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
      persistWorkflow({ sourceType, url, projectId: body.id });
      setMessage(`Project ${body.id} created`);
    } catch (error) {
      setMessage(`Project creation failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function resumeProject(id: string) {
    setBusy(true);
    try {
      const { response, body } = await requestJson<{
        project?: ProjectSummary;
        latestAnalysis?: { id: string; status: AnalysisStatus["run"]["status"] };
        capabilities?: Capability[];
      } & ApiFailure>(`/api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!response.ok || !body.project) throw new Error(body.code ?? "PROJECT_LOAD_FAILED");
      setSourceType(body.project.sourceType);
      setUrl(body.project.url);
      setProjectId(body.project.id);
      setAnalysisRunId(body.latestAnalysis?.id);
      setCapabilities(body.capabilities ?? []);
      persistWorkflow({
        sourceType: body.project.sourceType,
        url: body.project.url,
        projectId: body.project.id,
        analysisRunId: body.latestAnalysis?.id
      });
      setMessage(body.latestAnalysis ? `Resumed ${body.project.name}` : `Loaded ${body.project.name}`);
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
    setBusy(true);
    if (!analysisRunId) {
      setCapabilities([]);
      setWorkflowRunId(undefined);
      setGitHubOutcome(undefined);
      setReleaseUrl(undefined);
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
        persistWorkflow({ sourceType, url, projectId, analysisRunId: runId });
      }
      const completed = await waitForAnalysis(runId);
      setCapabilities(completed.capabilities);
      setMessage(`Analysis complete for ${sourceType}`);
    } catch (error) {
      if (error instanceof AnalysisRunError && error.terminal) {
        setAnalysisRunId(undefined);
        persistWorkflow({ sourceType, url, projectId });
      }
      setMessage(`Analysis failed: ${errorCode(error)}`);
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
      setCapabilities((current) => current.map((item) =>
        item.id === capability.id ? body.capability! : item
      ));
      setMessage("");
    } catch (error) {
      if (analysisRunId) {
        try {
          const refreshed = await analysisStatus(analysisRunId);
          setCapabilities(refreshed.capabilities);
          const expectedStatus = action === "approve" ? "reviewed" : "blocked";
          if (refreshed.capabilities.some((item) =>
            item.id === capability.id && item.status === expectedStatus
          )) {
            setMessage("");
            return;
          }
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
          persistWorkflow({ sourceType, url, projectId, analysisRunId, workflowRunId: runId });
        }
        const completed = await waitForGitHubWorkflow(runId);
        setGitHubOutcome(completed.outcome);
        persistWorkflow({ sourceType, url, projectId, analysisRunId, workflowRunId: runId });
        setMessage("Tested patch and draft pull request/check/preview reconciled; no merge or installation was performed");
        return;
      }
      const published = await postIdempotent<{ release?: { url: string } } & ApiFailure>(
        `/api/projects/${encodeURIComponent(projectId)}/releases`,
        { analysisRunId },
        `publish:${projectId}:${analysisRunId}`
      );
      if (!published.response.ok || !published.body.release) {
        throw new Error(published.body.code ?? "RELEASE_FAILED");
      }
      setReleaseUrl(published.body.release.url);
      persistWorkflow({ sourceType, url, projectId, analysisRunId, releaseUrl: published.body.release.url });
      setMessage("Immutable release published");
    } catch (error) {
      setMessage(`${sourceType === "github" ? "GitHub workflow" : "Publication"} failed: ${errorCode(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function selectSource(next: SourceType) {
    setSourceType(next);
    setUrl(DEFAULT_URLS[next]);
    resetWorkflow();
    setMessage("");
  }

  function resetWorkflow() {
    const storage = browserStorage();
    if (storage) {
      try { clearClientWorkflow(storage); } catch { /* Browser storage is an optional recovery aid. */ }
    }
    clearWorkflowView();
  }

  function clearWorkflowView() {
    setProjectId(undefined);
    setAnalysisRunId(undefined);
    setCapabilities([]);
    setWorkflowRunId(undefined);
    setGitHubOutcome(undefined);
    setReleaseUrl(undefined);
  }

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
      <label>Source type <select value={sourceType} onChange={(event) => selectSource(event.target.value as SourceType)}>
        <option value="website">Website URL</option>
        <option value="openapi">OpenAPI URL</option>
        <option value="github">GitHub repository</option>
      </select></label>
      <label>Public source URL <input type="url" value={url} onChange={(event) => { setUrl(event.target.value); resetWorkflow(); }} required /></label>
      <button type="submit" disabled={busy || !signedInRole}>Create project</button>
    </form>
    <button type="button" onClick={analyze} disabled={busy || !projectId}>{analysisRunId ? "Resume analysis" : `Analyze ${sourceType}`}</button>
    {message && <p role="status">{message}</p>}
    {capabilities.length > 0 && <ul aria-label="Capabilities">{capabilities.map((capability) =>
      <li key={capability.id}><code>{capability.stableName}</code>: {capability.status} {capability.status !== "blocked" && <>
        <button type="button" disabled={busy} onClick={() => review(capability, "approve")}>Approve {capability.stableName}</button>
        <button type="button" disabled={busy} onClick={() => review(capability, "block")}>Block {capability.stableName}</button>
      </>}</li>
    )}</ul>}
    <button type="button" onClick={publish} disabled={busy || !analysisRunId}>
      {sourceType === "github" ? (workflowRunId ? "Resume tested patch workflow" : "Create tested patch and draft PR") : "Publish immutable release"}
    </button>
    {releaseUrl && <a href={releaseUrl}>Download immutable release</a>}
    {githubOutcome === "tested_patch_draft_pull_request_pending" && <p>GitHub workflow pending; no draft pull request is claimed yet</p>}
    {githubOutcome === "tested_patch_draft_pull_request_check_preview_reconciled" &&
      <p>Tested patch, draft pull request, check, and preview reconciled. Nothing was merged or installed.</p>}
  </section>;
}

class AnalysisRunError extends Error {
  constructor(message: string, readonly terminal: boolean) {
    super(message);
  }
}

async function waitForAnalysis(runId: string, signal?: AbortSignal): Promise<AnalysisStatus> {
  const deadline = Date.now() + ANALYSIS_POLL_DEADLINE_MS;
  let delayMs = 250;
  while (Date.now() < deadline) {
    const body = await analysisStatus(runId, signal);
    if (body.run.status === "succeeded") return body;
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
      throw new AnalysisRunError(body.workflow.errorCode ?? "GITHUB_WORKFLOW_FAILED", true);
    }
    await abortableDelay(delayMs, signal);
    delayMs = Math.min(Math.round(delayMs * 1.5), 2_000);
  }
  throw new AnalysisRunError("GITHUB_WORKFLOW_DEADLINE_EXCEEDED", false);
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
