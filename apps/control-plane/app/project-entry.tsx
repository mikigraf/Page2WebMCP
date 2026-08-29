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
  result?: { draftPullRequest?: { draft: boolean } };
  capabilities: Capability[];
};

const DEFAULT_URLS: Record<SourceType, string> = {
  website: "https://acme.example",
  openapi: "https://acme.example/openapi.json",
  github: "https://github.com/acme/support"
};
const ANALYSIS_POLL_DEADLINE_MS = 10 * 60_000;

export function ProjectEntry() {
  const [sourceType, setSourceType] = useState<SourceType>("website");
  const [url, setUrl] = useState(DEFAULT_URLS.website);
  const [message, setMessage] = useState("");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [draftReady, setDraftReady] = useState(false);
  const [projectId, setProjectId] = useState<string>();
  const [analysisRunId, setAnalysisRunId] = useState<string>();
  const [releaseUrl, setReleaseUrl] = useState<string>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signedInRole, setSignedInRole] = useState("");
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
      setReleaseUrl(restored.releaseUrl);
      if (!restored.analysisRunId) return;
      setBusy(true);
      void waitForAnalysis(restored.analysisRunId, controller.signal)
        .then((completed) => {
          setCapabilities(completed.capabilities);
          setDraftReady(completed.result?.draftPullRequest?.draft === true);
          setMessage(`Analysis complete for ${restored.sourceType}`);
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
      if (analysisRunId) {
        try {
          const completed = await waitForAnalysis(analysisRunId);
          setCapabilities(completed.capabilities);
          setDraftReady(completed.result?.draftPullRequest?.draft === true);
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
      persistWorkflow({ sourceType, url, projectId: body.id });
      setMessage(`Project ${body.id} created`);
    } catch (error) {
      setMessage(`Project creation failed: ${errorCode(error)}`);
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
      setDraftReady(false);
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
      setDraftReady(completed.result?.draftPullRequest?.draft === true);
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
      setMessage(`Publication failed: ${errorCode(error)}`);
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
    setDraftReady(false);
    setReleaseUrl(undefined);
  }

  return <section aria-labelledby="project-entry-heading">
    <h2 id="project-entry-heading">Create a project</h2>
    <form onSubmit={signIn}>
      <label>Email <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>Password <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <button type="submit" disabled={busy}>Sign in</button>
    </form>
    {signedInRole && <p>Signed in as {signedInRole}</p>}
    <form onSubmit={createProject}>
      <label>Source type <select value={sourceType} onChange={(event) => selectSource(event.target.value as SourceType)}>
        <option value="website">Website URL</option>
        <option value="openapi">OpenAPI URL</option>
        <option value="github">GitHub repository</option>
      </select></label>
      <label>Source URL (fixed Acme fixture) <input type="url" value={url} onChange={(event) => { setUrl(event.target.value); resetWorkflow(); }} required /></label>
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
    <button type="button" onClick={publish} disabled={busy || !analysisRunId || sourceType === "github"}>Publish immutable release</button>
    {releaseUrl && <a href={releaseUrl}>Download Acme release</a>}
    {draftReady && <p>Draft pull request prepared</p>}
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
    const response = await fetch(url, { ...init, signal });
    const body = await response.json() as T;
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
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
