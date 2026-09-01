import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { compileWebMcpRelease } from "../../../packages/compiler/src/compiler.ts";
import { acmeCapabilityPlans } from "../../acme-support/src/capability-plans.ts";
import {
  REQUIRED_CANDIDATE_CHECKS,
  attestReleaseCandidate,
  attestReleaseInstallation,
  configuredReleaseVerificationPort,
  type CandidateVerificationReport,
  type InstalledVerificationReport,
  type ReleaseVerifierHttpRequest,
  type ReleaseVerifierHttpResponse,
  type ReleaseVerificationPort,
} from "../src/release-verification.ts";
import { canonicalVerifierJson } from "../src/release-verifier-protocol-v2.ts";

const release = compileWebMcpRelease(acmeCapabilityPlans("https://acme.example")
  .filter((plan) => plan.tool.name !== "get_order_status"));
const expectedTools = ["create_support_ticket", "find_order"];
const artifactUrl = `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${release.contentHash}.js`;
const downloadUrl = `${artifactUrl}?download=page2webmcp-${release.contentHash}.js`;
const verifierDeploymentDigest = "d".repeat(64);
const liveContext = {
  projectId: "11111111-1111-4111-8111-111111111111",
  analysisRunId: "22222222-2222-4222-8222-222222222222",
  sourceIdentityHash: "c".repeat(64),
  environment: "production" as const,
};

function installedExecutionEvidence() {
  return {
    authenticatedRead: {
      toolName: "find_order",
      authenticated: true as const,
      succeeded: true as const,
    },
    confirmedReversibleMutation: {
      toolName: "create_support_ticket",
      confirmation: "explicit" as const,
      reversible: true as const,
      succeeded: true as const,
      effectCount: 1 as const,
    },
    authoritativeFinalState: {
      mutationToolName: "create_support_ticket",
      source: "target" as const,
      verified: true as const,
    },
  };
}

function installedInput(overrides: Record<string, unknown> = {}) {
  return {
    pageUrl: "https://acme.example/account",
    artifactUrl,
    downloadUrl,
    localOnly: false,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
    expectedTools,
    liveContext: {
      projectId: liveContext.projectId,
      releaseId: "33333333-3333-4333-8333-333333333333",
      installationOperationId: "e".repeat(64),
      sourceIdentityHash: liveContext.sourceIdentityHash,
      environment: liveContext.environment,
    },
    ...overrides,
  };
}

function report(overrides: Partial<CandidateVerificationReport> = {}): CandidateVerificationReport {
  return {
    observedContentHash: release.contentHash,
    observedIntegrity: release.integrity,
    observedReleaseId: release.manifest.releaseId,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: release.contentHash },
    controlPlaneRequestsDuringExecution: 0,
    modelRequestsDuringExecution: 0,
    checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, status: "passed" as const })),
    csp: { hosted: "allowed" },
    ...overrides,
  };
}

function candidateInput() {
  return {
    code: release.code,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
    expectedTools,
    liveContext,
  };
}

function signedV2Response(
  request: ReleaseVerifierHttpRequest,
  token: string,
  report: unknown,
  overrides: Partial<ReleaseVerifierHttpResponse> = {},
): ReleaseVerifierHttpResponse {
  const envelope = JSON.parse(request.body) as Record<string, unknown>;
  const body = Buffer.from(canonicalVerifierJson({
    schema: "ReleaseVerifierAttestationV2",
    protocolVersion: 2,
    attestationId: envelope.requestId,
    requestId: envelope.requestId,
    nonceDigest: createHash("sha256").update(String(envelope.nonce)).digest("hex"),
    operation: envelope.operation,
    scopeDigest: envelope.scopeDigest,
    payloadDigest: envelope.payloadDigest,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    attestedAt: envelope.issuedAt,
    report,
  }));
  return {
    status: 200,
    url: request.url,
    headers: {
      "content-type": "application/json",
      "x-page2webmcp-signature": `hmac-sha256=${createHmac("sha256", token).update(body).digest("hex")}`,
    },
    body,
    ...overrides,
  };
}

function httpResponse(
  url: string,
  body: unknown,
  overrides: Partial<ReleaseVerifierHttpResponse> = {},
): ReleaseVerifierHttpResponse {
  return {
    status: 200,
    url,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
    ...overrides,
  };
}

test("candidate verification sends and accepts only the exact reviewed bytes under a trusted loader", async () => {
  let observedCode = "";
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async (input) => {
      observedCode = input.code;
      return report();
    },
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  };
  const attestation = await attestReleaseCandidate(candidateInput(), port, new AbortController().signal);

  assert.equal(observedCode, release.code);
  assert.equal(attestation.browserExecution, true);
  assert.equal(attestation.noSecretLeakage, true);
  assert.equal(attestation.selectionScore, 20);
  assert.deepEqual(attestation.checks.map(({ name }) => name), [...REQUIRED_CANDIDATE_CHECKS]);
  assert.deepEqual(attestation.verifierIdentity, {
    protocolVersion: 1,
    mode: "hermetic",
    webMcpImplementation: "native",
    verifierOriginDigest: "3fbdec91e0f941c39471af79d071c09048a2a4bdcb8c53adbc03a2d7c27efcbf",
  });
  assert.deepEqual(attestation.report.registeredTools, expectedTools);
});

test("candidate verification rejects forged loader, byte, tool, request, and check-set attestations", async (context) => {
  const cases: Array<[string, Partial<CandidateVerificationReport>]> = [
    ["wrong bytes", { observedContentHash: "0".repeat(64) }],
    ["loader after evaluation", { trustedLoader: { enforcedBeforeEvaluation: false, evaluatedContentHash: release.contentHash } }],
    ["wrong tools", { registeredTools: ["find_order"] }],
    ["control-plane call", { controlPlaneRequestsDuringExecution: 1 }],
    ["missing check", { checks: report().checks.slice(1) }],
    ["duplicate check", { checks: [...report().checks, report().checks[0]!] }],
  ];
  for (const [name, overrides] of cases) {
    await context.test(name, async () => {
      const port: ReleaseVerificationPort = {
        mode: "hermetic",
        verifyCandidate: async () => report(overrides),
        verifyInstalled: async () => { throw new Error("UNUSED"); },
      };
      await assert.rejects(attestReleaseCandidate(candidateInput(), port, new AbortController().signal),
        /CANDIDATE_VERIFICATION_INVALID|WRONG_STATE/);
    });
  }
});

test("candidate verification preserves an exact typed failure while failing browser execution closed", async () => {
  const failed = report({ checks: report().checks.map((check) => check.name === "final_state"
    ? { ...check, status: "failed" as const, code: "WRONG_STATE" as const }
    : check) });
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => failed,
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  };
  const attestation = await attestReleaseCandidate(candidateInput(), port, new AbortController().signal);
  assert.equal(attestation.browserExecution, false);
  assert.deepEqual(attestation.checks.find(({ name }) => name === "final_state"), {
    name: "final_state", status: "failed", code: "WRONG_STATE",
  });
});

test("production verification is unavailable without exact live controls", () => {
  assert.throws(() => configuredReleaseVerificationPort({}), /RELEASE_VERIFIER_CONFIGURATION_REQUIRED/);
});

test("configured live verification authenticates readiness immediately before candidate execution", async () => {
  const origin = "https://verifier.example";
  const token = "v".repeat(32);
  const requests: ReleaseVerifierHttpRequest[] = [];
  const port = configuredReleaseVerificationPort({
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: origin,
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: token,
  }, {
    mode: "live",
    deploymentIdentityDigest: verifierDeploymentDigest,
    transport: {
      request: async (input) => {
        requests.push(input);
        return input.url.endsWith("/v2/readiness")
          ? signedV2Response(input, token, {
            protocolVersion: 2, mode: "live", webMcpImplementation: "native",
          })
          : signedV2Response(input, token, report());
      },
    },
  });

  const attestation = await attestReleaseCandidate(candidateInput(), port, new AbortController().signal);
  assert.deepEqual(requests.map(({ url }) => url), [
    `${origin}/v2/readiness`,
    `${origin}/v2/candidates/verify`,
  ]);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-page2webmcp-signature"],
      `hmac-sha256=${createHmac("sha256", token).update(request.body).digest("hex")}`);
    assert.doesNotMatch(request.body, new RegExp(token));
  }
  assert.deepEqual(JSON.parse(requests[0]!.body).scope, {
    operation: "readiness",
    deploymentIdentityDigest: verifierDeploymentDigest,
  });
  assert.deepEqual(attestation.verifierIdentity, {
    protocolVersion: 2,
    mode: "live",
    webMcpImplementation: "native",
    verifierOriginDigest: "d1b8790504951c2f3c74c61299b9cfb8634ca1b0dc8e3b6ae57475bc37790a25",
  });
  assert.equal(attestation.verifierAttestation?.operation, "candidate");
  assert.deepEqual(attestation.report, report());
});

test("configured verification carries an exact 64KiB candidate inside a separately bounded JSON envelope", async () => {
  const origin = "https://verifier.example";
  const code = `/*${"x".repeat(65_532)}*/`;
  const contentHash = createHash("sha256").update(code).digest("hex");
  const integrity = `sha384-${createHash("sha384").update(code).digest("base64")}`;
  const input = {
    code,
    contentHash,
    integrity,
    manifest: { releaseId: contentHash },
    targetOrigin: "https://boundary.example",
    expectedTools: ["boundary_tool"],
    liveContext,
  };
  let candidateEnvelopeBytes = 0;
  const token = "v".repeat(32);
  const port = configuredReleaseVerificationPort({
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: origin,
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: token,
  }, {
    mode: "live",
    deploymentIdentityDigest: verifierDeploymentDigest,
    transport: {
      request: async (request) => {
        if (request.url.endsWith("/v2/readiness")) {
          return signedV2Response(request, token, {
            protocolVersion: 2,
            mode: "live",
            webMcpImplementation: "native",
          });
        }
        candidateEnvelopeBytes = Buffer.byteLength(request.body);
        return signedV2Response(request, token, {
          observedContentHash: contentHash,
          observedIntegrity: integrity,
          observedReleaseId: contentHash,
          observedTargetOrigin: input.targetOrigin,
          registeredTools: input.expectedTools,
          trustedLoader: { enforcedBeforeEvaluation: true, evaluatedContentHash: contentHash },
          controlPlaneRequestsDuringExecution: 0,
          modelRequestsDuringExecution: 0,
          checks: REQUIRED_CANDIDATE_CHECKS.map((name) => ({ name, status: "passed" as const })),
          csp: { hosted: "allowed" },
        });
      },
    },
  });

  const attestation = await attestReleaseCandidate(input, port, new AbortController().signal);
  assert.equal(Buffer.byteLength(code), 65_536);
  assert.ok(candidateEnvelopeBytes > 65_536);
  assert.equal(attestation.report.observedContentHash, contentHash);
});

test("candidate verification rejects an over-cap JSON envelope before readiness or execution", async () => {
  let calls = 0;
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    readiness: async () => {
      calls += 1;
      throw new Error("READINESS_MUST_NOT_RUN");
    },
    verifyCandidate: async () => {
      calls += 1;
      return report();
    },
    verifyInstalled: async () => { throw new Error("UNUSED"); },
  };
  await assert.rejects(attestReleaseCandidate({
    ...candidateInput(),
    manifest: {
      ...candidateInput().manifest,
      padding: "x".repeat(160 * 1_024),
    },
  }, port, new AbortController().signal), /CANDIDATE_VERIFICATION_INVALID/);
  assert.equal(calls, 0);
});

test("configured installation performs a fresh readiness handshake and returns its identity", async () => {
  const origin = "https://verifier.example";
  const token = "v".repeat(32);
  const paths: string[] = [];
  const port = configuredReleaseVerificationPort({
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: origin,
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: token,
  }, {
    mode: "live",
    deploymentIdentityDigest: verifierDeploymentDigest,
    transport: {
      request: async (input) => {
        paths.push(new URL(input.url).pathname);
        return input.url.endsWith("/v2/readiness")
          ? signedV2Response(input, token, {
            protocolVersion: 2, mode: "live", webMcpImplementation: "native",
          })
          : signedV2Response(input, token, {
            observedArtifactUrl: artifactUrl,
            observedDownloadUrl: downloadUrl,
            observedLocalOnly: false,
            observedIntegrity: release.integrity,
            executedArtifactUrl: artifactUrl,
            servedContentHash: release.contentHash,
            executedContentHash: release.contentHash,
            observedTargetOrigin: release.allowedOrigin,
            registeredTools: expectedTools,
            webMcpImplementation: "native",
            normalPageLoad: true,
            routeInterception: false,
            injectedRegistration: false,
            syntheticHarness: false,
            duplicateLoadHarmless: true,
            executionEvidence: installedExecutionEvidence(),
            csp: { hosted: "allowed" },
          });
      },
    },
  });

  const attestation = await attestReleaseInstallation(installedInput(), port, new AbortController().signal);
  assert.deepEqual(paths, ["/v2/readiness", "/v2/installations/verify"]);
  assert.equal(attestation.verifierIdentity.mode, "live");
  assert.equal(attestation.verifierIdentity.protocolVersion, 2);
  assert.equal(attestation.verifierAttestation?.operation, "installation");
  assert.equal(attestation.verifierIdentity.verifierOriginDigest,
    "d1b8790504951c2f3c74c61299b9cfb8634ca1b0dc8e3b6ae57475bc37790a25");
});

test("verifier tokens accept the exact 32..4096 boundary and reject values outside it", () => {
  const origin = "https://verifier.example";
  const transport = { request: async () => { throw new Error("UNUSED"); } };
  for (const length of [32, 4_096]) {
    assert.doesNotThrow(() => configuredReleaseVerificationPort({
      PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: origin,
      PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "v".repeat(length),
    }, { mode: "live", transport, deploymentIdentityDigest: verifierDeploymentDigest }));
  }
  for (const length of [31, 4_097]) {
    assert.throws(() => configuredReleaseVerificationPort({
      PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: origin,
      PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "v".repeat(length),
    }, { mode: "live", transport, deploymentIdentityDigest: verifierDeploymentDigest }),
    /RELEASE_VERIFIER_CONFIGURATION_REQUIRED/);
  }
});

test("live verifier construction never reads the local verifier origin", () => {
  const touched: string[] = [];
  const environment = new Proxy({
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "v".repeat(32),
  } as Record<string, string | undefined>, {
    get(target, property, receiver) {
      if (property === "PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN") {
        throw new Error("LOCAL_VERIFIER_ENV_READ");
      }
      touched.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  assert.doesNotThrow(() => configuredReleaseVerificationPort(environment, {
    mode: "live",
    deploymentIdentityDigest: verifierDeploymentDigest,
    transport: { request: async () => { throw new Error("UNUSED"); } },
  }));
  assert.equal(touched.includes("PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN"), false);
});

test("local-live verifier accepts only an explicit exact loopback HTTP origin", async (context) => {
  const token = "v".repeat(32);
  const transport = { request: async () => { throw new Error("UNUSED"); } };
  for (const [origin, digest] of [
    ["http://127.0.0.1:7777", "30ae29fa7395154be25a9b54c9fdb97839b01400d7899ff0b361a0824c300715"],
    ["http://[::1]:7777", "83088dad521bd93bc1e57b72cba3fc85425de05868e9285b76a9b6f03c3d42fc"],
  ] as const) {
    const port = configuredReleaseVerificationPort({
      PAGE2WEBMCP_LOCAL_STACK: "true",
      PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN: origin,
      PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: token,
    }, {
      mode: "local_live",
      transport: {
        request: async (input) => httpResponse(input.url, {
          protocolVersion: 1,
          mode: "local_live",
          webMcpImplementation: "native",
        }),
      },
    });
    assert.equal(port.mode, "local_live");
    assert.deepEqual(await port.readiness(new AbortController().signal), {
      protocolVersion: 1,
      mode: "local_live",
      webMcpImplementation: "native",
      verifierOriginDigest: digest,
    });
  }
  const invalid = [
    ["local stack absent", undefined, "http://127.0.0.1:7777"],
    ["localhost alias", "true", "http://localhost:7777"],
    ["public address", "true", "http://192.0.2.1:7777"],
    ["HTTPS loopback", "true", "https://127.0.0.1:7777"],
    ["path present", "true", "http://127.0.0.1:7777/verifier"],
    ["trailing slash", "true", "http://127.0.0.1:7777/"],
    ["port absent", "true", "http://127.0.0.1"],
  ] as const;
  for (const [name, localStack, origin] of invalid) {
    await context.test(name, () => {
      assert.throws(() => configuredReleaseVerificationPort({
        ...(localStack ? { PAGE2WEBMCP_LOCAL_STACK: localStack } : {}),
        PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN: origin,
        PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: token,
      }, { mode: "local_live", transport }), /RELEASE_VERIFIER_CONFIGURATION_REQUIRED/);
    });
  }
});

test("readiness identity mismatches and absent non-hermetic readiness fail before execution", async (context) => {
  const identity = {
    protocolVersion: 1 as const,
    mode: "local_live" as const,
    webMcpImplementation: "native" as const,
    verifierOriginDigest: "d".repeat(64),
  };
  let executions = 0;
  await context.test("identity mode mismatch", async () => {
    const port: ReleaseVerificationPort = {
      mode: "live",
      readiness: async () => identity,
      verifyCandidate: async () => { executions += 1; return report(); },
      verifyInstalled: async () => { throw new Error("UNUSED"); },
    };
    await assert.rejects(attestReleaseCandidate(candidateInput(), port, new AbortController().signal),
      /RELEASE_VERIFIER_IDENTITY_INVALID/);
  });
  await context.test("missing live readiness", async () => {
    const port: ReleaseVerificationPort = {
      mode: "live",
      verifyCandidate: async () => { executions += 1; return report(); },
      verifyInstalled: async () => { throw new Error("UNUSED"); },
    };
    await assert.rejects(attestReleaseCandidate(candidateInput(), port, new AbortController().signal),
      /RELEASE_VERIFIER_IDENTITY_REQUIRED/);
  });
  assert.equal(executions, 0);
});

test("readiness rejects redirect, status, MIME, cookies, credential dependence, and non-native schemas", async (context) => {
  const origin = "https://verifier.example";
  const token = "v".repeat(32);
  const base = { protocolVersion: 2, mode: "live", webMcpImplementation: "native" };
  const cases: Array<[string, unknown, Partial<ReleaseVerifierHttpResponse>]> = [
    ["redirected URL", base, { url: "https://other.example/v2/readiness" }],
    ["redirect status", base, { status: 302 }],
    ["wrong MIME", base, { headers: { "content-type": "text/plain" } }],
    ["response cookie", base, { headers: { "content-type": "application/json", "set-cookie": "sid=secret" } }],
    ["credential-dependent CORS", base, {
      headers: { "content-type": "application/json", "access-control-allow-credentials": "true" },
    }],
    ["wrong mode", { ...base, mode: "local_live" }, {}],
    ["wrong protocol", { ...base, protocolVersion: 1 }, {}],
    ["compatibility shim", { ...base, webMcpImplementation: "compatibility_shim" }, {}],
    ["extra field", { ...base, healthy: true }, {}],
  ];
  for (const [name, body, overrides] of cases) {
    await context.test(name, async () => {
      let candidateCalls = 0;
      const port = configuredReleaseVerificationPort({
        PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: origin,
        PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: token,
      }, {
        mode: "live",
        deploymentIdentityDigest: verifierDeploymentDigest,
        transport: {
          request: async (input) => input.url.endsWith("/v2/readiness")
            ? signedV2Response(input, token, body, overrides)
            : (candidateCalls += 1, httpResponse(input.url, report())),
        },
      });
      await assert.rejects(attestReleaseCandidate(candidateInput(), port, new AbortController().signal),
        /RELEASE_VERIFIER_RESPONSE_INVALID|RELEASE_VERIFIER_IDENTITY_INVALID/);
      assert.equal(candidateCalls, 0);
    });
  }
});

test("readiness body is bounded and caller cancellation prevents candidate execution", async (context) => {
  const origin = "https://verifier.example";
  const environment = {
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: origin,
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: "v".repeat(32),
  };
  await context.test("oversized body", async () => {
    const port = configuredReleaseVerificationPort(environment, {
      mode: "live",
      deploymentIdentityDigest: verifierDeploymentDigest,
      transport: { request: async (input) => httpResponse(input.url, {}, { body: Buffer.alloc(65_537) }) },
    });
    await assert.rejects(port.readiness(new AbortController().signal), /RELEASE_VERIFIER_RESPONSE_INVALID/);
  });
  await context.test("caller abort", async () => {
    let candidateCalls = 0;
    const port = configuredReleaseVerificationPort(environment, {
      mode: "live",
      deploymentIdentityDigest: verifierDeploymentDigest,
      transport: {
        request: (input) => new Promise((_resolve, reject) => {
          if (!input.url.endsWith("/v2/readiness")) candidateCalls += 1;
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        }),
      },
    });
    const controller = new AbortController();
    const pending = attestReleaseCandidate(candidateInput(), port, controller.signal);
    controller.abort(new Error("TEST_CANCELLED"));
    await assert.rejects(pending, /TEST_CANCELLED/);
    assert.equal(candidateCalls, 0);
  });
});

test("installed verification proves a normal unintercepted native WebMCP page loaded exact bytes", async () => {
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async (input) => ({
      observedArtifactUrl: input.artifactUrl,
      observedDownloadUrl: input.downloadUrl,
      observedLocalOnly: input.localOnly,
      observedIntegrity: input.integrity,
      executedArtifactUrl: input.artifactUrl,
      servedContentHash: input.contentHash,
      executedContentHash: input.contentHash,
      observedTargetOrigin: input.targetOrigin,
      registeredTools: [...input.expectedTools],
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: true,
      executionEvidence: installedExecutionEvidence(),
      csp: { hosted: "allowed" },
    }),
  };
  const attestation = await attestReleaseInstallation(installedInput(), port, new AbortController().signal);
  assert.deepEqual(attestation, {
    status: "verified",
    delivery: "hosted",
    csp: { hosted: "allowed" },
    webMcpImplementation: "native",
    verifierIdentity: {
      protocolVersion: 1,
      mode: "hermetic",
      webMcpImplementation: "native",
      verifierOriginDigest: "3fbdec91e0f941c39471af79d071c09048a2a4bdcb8c53adbc03a2d7c27efcbf",
    },
    report: {
      observedArtifactUrl: artifactUrl,
      observedDownloadUrl: downloadUrl,
      observedLocalOnly: false,
      observedIntegrity: release.integrity,
      executedArtifactUrl: artifactUrl,
      servedContentHash: release.contentHash,
      executedContentHash: release.contentHash,
      observedTargetOrigin: release.allowedOrigin,
      registeredTools: expectedTools,
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: true,
      executionEvidence: installedExecutionEvidence(),
      csp: { hosted: "allowed" },
    },
  });
});

test("installed verification rejects registration-only evidence without native tool execution", async () => {
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async (input) => ({
      observedArtifactUrl: input.artifactUrl,
      observedDownloadUrl: input.downloadUrl,
      observedLocalOnly: input.localOnly,
      observedIntegrity: input.integrity,
      executedArtifactUrl: input.artifactUrl,
      servedContentHash: input.contentHash,
      executedContentHash: input.contentHash,
      observedTargetOrigin: input.targetOrigin,
      registeredTools: [...input.expectedTools],
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: true,
      csp: { hosted: "allowed" },
    }) as unknown as InstalledVerificationReport,
  };

  await assert.rejects(
    attestReleaseInstallation(installedInput(), port, new AbortController().signal),
    /INSTALLED_VERIFICATION_INVALID/,
  );
});

test("installed verification rejects interception, injection, synthetic/shim success, wrong hashes, and harmful duplicates", async (context) => {
  const base = {
    observedArtifactUrl: artifactUrl,
    observedDownloadUrl: downloadUrl,
    observedLocalOnly: false,
    observedIntegrity: release.integrity,
    executedArtifactUrl: artifactUrl,
    servedContentHash: release.contentHash,
    executedContentHash: release.contentHash,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    webMcpImplementation: "native" as const,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    executionEvidence: installedExecutionEvidence(),
    csp: { hosted: "allowed" as const },
  };
  const cases = [
    ["wrong served hash", { servedContentHash: "0".repeat(64) }],
    ["wrong executed hash", { executedContentHash: "0".repeat(64) }],
    ["wrong artifact URL", { observedArtifactUrl: `https://unrelated.example/${release.contentHash}.js` }],
    ["wrong download URL", { observedDownloadUrl: `${artifactUrl}?download=wrong.js` }],
    ["wrong locality", { observedLocalOnly: true }],
    ["wrong integrity", { observedIntegrity: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    ["wrong executed URL", { executedArtifactUrl: `https://unrelated.example/${release.contentHash}.js` }],
    ["route interception", { routeInterception: true }],
    ["registration injection", { injectedRegistration: true }],
    ["synthetic harness", { syntheticHarness: true }],
    ["compatibility shim", { webMcpImplementation: "compatibility_shim" as const }],
    ["harmful duplicate", { duplicateLoadHarmless: false }],
  ] as const;
  for (const [name, overrides] of cases) {
    await context.test(name, async () => {
      const port: ReleaseVerificationPort = {
        mode: name === "compatibility shim" ? "local_live" : "hermetic",
        ...(name === "compatibility shim" ? {
          readiness: async () => ({
            protocolVersion: 1,
            mode: "local_live" as const,
            webMcpImplementation: "native" as const,
            verifierOriginDigest: "d".repeat(64),
          }),
        } : {}),
        verifyCandidate: async () => { throw new Error("UNUSED"); },
        verifyInstalled: async () => ({ ...base, ...overrides }),
      };
      await assert.rejects(attestReleaseInstallation(installedInput(), port, new AbortController().signal),
        /INSTALLED_VERIFICATION_INVALID|WEBMCP_NATIVE_REQUIRED/);
    });
  }
});

test("CSP blocked hosted delivery remains uninstalled and requires exact-hash self-host verification", async () => {
  const port: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async (input) => ({
      observedArtifactUrl: input.artifactUrl,
      observedDownloadUrl: input.downloadUrl,
      observedLocalOnly: input.localOnly,
      observedIntegrity: input.integrity,
      executedArtifactUrl: null,
      servedContentHash: input.contentHash,
      executedContentHash: null,
      observedTargetOrigin: input.targetOrigin,
      registeredTools: [],
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: null,
      executionEvidence: null,
      csp: { hosted: "blocked", directive: "script-src 'self'" },
    }),
  };
  const attestation = await attestReleaseInstallation(installedInput(), port, new AbortController().signal);
  assert.deepEqual(attestation, {
    status: "pending_self_host",
    delivery: "hosted",
    csp: { hosted: "blocked", directive: "script-src 'self'" },
    webMcpImplementation: "native",
    verifierIdentity: {
      protocolVersion: 1,
      mode: "hermetic",
      webMcpImplementation: "native",
      verifierOriginDigest: "3fbdec91e0f941c39471af79d071c09048a2a4bdcb8c53adbc03a2d7c27efcbf",
    },
    report: {
      observedArtifactUrl: artifactUrl,
      observedDownloadUrl: downloadUrl,
      observedLocalOnly: false,
      observedIntegrity: release.integrity,
      executedArtifactUrl: null,
      servedContentHash: release.contentHash,
      executedContentHash: null,
      observedTargetOrigin: release.allowedOrigin,
      registeredTools: [],
      webMcpImplementation: "native",
      normalPageLoad: true,
      routeInterception: false,
      injectedRegistration: false,
      syntheticHarness: false,
      duplicateLoadHarmless: null,
      executionEvidence: null,
      csp: { hosted: "blocked", directive: "script-src 'self'" },
    },
  });

  const impossibleExecution: ReleaseVerificationPort = {
    ...port,
    verifyInstalled: async (input) => ({
      ...await port.verifyInstalled(input, new AbortController().signal),
      executedArtifactUrl: input.artifactUrl,
      executedContentHash: input.contentHash,
      registeredTools: [...input.expectedTools],
    }),
  };
  await assert.rejects(attestReleaseInstallation(installedInput(), impossibleExecution,
    new AbortController().signal), /INSTALLED_VERIFICATION_INVALID/);
});

test("local artifact verification is hermetic-only and bound to the canonical Docker identity", async () => {
  const localArtifactUrl = `http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/${release.contentHash}.js`;
  const localDownloadUrl = `${localArtifactUrl}?download=page2webmcp-${release.contentHash}.js`;
  const report = {
    observedArtifactUrl: localArtifactUrl,
    observedDownloadUrl: localDownloadUrl,
    observedLocalOnly: true,
    observedIntegrity: release.integrity,
    executedArtifactUrl: localArtifactUrl,
    servedContentHash: release.contentHash,
    executedContentHash: release.contentHash,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    webMcpImplementation: "native" as const,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    executionEvidence: installedExecutionEvidence(),
    csp: { hosted: "allowed" as const },
  };
  const hermetic: ReleaseVerificationPort = {
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async () => report,
  };
  const localInput = installedInput({ artifactUrl: localArtifactUrl, downloadUrl: localDownloadUrl, localOnly: true });
  assert.equal((await attestReleaseInstallation(localInput, hermetic, new AbortController().signal)).status, "verified");

  const live: ReleaseVerificationPort = { ...hermetic, mode: "live" };
  await assert.rejects(attestReleaseInstallation(localInput, live, new AbortController().signal),
    /INSTALLED_VERIFICATION_INVALID/);
});

test("self-host verification preserves canonical Storage identity and separately proves the executed URL", async (context) => {
  const selfHostedUrl = `https://acme.example/assets/${release.contentHash}.js`;
  const baseReport = {
    observedArtifactUrl: artifactUrl,
    observedDownloadUrl: downloadUrl,
    observedLocalOnly: false,
    observedIntegrity: release.integrity,
    executedArtifactUrl: selfHostedUrl,
    servedContentHash: release.contentHash,
    executedContentHash: release.contentHash,
    observedTargetOrigin: release.allowedOrigin,
    registeredTools: expectedTools,
    webMcpImplementation: "native" as const,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    executionEvidence: installedExecutionEvidence(),
    csp: { hosted: "blocked" as const, directive: "script-src 'self'" },
  };
  const input = installedInput({ selfHostedUrl });
  const port = (report: typeof baseReport): ReleaseVerificationPort => ({
    mode: "hermetic",
    verifyCandidate: async () => { throw new Error("UNUSED"); },
    verifyInstalled: async () => report,
  });
  const attestation = await attestReleaseInstallation(input, port(baseReport), new AbortController().signal);
  assert.equal(attestation.delivery, "self_hosted");
  assert.equal(attestation.report.observedArtifactUrl, artifactUrl);
  assert.equal(attestation.report.executedArtifactUrl, selfHostedUrl);

  const cases = [
    ["canonical replaced by self-host", { observedArtifactUrl: selfHostedUrl }],
    ["canonical executed instead", { executedArtifactUrl: artifactUrl }],
    ["unrelated URL executed", { executedArtifactUrl: `https://acme.example/assets/${"0".repeat(64)}.js` }],
  ] as const;
  for (const [name, override] of cases) {
    await context.test(name, async () => {
      await assert.rejects(attestReleaseInstallation(input, port({ ...baseReport, ...override }),
        new AbortController().signal), /INSTALLED_VERIFICATION_INVALID/);
    });
  }
});
