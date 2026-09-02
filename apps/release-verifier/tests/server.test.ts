import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import {
  attestReleaseInstallation,
  configuredReleaseVerificationPort,
  type InstalledVerificationReport,
  type ReleaseVerifierHttpTransport,
} from "../../control-plane/src/release-verification.ts";
import { loadVerifierConfig } from "../src/config.ts";
import { createMemoryReplayStore } from "../src/replay-store.ts";
import { startVerifierServer, type VerifierServer } from "../src/server.ts";
import { verifierFixturePlans } from "./fixtures/plans.ts";

const TOKEN = "verifier-secret-token-value-1234567890";
const TARGET_ORIGIN = "https://acme.example";
const HOSTED_PREFIX = "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const release = compileWebMcpRelease(verifierFixturePlans(TARGET_ORIGIN));
const expectedTools = ["create_support_ticket", "find_order"];
const artifactUrl = `${HOSTED_PREFIX}/${release.contentHash}.js`;

function installationInput() {
  return {
    pageUrl: `${TARGET_ORIGIN}/support`,
    artifactUrl,
    downloadUrl: `${artifactUrl}?download=page2webmcp-${release.contentHash}.js`,
    localOnly: false,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: TARGET_ORIGIN,
    expectedTools,
    liveContext: {
      projectId: "11111111-1111-4111-8111-111111111111",
      releaseId: "22222222-2222-4222-8222-222222222222",
      installationOperationId: "f".repeat(64),
      sourceIdentityHash: "c".repeat(64),
      environment: "production" as const,
    },
  };
}

function truthfulReport(overrides: Partial<InstalledVerificationReport> = {}): InstalledVerificationReport {
  const input = installationInput();
  return {
    observedArtifactUrl: input.artifactUrl,
    observedDownloadUrl: input.downloadUrl,
    observedLocalOnly: false,
    observedIntegrity: input.integrity,
    executedArtifactUrl: input.artifactUrl,
    servedContentHash: input.contentHash,
    executedContentHash: input.contentHash,
    observedTargetOrigin: TARGET_ORIGIN,
    registeredTools: expectedTools,
    webMcpImplementation: "native",
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    executionEvidence: {
      authenticatedRead: { toolName: "find_order", authenticated: true, succeeded: true },
      confirmedReversibleMutation: {
        toolName: "create_support_ticket",
        confirmation: "explicit",
        reversible: true,
        succeeded: true,
        effectCount: 1,
      },
      authoritativeFinalState: {
        mutationToolName: "create_support_ticket",
        source: "target",
        verified: true,
      },
    },
    csp: { hosted: "allowed" },
    ...overrides,
  };
}

function serverConfig(): ReturnType<typeof loadVerifierConfig> {
  return loadVerifierConfig({
    PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS: "127.0.0.1",
    PAGE2WEBMCP_RELEASE_VERIFIER_PORT: "0",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: TOKEN,
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: TARGET_ORIGIN,
    PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN: "https://control.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS: "true",
    PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH: "",
  });
}

function loopbackTransport(server: VerifierServer): ReleaseVerifierHttpTransport {
  const address = server.address() as AddressInfo;
  return {
    async request(input) {
      const target = new URL(input.url);
      const response = await fetch(`http://127.0.0.1:${address.port}${target.pathname}`, {
        method: "POST",
        headers: input.headers,
        body: input.body,
      });
      return {
        status: response.status,
        url: input.url,
        headers: Object.fromEntries(response.headers.entries()),
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
  };
}

async function withServer<T>(
  report: (() => Promise<InstalledVerificationReport>) | InstalledVerificationReport,
  run: (transport: ReleaseVerifierHttpTransport) => Promise<T>,
): Promise<T> {
  const server = await startVerifierServer(serverConfig(), {
    replayStore: createMemoryReplayStore(256),
    verifyInstallation: async () => ({
      ok: true,
      report: typeof report === "function" ? await report() : report,
    }),
    verifyCandidate: async () => ({ ok: false, code: "CANDIDATE_NOT_EXPECTED" }),
  });
  try {
    return await run(loopbackTransport(server));
  } finally {
    await server.close();
  }
}

function port(transport: ReleaseVerifierHttpTransport) {
  return configuredReleaseVerificationPort({
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: TOKEN,
  }, { mode: "live", deploymentIdentityDigest: "d".repeat(64), transport });
}

test("the reference verifier answers a genuine client installation request with an accepted attestation", async () => {
  await withServer(truthfulReport(), async (transport) => {
    const attestation = await attestReleaseInstallation(
      installationInput(),
      port(transport),
      AbortSignal.timeout(20_000),
    );
    assert.equal(attestation.status, "verified");
    assert.equal(attestation.delivery, "hosted");
    assert.equal(attestation.webMcpImplementation, "native");
    assert.equal(attestation.verifierAttestation?.operation, "installation");
    assert.equal(attestation.verifierAttestation?.protocolVersion, 2);
    assert.equal(
      attestation.verifierIdentity.verifierOriginDigest,
      createHash("sha256").update("https://verifier.example").digest("hex"),
    );
  });
});

test("a truthful negative report is rejected by the client rather than fabricated into success", async () => {
  const negatives: ReadonlyArray<readonly [string, Partial<InstalledVerificationReport>, string]> = [
    ["served bytes differ", { servedContentHash: "a".repeat(64) }, "INSTALLED_VERIFICATION_INVALID"],
    ["executed bytes differ", { executedContentHash: "b".repeat(64) }, "INSTALLED_VERIFICATION_INVALID"],
    ["webmcp is a shim", { webMcpImplementation: "compatibility_shim" }, "WEBMCP_NATIVE_REQUIRED"],
    ["tool set differs", { registeredTools: ["find_order"] }, "INSTALLED_VERIFICATION_INVALID"],
    ["no execution evidence", { executionEvidence: null }, "INSTALLED_VERIFICATION_INVALID"],
    ["duplicate load harmful", { duplicateLoadHarmless: false }, "INSTALLED_VERIFICATION_INVALID"],
  ];
  for (const [name, overrides, code] of negatives) {
    await withServer(truthfulReport(overrides), async (transport) => {
      await assert.rejects(
        attestReleaseInstallation(installationInput(), port(transport), AbortSignal.timeout(20_000)),
        (error: unknown) => {
          assert.ok(error instanceof Error, name);
          assert.equal(error.message, code, name);
          return true;
        },
      );
    });
  }
});

test("a target origin outside the allowlist is refused before any browser work", async () => {
  let observed = 0;
  const server = await startVerifierServer(loadVerifierConfig({
    PAGE2WEBMCP_RELEASE_VERIFIER_BIND_ADDRESS: "127.0.0.1",
    PAGE2WEBMCP_RELEASE_VERIFIER_PORT: "0",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: TOKEN,
    PAGE2WEBMCP_RELEASE_VERIFIER_ALLOWED_TARGET_ORIGINS: "https://allowed.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_CONTROL_PLANE_ORIGIN: "https://control.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_BROWSER_HEADLESS: "true",
    PAGE2WEBMCP_RELEASE_VERIFIER_REPLAY_STORE_PATH: "",
  }), {
    replayStore: createMemoryReplayStore(256),
    verifyInstallation: async () => {
      observed += 1;
      return { ok: true, report: truthfulReport() };
    },
    verifyCandidate: async () => ({ ok: false, code: "CANDIDATE_NOT_EXPECTED" }),
  });
  try {
    const transport = loopbackTransport(server);
    await assert.rejects(
      attestReleaseInstallation(installationInput(), port(transport), AbortSignal.timeout(20_000)),
    );
    assert.equal(observed, 0);
  } finally {
    await server.close();
  }
});

test("readiness reports the exact supported mode, protocol, and native implementation", async () => {
  await withServer(truthfulReport(), async (transport) => {
    const identity = await port(transport).readiness!(AbortSignal.timeout(20_000));
    assert.deepEqual(identity, {
      protocolVersion: 2,
      mode: "live",
      webMcpImplementation: "native",
      verifierOriginDigest: createHash("sha256").update("https://verifier.example").digest("hex"),
    });
  });
});

test("an unauthenticated or replayed request never reaches verification", async () => {
  const server = await startVerifierServer(serverConfig(), {
    replayStore: createMemoryReplayStore(256),
    verifyInstallation: async () => ({ ok: true, report: truthfulReport() }),
    verifyCandidate: async () => ({ ok: false, code: "CANDIDATE_NOT_EXPECTED" }),
  });
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const unauthenticated = await fetch(`${base}/v2/readiness`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("set-cookie"), null);
    const unknownPath = await fetch(`${base}/v2/unknown`, { method: "POST", body: "{}" });
    assert.equal(unknownPath.status, 404);
    const wrongMethod = await fetch(`${base}/v2/readiness`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await server.close();
  }
});
