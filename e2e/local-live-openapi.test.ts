import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

const requiredEnvironment = [
  "PAGE2WEBMCP_E2E_CONTROL_URL",
  "PAGE2WEBMCP_E2E_INSTALL_PAGE_URL",
  "PAGE2WEBMCP_E2E_LOCAL_LIVE",
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
  if (name === "PAGE2WEBMCP_PROVIDER_MODE") return value !== "openapi";
  if (name === "PAGE2WEBMCP_STORAGE_MODE") return value !== "postgres";
  return false;
});

type Capability = Readonly<{
  id: string;
  riskTier: "R0" | "R1" | "R2" | "R3";
  status: "proposed" | "approved" | "blocked" | "rejected";
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
  timeout: 240_000,
}, async (context) => {
  const controlOrigin = exactOrigin(environment("PAGE2WEBMCP_E2E_CONTROL_URL"), "http:");
  assert.ok(isExactLoopbackOrigin(controlOrigin), "local-live control plane must be exact loopback HTTP");
  const sourceUrl = exactNonFixtureHttpsUrl(environment("PAGE2WEBMCP_E2E_SOURCE_URL"));
  const targetOrigin = exactOrigin(environment("PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN"), "https:");
  const testPageUrl = exactNonFixtureHttpsUrl(environment("PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL"));
  const installPageUrl = exactNonFixtureHttpsUrl(environment("PAGE2WEBMCP_E2E_INSTALL_PAGE_URL"));
  assert.equal(new URL(testPageUrl).origin, targetOrigin);
  assert.equal(new URL(installPageUrl).origin, targetOrigin);

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
  assert.equal(analysis.result?.providerMode, "openapi");
  assert.equal(analysis.result?.providerFixture, false);
  assert.ok((analysis.result?.evidence?.length ?? 0) > 0);
  assert.ok(analysis.capabilities.length > 0, "real source must produce at least one capability");

  let approved = 0;
  for (const capability of analysis.capabilities) {
    if (capability.status !== "proposed") {
      if (capability.status === "approved") approved += 1;
      continue;
    }
    const action = capability.riskTier === "R3" ? "block" : "approve";
    const reviewed = await session.post<{ capability: Capability }>(
      `/api/capabilities/${capability.id}/review`,
      { action, expectedVersion: capability.version },
    );
    assert.equal(reviewed.capability.status, action === "approve" ? "approved" : "blocked");
    if (action === "approve") approved += 1;
  }
  assert.ok(approved > 0, "release requires at least one approved non-R3 capability");

  const verified = await session.post<{ verification: { eligible: boolean; mode?: string } }>(
    "/api/capabilities/verify", { projectId: project.id, analysisRunId: enqueued.runId },
  );
  assert.equal(verified.verification.eligible, true);
  assert.equal(verified.verification.mode, "local_live");

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

  const installed = await session.post<{ installation: { status: string; verificationMode?: string } }>(
    `/api/projects/${project.id}/releases/${release.id}/installation`,
    { pageUrl: installPageUrl },
  );
  assert.equal(installed.installation.status, "verified");
  assert.equal(installed.installation.verificationMode, "local_live");

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

  context.diagnostic(JSON.stringify({
    code: "LOCAL_LIVE_OPENAPI_EVIDENCE",
    projectId: project.id,
    analysisRunId: enqueued.runId,
    releaseId: release.id,
    artifactUrl: release.url,
    contentHash: release.contentHash,
    integrity: release.sri,
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

function isExactLoopbackOrigin(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "http:" && isLoopback(url.hostname) && value === url.origin;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

async function pollAnalysis(session: ControlPlaneSession, runId: string): Promise<{
  run: { status: string; errorCode?: string };
  result?: { providerMode?: string; providerFixture?: boolean; evidence?: unknown[] };
  capabilities: Capability[];
}> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const analysis = await session.get<{
      run: { status: string; errorCode?: string };
      result?: { providerMode?: string; providerFixture?: boolean; evidence?: unknown[] };
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
