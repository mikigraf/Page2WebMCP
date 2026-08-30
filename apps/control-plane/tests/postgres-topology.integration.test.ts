import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { GET as getAnalysis } from "../app/api/analysis-runs/[runId]/route.ts";
import { POST as login } from "../app/api/auth/login/route.ts";
import { POST as reviewCapability } from "../app/api/capabilities/[capabilityId]/review/route.ts";
import { POST as publishRelease } from "../app/api/projects/[projectId]/releases/route.ts";
import { POST as analyzeProject } from "../app/api/projects/analyze/route.ts";
import { POST as createProject } from "../app/api/projects/route.ts";
import { GET as getArtifact } from "../app/api/releases/[artifact]/route.ts";
import { setControlPlaneRepositoryForTest } from "../../../packages/database/src/factory.ts";
import { createPostgresRepository } from "../../../packages/database/src/postgres.ts";
import { issueCsrfChallenge } from "../src/api.ts";
import { setAuthServiceForTest } from "../src/auth.ts";
import { createFixtureAuthService, fixtureSessionId } from "../src/auth-fixture.ts";

const appConnectionString = process.env.PAGE2WEBMCP_TEST_APP_DATABASE_URL;
const workerConnectionString = process.env.PAGE2WEBMCP_TEST_WORKER_DATABASE_URL;
const adminConnectionString = process.env.PAGE2WEBMCP_TEST_ADMIN_DATABASE_URL;
const trustedTsxCli = process.env.PAGE2WEBMCP_TEST_TSX_CLI;
const nativeTypeScript = process.env.PAGE2WEBMCP_NATIVE_TYPESCRIPT_TESTS === "true";
const controlOrigin = "https://control.example";
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const csrfSecret = "postgres-topology-test-csrf-secret-32-bytes";
process.env.PAGE2WEBMCP_SESSION_SECRET = csrfSecret;

type CapabilityResponse = {
  id: string;
  stableName: string;
  status: string;
  version: number;
};

type AnalysisResponse = {
  run: { id: string; status: string; errorCode?: string };
  capabilities: CapabilityResponse[];
};

test("PostgreSQL route lifecycle is completed by a separately launched durable worker", {
  skip: !appConnectionString || !workerConnectionString || !adminConnectionString,
  timeout: 30_000
}, async () => {
  if (!appConnectionString || !workerConnectionString || !adminConnectionString) return;

  const repository = createPostgresRepository({ connectionString: appConnectionString, maxConnections: 3 });
  const admin = new pg.Pool({ connectionString: adminConnectionString, max: 1 });
  let worker: ChildProcess | undefined;
  let workerOutput = () => "";
  setControlPlaneRepositoryForTest(repository);
  setAuthServiceForTest(createFixtureAuthService());

  try {
    const loginResponse = await login(jsonRequest("/api/auth/login", {
      email: "owner@example.test",
      password: "fixture-password"
    }));
    await assertResponseStatus(loginResponse, 200);
    const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.match(cookie ?? "", /^page2webmcp_fixture_session=/);
    assert.ok(cookie);
    const fixtureToken = cookie.split("=", 2)[1]!;
    const sessionId = fixtureSessionId(fixtureToken);
    assert.ok(sessionId);
    await admin.query(
      "insert into auth.sessions (id, user_id, not_after) values ($1, $2, now() + interval '1 hour')",
      [sessionId, "11111111-1111-1111-1111-111111111111"]
    );

    const suffix = randomUUID();
    const projectResponse = await createProject(jsonRequest("/api/projects", {
      sourceType: "website",
      url: "https://widgets.example"
    }, cookie, `topology-project-${suffix}`));
    await assertResponseStatus(projectResponse, 201);
    const project = await projectResponse.json() as { id: string; status: string };
    assert.equal(project.status, "created");

    const analyzeResponse = await analyzeProject(jsonRequest("/api/projects/analyze", {
      projectId: project.id
    }, cookie, `topology-analysis-${suffix}`));
    await assertResponseStatus(analyzeResponse, 202);
    const accepted = await analyzeResponse.json() as { runId: string; status: string };
    assert.equal(accepted.status, "queued", "PostgreSQL work must not execute inside the request process");

    const fixtureWorker = "apps/control-plane/tests/fixtures/postgres-worker.ts";
    worker = spawn(process.execPath, nativeTypeScript
      ? ["--experimental-transform-types", fixtureWorker]
      : trustedTsxCli
        ? [trustedTsxCli, fixtureWorker]
        : ["--import", "tsx", fixtureWorker], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        DATABASE_URL: workerConnectionString,
        NODE_ENV: "test",
        PAGE2WEBMCP_OBSERVABILITY_ENABLED: "false",
        PAGE2WEBMCP_PROVIDER_MODE: "local",
        PAGE2WEBMCP_STORAGE_MODE: "postgres",
        PAGE2WEBMCP_WORKER_POLL_MS: "100"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    workerOutput = captureOutput(worker);
    await waitForSpawn(worker);

    const completed = await waitForCompletedAnalysis(cookie, accepted.runId, worker, workerOutput);
    assert.equal(completed.run.status, "succeeded");
    assert.ok(completed.capabilities.length > 0);

    const stoppedCleanly = await terminateWorker(worker);
    assert.equal(stoppedCleanly, true, `worker did not shut down cleanly\n${workerOutput() || "(no worker output)"}`);

    const deniedPublish = await publishRelease(
      jsonRequest(`/api/projects/${project.id}/releases`, {
        analysisRunId: accepted.runId
      }, cookie, `topology-publish-denied-${suffix}`),
      { params: Promise.resolve({ projectId: project.id }) }
    );
    await assertResponseStatus(deniedPublish, 409);
    assert.equal((await deniedPublish.json() as { code: string }).code, "REVIEW_REQUIRED");

    const ticket = completed.capabilities.find((capability) => capability.stableName === "create_widget");
    assert.ok(ticket, "worker result must persist the generic R1 fixture capability");
    const reviewedResponse = await reviewCapability(
      jsonRequest(`/api/capabilities/${ticket.id}/review`, {
        action: "approve",
        expectedVersion: ticket.version
      }, cookie),
      { params: Promise.resolve({ capabilityId: ticket.id }) }
    );
    await assertResponseStatus(reviewedResponse, 200);
    const reviewed = await reviewedResponse.json() as { capability: CapabilityResponse };
    assert.equal(reviewed.capability.status, "reviewed");
    assert.equal(reviewed.capability.version, ticket.version + 1);

    const publishResponse = await publishRelease(
      jsonRequest(`/api/projects/${project.id}/releases`, {
        analysisRunId: accepted.runId
      }, cookie, `topology-publish-${suffix}`),
      { params: Promise.resolve({ projectId: project.id }) }
    );
    await assertResponseStatus(publishResponse, 201);
    const published = await publishResponse.json() as {
      release: {
        analysisRunId: string;
        allowedOrigin: string;
        contentHash: string;
        sri: string;
        status: string;
        url: string;
      };
    };
    assert.equal(published.release.analysisRunId, accepted.runId);
    assert.equal(published.release.status, "published");
    assert.equal(published.release.allowedOrigin, "https://widgets.example");

    const artifactResponse = await getArtifact(
      new Request(`${controlOrigin}${published.release.url}`),
      { params: Promise.resolve({ artifact: `${published.release.contentHash}.js` }) }
    );
    await assertResponseStatus(artifactResponse, 200);
    const artifact = await artifactResponse.text();
    const digest = createHash("sha256").update(Buffer.from(artifact)).digest();
    const integrity = createHash("sha384").update(Buffer.from(artifact)).digest("base64");
    assert.equal(digest.toString("hex"), published.release.contentHash);
    assert.equal(`sha384-${integrity}`, published.release.sri);
    assert.equal(artifactResponse.headers.get("x-page2webmcp-integrity"), published.release.sri);
    assert.equal(artifactResponse.headers.get("access-control-allow-origin"), "https://widgets.example");
    assert.match(artifact, /registerPage2WebMCPTools/);
  } finally {
    if (worker) await terminateWorker(worker);
    setControlPlaneRepositoryForTest(undefined);
    setAuthServiceForTest(undefined);
    await repository.close();
    await admin.end();
  }
});

function jsonRequest(path: string, body: unknown, cookie?: string, idempotencyKey?: string): Request {
  const fixtureToken = cookie?.split("=", 2)[1];
  const challenge = issueCsrfChallenge(new Request(`${controlOrigin}/api/auth/csrf`), {
    secret: csrfSecret,
    ...(fixtureToken ? { sessionId: fixtureSessionId(fixtureToken) } : {})
  });
  const headers = new Headers({
    "content-type": "application/json",
    origin: controlOrigin,
    "sec-fetch-site": "same-origin",
    "x-csrf-token": challenge.token
  });
  headers.set("cookie", [cookie, challenge.cookie.split(";", 1)[0]].filter(Boolean).join("; "));
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request(`${controlOrigin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function waitForCompletedAnalysis(
  cookie: string,
  runId: string,
  worker: ChildProcess,
  output: () => string
): Promise<AnalysisResponse> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await getAnalysis(
      new Request(`${controlOrigin}/api/analysis-runs/${runId}`, { headers: { cookie } }),
      { params: Promise.resolve({ runId }) }
    );
    await assertResponseStatus(response, 200);
    const body = await response.json() as AnalysisResponse;
    if (body.run.status === "succeeded") return body;
    if (body.run.status === "failed" || body.run.status === "cancelled") {
      assert.fail(`analysis ended as ${body.run.status}: ${body.run.errorCode ?? "UNKNOWN"}\n${output()}`);
    }
    if (worker.exitCode !== null || worker.signalCode !== null) {
      assert.fail(`worker exited before completing analysis\n${output() || "(no worker output)"}`);
    }
    await delay(100);
  }
  assert.fail(`timed out waiting for separate worker process\n${output() || "(no worker output)"}`);
}

function captureOutput(worker: ChildProcess): () => string {
  let output = "";
  const append = (chunk: unknown) => {
    output = `${output}${String(chunk)}`.slice(-16_384);
  };
  worker.stdout?.on("data", append);
  worker.stderr?.on("data", append);
  worker.on("error", append);
  return () => output;
}

async function waitForSpawn(worker: ChildProcess): Promise<void> {
  if (worker.pid !== undefined) return;
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      worker.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      worker.off("spawn", spawned);
      reject(error);
    };
    worker.once("spawn", spawned);
    worker.once("error", failed);
  });
}

async function terminateWorker(worker: ChildProcess): Promise<boolean> {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return worker.exitCode === 0 && worker.signalCode === null;
  }
  worker.kill("SIGTERM");
  if (await waitForExit(worker, 5_000)) {
    return worker.exitCode === 0 && worker.signalCode === null;
  }
  worker.kill("SIGKILL");
  await waitForExit(worker, 2_000);
  return false;
}

async function waitForExit(worker: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (worker.exitCode !== null || worker.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(done, timeoutMs, false);
    const exited = () => done(true);
    worker.once("exit", exited);
    function done(value: boolean) {
      clearTimeout(timeout);
      worker.off("exit", exited);
      resolve(value);
    }
  });
}

async function assertResponseStatus(response: Response, expected: number): Promise<void> {
  assert.equal(response.status, expected, await response.clone().text());
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
