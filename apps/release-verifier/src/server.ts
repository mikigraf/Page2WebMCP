import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { LiveVerifierScope } from "../../control-plane/src/release-verifier-protocol-v2.ts";
import { verifyCandidateRelease, type CandidateOutcome } from "./candidate.ts";
import type { VerifierConfig } from "./config.ts";
import { verifyInstalledRelease, type InstallationOutcome } from "./installation.ts";
import { logEvent } from "./logging.ts";
import {
  buildAttestationResponse,
  operationForPath,
  verifyVerifierRequest,
  MAX_REQUEST_BYTES,
  type VerifiedVerifierRequest,
} from "./protocol.ts";
import { createDurableReplayStore, createMemoryReplayStore, type ReplayStore } from "./replay-store.ts";

/**
 * The HTTPS-facing surface. Every request must carry a valid bearer token and a valid signature
 * over its exact body before any other work happens; every response is a signed attestation whose
 * report is whatever was actually observed.
 */

export type VerifierServerDependencies = Readonly<{
  now?: () => Date;
  replayStore?: ReplayStore;
  verifyInstallation?: (input: Readonly<{
    config: VerifierConfig;
    payload: unknown;
    scope: Extract<LiveVerifierScope, { operation: "installation" }>;
    deadline: number;
  }>) => Promise<InstallationOutcome>;
  verifyCandidate?: (input: Readonly<{
    config: VerifierConfig;
    payload: unknown;
    scope: Extract<LiveVerifierScope, { operation: "candidate" }>;
    deadline: number;
  }>) => Promise<CandidateOutcome>;
}>;

export type VerifierServer = Readonly<{
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}>;

export async function startVerifierServer(
  config: VerifierConfig,
  dependencies: VerifierServerDependencies = {},
): Promise<VerifierServer> {
  const replayStore = dependencies.replayStore ?? defaultReplayStore(config);
  const server = createServer((request, response) => {
    handle(request, response, config, dependencies, replayStore).catch(() => {
      respondError(response, 500, "RELEASE_VERIFIER_INTERNAL_ERROR");
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = config.timeouts.totalRequestMs + 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bindAddress, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return Object.freeze({
    address: () => server.address(),
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        replayStore.close();
        resolve();
      });
    }),
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  config: VerifierConfig,
  dependencies: VerifierServerDependencies,
  replayStore: ReplayStore,
): Promise<void> {
  const startedAt = Date.now();
  const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
  const operation = operationForPath(path);
  if (!operation) return respondError(response, 404, "RELEASE_VERIFIER_NOT_FOUND");
  if (request.method !== "POST") return respondError(response, 405, "RELEASE_VERIFIER_METHOD_NOT_ALLOWED");
  const body = await readBoundedBody(request);
  if (!body) return respondError(response, 413, "RELEASE_VERIFIER_REQUEST_TOO_LARGE");
  const verified = verifyVerifierRequest({
    operation,
    body,
    authorization: headerValue(request, "authorization"),
    signature: headerValue(request, "x-page2webmcp-signature"),
    token: config.token,
    now: (dependencies.now ?? (() => new Date()))(),
    replayStore,
  });
  if (!verified.ok) {
    logEvent("release_verifier_request_rejected", { operation, code: verified.code, status: verified.status });
    return respondError(response, verified.status, verified.code);
  }
  const deadline = startedAt + config.timeouts.totalRequestMs;
  const outcome = await withDeadline(
    () => evaluate(verified, config, dependencies, deadline),
    config.timeouts.totalRequestMs,
  );
  if (!outcome.ok) {
    logEvent("release_verifier_verification_refused", {
      operation,
      requestId: verified.requestId,
      code: outcome.code,
      durationMs: Date.now() - startedAt,
    });
    return respondError(response, 422, outcome.code);
  }
  let attestation: Readonly<{ body: string; signature: string }>;
  try {
    attestation = buildAttestationResponse({
      request: verified,
      report: outcome.report,
      token: config.token,
      now: (dependencies.now ?? (() => new Date()))(),
    });
  } catch (error) {
    logEvent("release_verifier_attestation_failed", {
      operation,
      requestId: verified.requestId,
      code: error instanceof Error ? error.message : "UNKNOWN",
    });
    return respondError(response, 500, "RELEASE_VERIFIER_ATTESTATION_FAILED");
  }
  logEvent("release_verifier_attested", {
    operation,
    requestId: verified.requestId,
    durationMs: Date.now() - startedAt,
  });
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-page2webmcp-signature": attestation.signature,
    "content-length": String(Buffer.byteLength(attestation.body, "utf8")),
  });
  response.end(attestation.body);
}

type EvaluationOutcome =
  | Readonly<{ ok: true; report: unknown }>
  | Readonly<{ ok: false; code: string }>;

async function evaluate(
  request: VerifiedVerifierRequest,
  config: VerifierConfig,
  dependencies: VerifierServerDependencies,
  deadline: number,
): Promise<EvaluationOutcome> {
  if (request.operation === "readiness") {
    const scope = request.scope as Extract<LiveVerifierScope, { operation: "readiness" }>;
    if (config.acceptedDeploymentIdentityDigests.length > 0
      && !config.acceptedDeploymentIdentityDigests.includes(scope.deploymentIdentityDigest)) {
      return { ok: false, code: "RELEASE_VERIFIER_DEPLOYMENT_IDENTITY_UNKNOWN" };
    }
    return {
      ok: true,
      report: { mode: config.mode, protocolVersion: 2, webMcpImplementation: "native" },
    };
  }
  if (request.operation === "installation") {
    const scope = request.scope as Extract<LiveVerifierScope, { operation: "installation" }>;
    const verify = dependencies.verifyInstallation
      ?? ((input) => verifyInstalledRelease({
        config: input.config,
        payload: input.payload,
        deadline: input.deadline,
        scope: {
          pageUrl: input.scope.pageUrl,
          targetOrigin: input.scope.targetOrigin,
          selectedHash: input.scope.selectedHash,
        },
      }));
    if (!allowedScopeOrigin(config, scope.targetOrigin)) {
      return { ok: false, code: "RELEASE_VERIFIER_TARGET_ORIGIN_FORBIDDEN" };
    }
    const result = await verify({ config, payload: request.payload, scope, deadline });
    return result.ok ? { ok: true, report: result.report } : { ok: false, code: result.code };
  }
  const scope = request.scope as Extract<LiveVerifierScope, { operation: "candidate" }>;
  if (!allowedScopeOrigin(config, scope.targetOrigin)) {
    return { ok: false, code: "RELEASE_VERIFIER_TARGET_ORIGIN_FORBIDDEN" };
  }
  const verify = dependencies.verifyCandidate
    ?? ((input) => verifyCandidateRelease({
      config: input.config,
      payload: input.payload,
      deadline: input.deadline,
      scope: { targetOrigin: input.scope.targetOrigin, contentHash: input.scope.contentHash },
    }));
  const result = await verify({ config, payload: request.payload, scope, deadline });
  return result.ok ? { ok: true, report: result.report } : { ok: false, code: result.code };
}

function allowedScopeOrigin(config: VerifierConfig, targetOrigin: string): boolean {
  return config.allowedTargetOrigins.includes(targetOrigin);
}

function defaultReplayStore(config: VerifierConfig): ReplayStore {
  return config.replayStorePath === ""
    ? createMemoryReplayStore(config.limits.replayEntries)
    : createDurableReplayStore({ path: config.replayStorePath, maxEntries: config.limits.replayEntries });
}

async function readBoundedBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function respondError(response: ServerResponse, status: number, code: string): void {
  const body = JSON.stringify({ error: code });
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body, "utf8")),
  });
  response.end(body);
}

async function withDeadline(
  operation: () => Promise<EvaluationOutcome>,
  timeoutMs: number,
): Promise<EvaluationOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<EvaluationOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, code: "RELEASE_VERIFIER_DEADLINE_EXCEEDED" }), timeoutMs);
      }),
    ]);
  } catch {
    return { ok: false, code: "RELEASE_VERIFIER_VERIFICATION_FAILED" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
