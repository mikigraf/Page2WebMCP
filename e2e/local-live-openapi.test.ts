import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

const requiredEnvironment = [
  "PAGE2WEBMCP_E2E_CONTROL_URL",
  "PAGE2WEBMCP_E2E_INSTALL_PAGE_URL",
  "PAGE2WEBMCP_E2E_LOCAL_LIVE",
  "PAGE2WEBMCP_E2E_PROCESS_CONTROL",
  "PAGE2WEBMCP_E2E_SOURCE_URL",
  "PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN",
  "PAGE2WEBMCP_LOCAL_STACK",
  "PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN",
  "PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL",
  "PAGE2WEBMCP_PROVIDER_MODE",
  "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
  "PAGE2WEBMCP_STORAGE_MODE",
] as const;

const missingEnvironment = requiredEnvironment.filter((name) => {
  const value = process.env[name];
  if (!value) return true;
  if (name === "PAGE2WEBMCP_E2E_LOCAL_LIVE" || name === "PAGE2WEBMCP_LOCAL_STACK") return value !== "true";
  if (name === "PAGE2WEBMCP_E2E_PROCESS_CONTROL") return value !== "owned";
  if (name === "PAGE2WEBMCP_PROVIDER_MODE") return value !== "openapi";
  if (name === "PAGE2WEBMCP_STORAGE_MODE") return value !== "postgres";
  return false;
});

type Capability = Readonly<{
  id: string;
  riskTier: "R0" | "R1" | "R2" | "R3";
  status: "proposed" | "reviewed" | "verified" | "blocked";
  version: number;
}>;

type PublishedRelease = Readonly<{
  id: string;
  contentHash: string;
  sri: string;
  url: string;
  installation: Readonly<{
    artifactUrl: string;
    downloadUrl: string;
    moduleScriptTag: string;
    contentHash: string;
    integrity: string;
    localOnly: boolean;
  }>;
}>;

test("Docker local-live persists a non-Acme OpenAPI release with exact Storage identity", {
  skip: missingEnvironment.length > 0
    ? `LOCAL_LIVE_CONTROLS_REQUIRED: ${missingEnvironment.join(",")}`
    : false,
  timeout: 420_000,
}, async (context) => {
  const controlOrigin = exactOrigin(environment("PAGE2WEBMCP_E2E_CONTROL_URL"), "http:");
  assert.equal(controlOrigin, "http://127.0.0.1:3100");
  const sourceUrl = exactNonFixtureHttpsUrl(environment("PAGE2WEBMCP_E2E_SOURCE_URL"));
  const targetOrigin = exactOrigin(environment("PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN"), "https:");
  const testPageUrl = exactNonFixtureHttpsUrl(environment("PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL"));
  const installPageUrl = exactNonFixtureHttpsUrl(environment("PAGE2WEBMCP_E2E_INSTALL_PAGE_URL"));
  assert.equal(new URL(testPageUrl).origin, targetOrigin);
  assert.equal(new URL(installPageUrl).origin, targetOrigin);

  await assertDocumentedDockerTopology();
  await assertControlPortFree();
  let localLive = await LocalLiveProcesses.start(controlOrigin);
  const initialLauncherPid = localLive.pid;
  context.after(async () => { await localLive.stop(); });

  const email = `page2webmcp-local-live-${randomUUID()}@example.test`;
  const password = `Local-live-${randomUUID()}-9a!`;
  const session = new ControlPlaneSession(controlOrigin);
  const signup = await session.post<{ emailVerificationRequired: boolean; organizationId?: string }>(
    "/api/auth/signup", { email, password }, { authenticated: false },
  );
  assert.equal(signup.emailVerificationRequired, false);
  assert.match(signup.organizationId ?? "", /^[0-9a-f-]{36}$/i);

  const project = await session.post<{ id: string; sourceType: string }>("/api/projects", {
    sourceType: "openapi",
    url: sourceUrl,
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin,
      testPageUrl,
      environment: "test",
    },
  });
  assert.equal(project.sourceType, "openapi");

  const enqueued = await session.post<{ runId: string; status: string }>(
    "/api/projects/analyze", { projectId: project.id },
  );
  assert.match(enqueued.runId, /^[0-9a-f-]{36}$/i);
  const analysis = await pollAnalysis(session, enqueued.runId);
  assert.equal(analysis.run.status, "succeeded");
  assert.equal(analysis.result?.providerProvenance?.mode, "openapi");
  assert.equal(analysis.result?.providerProvenance?.fixture, false);
  assert.ok((analysis.result?.evidence?.length ?? 0) > 0);
  assert.ok(analysis.capabilities.length > 0, "real source must produce at least one capability");

  let approved = 0;
  for (const capability of analysis.capabilities) {
    if (capability.status !== "proposed") {
      if (capability.status === "reviewed") approved += 1;
      continue;
    }
    const action = capability.riskTier === "R3" ? "block" : "approve";
    const reviewed = await session.post<{ capability: Capability }>(
      `/api/capabilities/${capability.id}/review`,
      { action, expectedVersion: capability.version },
    );
    assert.equal(reviewed.capability.status, action === "approve" ? "reviewed" : "blocked");
    if (action === "approve") approved += 1;
  }
  assert.ok(approved > 0, "release requires at least one approved non-R3 capability");

  const verified = await session.post<{ verification: { eligible: boolean; verificationMode?: string } }>(
    "/api/capabilities/verify", { projectId: project.id, analysisRunId: enqueued.runId },
  );
  assert.equal(verified.verification.eligible, true);
  assert.equal(verified.verification.verificationMode, "local_live");

  const publication = await session.post<{ release: PublishedRelease }>(
    `/api/projects/${project.id}/releases`, { analysisRunId: enqueued.runId },
  );
  const release = publication.release;
  assert.equal(release.url, release.installation.artifactUrl);
  assert.equal(release.contentHash, release.installation.contentHash);
  assert.equal(release.sri, release.installation.integrity);
  assert.equal(release.installation.localOnly, true);
  assert.match(release.url, /^http:\/\/(?:127\.0\.0\.1|\[::1\]):54321\/storage\/v1\/object\/public\/page2webmcp-releases\/[a-f0-9]{64}\.js$/);
  assert.equal(release.installation.moduleScriptTag,
    `<script type="module" src="${release.url}" integrity="${release.sri}" crossorigin="anonymous"></script>`);

  const [served, downloaded] = await Promise.all([
    readArtifact(release.installation.artifactUrl),
    readArtifact(release.installation.downloadUrl),
  ]);
  assert.deepEqual(served, downloaded);
  assert.equal(createHash("sha256").update(served).digest("hex"), release.contentHash);
  assert.equal(`sha384-${createHash("sha384").update(served).digest("base64")}`, release.sri);

  const installed = await session.post<{
    installation: { status: string; verifierIdentity?: { mode?: string } };
  }>(
    `/api/projects/${project.id}/releases/${release.id}/installation`,
    { pageUrl: installPageUrl },
  );
  assert.equal(installed.installation.status, "verified");
  assert.equal(installed.installation.verifierIdentity?.mode, "local_live");

  await localLive.stop();
  await assertControlPortFree();
  localLive = await LocalLiveProcesses.start(controlOrigin);
  assert.notEqual(localLive.pid, initialLauncherPid);

  const resumed = new ControlPlaneSession(controlOrigin);
  await resumed.post("/api/auth/login", { email, password }, { authenticated: false });
  const detail = await resumed.get<{
    project: { id: string };
    source: { sourceUrl: string; sourceConfiguration: { targetOrigin: string; testPageUrl: string } };
    latestAnalysis: { id: string; status: string };
    release?: { id: string; installation: { contentHash: string; localOnly: boolean } };
  }>(`/api/projects/${project.id}`);
  assert.equal(detail.project.id, project.id);
  assert.equal(detail.source.sourceUrl, sourceUrl);
  assert.equal(detail.source.sourceConfiguration.targetOrigin, targetOrigin);
  assert.equal(detail.source.sourceConfiguration.testPageUrl, testPageUrl);
  assert.equal(detail.latestAnalysis.id, enqueued.runId);
  assert.equal(detail.latestAnalysis.status, "succeeded");
  assert.equal(detail.release?.id, release.id);
  assert.equal(detail.release?.installation.contentHash, release.contentHash);
  assert.equal(detail.release?.installation.localOnly, true);

  const restartedWorker = await resumed.post<{ runId: string; status: string }>(
    "/api/projects/analyze", { projectId: project.id },
  );
  assert.notEqual(restartedWorker.runId, enqueued.runId);
  const restartedAnalysis = await pollAnalysis(resumed, restartedWorker.runId);
  assert.equal(restartedAnalysis.run.status, "succeeded");
  assert.equal(restartedAnalysis.result?.providerProvenance?.mode, "openapi");
  assert.equal(restartedAnalysis.result?.providerProvenance?.fixture, false);

  context.diagnostic(JSON.stringify({
    code: "LOCAL_LIVE_OPENAPI_EVIDENCE",
    projectId: project.id,
    analysisRunId: enqueued.runId,
    releaseId: release.id,
    artifactUrl: release.url,
    contentHash: release.contentHash,
    integrity: release.sri,
    initialAnalysisRunId: enqueued.runId,
    restartedAnalysisRunId: restartedWorker.runId,
    liveSuccess: false,
  }));
});

function environment(name: typeof requiredEnvironment[number]): string {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
}

function exactOrigin(value: string, protocol: "http:" | "https:"): string {
  const url = new URL(value);
  assert.equal(url.protocol, protocol);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(value, url.origin);
  return value;
}

function exactNonFixtureHttpsUrl(value: string): string {
  const url = new URL(value);
  assert.equal(url.protocol, "https:");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.doesNotMatch(url.hostname, /(?:^|\.)acme(?:\.|$)/i);
  assert.equal(isLoopback(url.hostname), false);
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

async function assertDocumentedDockerTopology(): Promise<void> {
  const version = await runBoundedCommand(["exec", "supabase", "--version"]);
  assert.equal(version.trim(), "2.116.0", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  const values = parseSupabaseStatus(await runBoundedCommand(["exec", "supabase", "status", "-o", "env"]));
  assert.equal(values.get("API_URL"), "http://127.0.0.1:54321", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(values.get("STUDIO_URL"), "http://127.0.0.1:54323", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(values.get("INBUCKET_URL"), "http://127.0.0.1:54324", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  let database: URL;
  try {
    database = new URL(requiredStatusValue(values, "DB_URL"));
  } catch {
    throw new Error("LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  }
  assert.equal(database.protocol, "postgresql:", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(database.hostname, "127.0.0.1", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(database.port, "54322", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(database.pathname, "/postgres", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(database.username, "postgres", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(database.search, "", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  assert.equal(database.hash, "", "LOCAL_DOCKER_TOPOLOGY_REQUIRED");
}

function runBoundedCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const rejectSafely = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("LOCAL_DOCKER_TOPOLOGY_REQUIRED"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectSafely();
    }, 30_000);
    timer.unref?.();
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 65_536) {
          child.kill("SIGTERM");
          return;
        }
        if (stream === child.stdout) stdout += chunk.toString("utf8");
      });
    }
    child.once("error", rejectSafely);
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0 || outputBytes > 65_536) return rejectSafely();
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

function parseSupabaseStatus(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([A-Z][A-Z0-9_]*)=("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!match || values.has(match[1]!)) throw new Error("LOCAL_DOCKER_TOPOLOGY_REQUIRED");
    let value: unknown;
    try {
      value = JSON.parse(match[2]!);
    } catch {
      throw new Error("LOCAL_DOCKER_TOPOLOGY_REQUIRED");
    }
    if (typeof value !== "string" || value.length > 4_096 || /[\r\n]/.test(value)) {
      throw new Error("LOCAL_DOCKER_TOPOLOGY_REQUIRED");
    }
    values.set(match[1]!, value);
  }
  return values;
}

function requiredStatusValue(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error("LOCAL_DOCKER_TOPOLOGY_REQUIRED");
  return value;
}

async function assertControlPortFree(): Promise<void> {
  assert.equal(await controlPortOpen(), false, "LOCAL_LIVE_CONTROL_PORT_IN_USE");
}

function controlPortOpen(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: 3100 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("LOCAL_LIVE_CONTROL_PORT_UNRESPONSIVE"));
    }, 2_000);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new Error("LOCAL_LIVE_CONTROL_PORT_UNRESPONSIVE"));
    });
  });
}

class LocalLiveProcesses {
  readonly #child: ChildProcess;
  readonly #exit: Promise<void>;
  #stopped = false;

  private constructor(child: ChildProcess) {
    this.#child = child;
    this.#exit = new Promise((resolve) => {
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
  }

  get pid(): number {
    assert.ok(this.#child.pid, "LOCAL_LIVE_LAUNCH_FAILED");
    return this.#child.pid;
  }

  static async start(controlOrigin: string): Promise<LocalLiveProcesses> {
    const child = spawn(process.execPath, ["scripts/dev-local-live.mjs"], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: "ignore",
      detached: process.platform !== "win32",
    });
    const processes = new LocalLiveProcesses(child);
    try {
      await waitForControlReady(child, controlOrigin);
      return processes;
    } catch {
      await processes.stop();
      throw new Error("LOCAL_LIVE_LAUNCH_FAILED");
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    signalOwnedProcess(this.#child, "SIGTERM");
    if (!await settlesWithin(this.#exit, 10_000)) {
      signalOwnedProcess(this.#child, "SIGKILL");
      if (!await settlesWithin(this.#exit, 5_000)) throw new Error("LOCAL_LIVE_STOP_FAILED");
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!await controlPortOpen()) return;
      await delay(100);
    }
    throw new Error("LOCAL_LIVE_STOP_FAILED");
  }
}

async function waitForControlReady(child: ChildProcess, controlOrigin: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("LOCAL_LIVE_LAUNCH_FAILED");
    }
    if (await controlReady(controlOrigin)) return;
    await delay(250);
  }
  throw new Error("LOCAL_LIVE_LAUNCH_FAILED");
}

async function controlReady(controlOrigin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  timer.unref?.();
  try {
    const response = await fetch(`${controlOrigin}/api/auth/csrf`, {
      headers: { origin: controlOrigin, "sec-fetch-site": "same-origin" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200 || response.url !== `${controlOrigin}/api/auth/csrf`
      || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) return false;
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 16_384) return false;
    const parsed = JSON.parse(body) as { csrfToken?: unknown };
    return typeof parsed.csrfToken === "string" && /^v1\./.test(parsed.csrfToken);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAnalysis(session: ControlPlaneSession, runId: string): Promise<{
  run: { status: string; errorCode?: string };
  result?: {
    providerProvenance?: { mode?: string; fixture?: boolean };
    evidence?: unknown[];
  };
  capabilities: Capability[];
}> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const analysis = await session.get<{
      run: { status: string; errorCode?: string };
      result?: {
        providerProvenance?: { mode?: string; fixture?: boolean };
        evidence?: unknown[];
      };
      capabilities: Capability[];
    }>(`/api/analysis-runs/${runId}`);
    if (analysis.run.status === "succeeded") return analysis;
    if (["failed", "cancelled"].includes(analysis.run.status)) {
      throw new Error(analysis.run.errorCode ?? "ANALYSIS_TERMINATED");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("ANALYSIS_POLL_TIMEOUT");
}

async function readArtifact(url: string): Promise<Buffer> {
  const response = await boundedFetch(url, { redirect: "error", credentials: "omit", cache: "no-store" });
  assert.equal(response.status, 200);
  assert.equal(response.url, url);
  assert.equal(response.redirected, false);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 65_536);
  return bytes;
}

class ControlPlaneSession {
  readonly cookies = new Map<string, string>();

  constructor(readonly origin: string) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T = unknown>(
    path: string,
    body: unknown,
    options: Readonly<{ authenticated?: boolean }> = {},
  ): Promise<T> {
    const csrf = await this.csrf(options.authenticated !== false);
    return this.request<T>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-csrf-token": csrf,
      },
      body: JSON.stringify(body),
    });
  }

  private async csrf(authenticated: boolean): Promise<string> {
    const path = authenticated ? "/api/auth/session" : "/api/auth/csrf";
    const response = await this.request<{ csrfToken: string }>(path, { method: "GET" });
    assert.match(response.csrfToken, /^v1\./);
    return response.csrfToken;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    assert.match(path, /^\/api\/[A-Za-z0-9_./-]+$/);
    const url = `${this.origin}${path}`;
    const headers = new Headers(init.headers);
    headers.set("origin", this.origin);
    headers.set("sec-fetch-site", "same-origin");
    const cookie = [...this.cookies.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) headers.set("cookie", cookie);
    const response = await boundedFetch(url, { ...init, headers, redirect: "error" });
    this.absorbCookies(response.headers);
    const text = await response.text();
    assert.ok(Buffer.byteLength(text, "utf8") <= 1_048_576, "control response exceeds bound");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error("CONTROL_RESPONSE_INVALID"); }
    if (!response.ok) {
      const code = typeof body === "object" && body !== null && "code" in body
        ? String((body as { code: unknown }).code) : `HTTP_${response.status}`;
      throw new Error(code);
    }
    return body as T;
  }

  private absorbCookies(headers: Headers): void {
    const values = headers.getSetCookie();
    for (const serialized of values) {
      const pair = serialized.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/Max-Age=0(?:;|$)/i.test(serialized)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

async function boundedFetch(resource: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("E2E_REQUEST_TIMEOUT")), 20_000);
  timer.unref?.();
  try {
    return await fetch(resource, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
