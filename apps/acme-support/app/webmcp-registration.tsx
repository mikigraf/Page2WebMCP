"use client";

import { useEffect } from "react";

type ConfirmationRequest = { toolName: string; input: Record<string, unknown>; idempotencyKey: string; signal: AbortSignal };
type Diagnostic = { phase: "load" | "registration" | "execution"; code: string };
type Artifact = {
  registerPage2WebMCPTools: (bridge: {
    confirm: (request: ConfirmationRequest) => boolean | Promise<boolean>;
    onDiagnostic: (event: Omit<Diagnostic, "phase"> & { phase: "registration" | "execution" }) => void;
  }) => Promise<{ supported: boolean }>;
  unregisterPage2WebMCPTools: () => void;
};
type ArtifactWindow = Window & { __acmeWebMcpArtifact?: Promise<Artifact> };
const MAX_ARTIFACT_BYTES = 65_536;
const ARTIFACT_LOAD_DEADLINE_MS = 15_000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeDiagnostic(callback: ((event: Diagnostic) => void) | undefined, event: Diagnostic): void {
  try { callback?.(event); } catch { /* diagnostics never affect the app */ }
}

function assertLoadActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("WEBMCP_RELEASE_TIMEOUT");
  }
}

async function readArtifactSource(response: Response, signal: AbortSignal): Promise<string> {
  const declaredHeader = response.headers.get("content-length");
  const declaredLength = declaredHeader === null ? 0 : Number(declaredHeader);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTIFACT_BYTES) {
    await response.body?.cancel();
    throw new Error("WEBMCP_RELEASE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      assertLoadActive(signal);
      const { done, value } = await reader.read();
      assertLoadActive(signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new Error("WEBMCP_RELEASE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const source = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    source.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(source);
}

async function withArtifactLoadDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error("WEBMCP_RELEASE_TIMEOUT");
  const timer = setTimeout(() => controller.abort(timeoutError), ARTIFACT_LOAD_DEADLINE_MS);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadWebMcpArtifact(onDiagnostic?: (event: Diagnostic) => void): Promise<Artifact> {
  const target = window as ArtifactWindow;
  if (target.__acmeWebMcpArtifact) return target.__acmeWebMcpArtifact;
  const pending = (async () => {
    try {
      return await withArtifactLoadDeadline(async (signal) => {
        const response = await fetch("/api/releases/acme", { cache: "no-store", credentials: "same-origin", signal });
        assertLoadActive(signal);
        if (!response.ok) throw new Error("WEBMCP_RELEASE_UNAVAILABLE");
        const source = await readArtifactSource(response, signal);
        assertLoadActive(signal);
        const expectedHash = response.headers.get("x-page2webmcp-content-hash");
        if (!expectedHash || await sha256Hex(source) !== expectedHash) throw new Error("WEBMCP_RELEASE_INTEGRITY_FAILED");
        assertLoadActive(signal);
        const objectUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        try {
          const artifact = await import(/* webpackIgnore: true */ objectUrl) as Artifact;
          assertLoadActive(signal);
          return artifact;
        } catch (error) {
          assertLoadActive(signal);
          if (error instanceof Error && error.message === "WEBMCP_RELEASE_IMPORT_FAILED") throw error;
          throw new Error("WEBMCP_RELEASE_IMPORT_FAILED");
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      });
    } catch (error) {
      delete target.__acmeWebMcpArtifact;
      const message = error instanceof Error ? error.message : "WEBMCP_RELEASE_UNAVAILABLE";
      const code = message === "WEBMCP_RELEASE_INTEGRITY_FAILED" ? "INTEGRITY_FAILED"
        : message === "WEBMCP_RELEASE_IMPORT_FAILED" ? "IMPORT_FAILED"
        : message === "WEBMCP_RELEASE_TIMEOUT" ? "LOAD_TIMEOUT"
        : message === "WEBMCP_RELEASE_TOO_LARGE" ? "RESPONSE_TOO_LARGE"
        : "RELEASE_UNAVAILABLE";
      safeDiagnostic(onDiagnostic, { phase: "load", code });
      throw new Error(message.startsWith("WEBMCP_RELEASE_") ? message : "WEBMCP_RELEASE_UNAVAILABLE");
    }
  })();
  target.__acmeWebMcpArtifact = pending;
  return pending;
}

function confirmMutation(request: ConfirmationRequest): boolean {
  if (request.toolName !== "create_support_ticket") return false;
  const { orderId, title, priority } = request.input;
  return window.confirm(`Create support ticket?\n\nOrder: ${String(orderId)}\nTitle: ${String(title)}\nPriority: ${String(priority)}`);
}

export function WebMCPRegistration() {
  useEffect(() => {
    let disposed = false;
    let artifact: Artifact | undefined;
    const report = (event: Diagnostic) => window.dispatchEvent(new CustomEvent("page2webmcp:diagnostic", { detail: event }));
    void loadWebMcpArtifact(report).then(async (loaded) => {
      if (disposed) return;
      artifact = loaded;
      await artifact.registerPage2WebMCPTools({ confirm: confirmMutation, onDiagnostic: report });
      if (disposed) artifact.unregisterPage2WebMCPTools();
    }).catch(() => {
      // WebMCP is progressive enhancement; the app remains usable without it.
    });
    return () => {
      disposed = true;
      artifact?.unregisterPage2WebMCPTools();
    };
  }, []);
  return null;
}
