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
} from "../src/release-verification.ts";
import { canonicalVerifierJson } from "../src/release-verifier-protocol-v2.ts";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const TOKEN = "verifier-secret-token-value-1234567890";
const DEPLOYMENT_DIGEST = "d".repeat(64);
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ANALYSIS_RUN_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_IDENTITY_HASH = "c".repeat(64);
const release = compileWebMcpRelease(acmeCapabilityPlans("https://acme.example")
  .filter((plan) => plan.tool.name !== "get_order_status"));
const expectedTools = ["create_support_ticket", "find_order"];

function candidateReport(): CandidateVerificationReport {
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
  };
}

function signedResponse(
  request: ReleaseVerifierHttpRequest,
  report: unknown,
  attestationId: string,
): ReleaseVerifierHttpResponse {
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(
    request.headers["x-page2webmcp-signature"],
    `hmac-sha256=${createHmac("sha256", TOKEN).update(request.body).digest("hex")}`,
  );
  const envelope = JSON.parse(request.body) as Record<string, unknown>;
  assert.equal(envelope.schema, "ReleaseVerifierRequestV2");
  assert.equal(envelope.protocolVersion, 2);
  const body = Buffer.from(canonicalVerifierJson({
    schema: "ReleaseVerifierAttestationV2",
    protocolVersion: 2,
    attestationId,
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
      "x-page2webmcp-signature": `hmac-sha256=${createHmac("sha256", TOKEN).update(body).digest("hex")}`,
    },
    body,
  };
}

test("configured production verification signs protocol-v2 readiness and candidate scopes and returns secret-free identity", async () => {
  const requests: ReleaseVerifierHttpRequest[] = [];
  let requestSequence = 0;
  const port = configuredReleaseVerificationPort({
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: TOKEN,
  }, {
    mode: "live",
    deploymentIdentityDigest: DEPLOYMENT_DIGEST,
    now: () => NOW,
    randomUuid: () => [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ][requestSequence++]!,
    randomBytes: () => Buffer.alloc(32, requestSequence),
    replayGuard: { admit: () => true },
    transport: {
      request: async (request: ReleaseVerifierHttpRequest) => {
        requests.push(request);
        return request.url.endsWith("/readiness")
          ? signedResponse(request, {
            protocolVersion: 2,
            mode: "live",
            webMcpImplementation: "native",
          }, "55555555-5555-4555-8555-555555555555")
          : signedResponse(request, candidateReport(), "66666666-6666-4666-8666-666666666666");
      },
    },
  } as never);

  const attestation = await attestReleaseCandidate({
    code: release.code,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
    expectedTools,
    liveContext: {
      projectId: PROJECT_ID,
      analysisRunId: ANALYSIS_RUN_ID,
      sourceIdentityHash: SOURCE_IDENTITY_HASH,
      environment: "staging",
    },
  } as never, port, new AbortController().signal);

  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0]!.body).scope, {
    operation: "readiness",
    deploymentIdentityDigest: DEPLOYMENT_DIGEST,
  });
  assert.deepEqual(JSON.parse(requests[1]!.body).scope, {
    operation: "candidate",
    projectId: PROJECT_ID,
    analysisRunId: ANALYSIS_RUN_ID,
    sourceIdentityHash: SOURCE_IDENTITY_HASH,
    targetOrigin: release.allowedOrigin,
    environment: "staging",
    contentHash: release.contentHash,
  });
  assert.deepEqual(JSON.parse(requests[1]!.body).payload, {
    code: release.code,
    contentHash: release.contentHash,
    expectedTools,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
  });
  assert.equal(attestation.verifierIdentity.protocolVersion, 2);
  assert.deepEqual(attestation.verifierAttestation, {
    protocolVersion: 2,
    attestationId: "66666666-6666-4666-8666-666666666666",
    requestId: "44444444-4444-4444-8444-444444444444",
    nonceDigest: createHash("sha256").update(Buffer.alloc(32, 2).toString("base64url")).digest("hex"),
    operation: "candidate",
    scopeDigest: JSON.parse(requests[1]!.body).scopeDigest,
    payloadDigest: JSON.parse(requests[1]!.body).payloadDigest,
    issuedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-01T12:01:00.000Z",
    attestedAt: "2026-09-01T12:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(attestation), /verifier-secret-token/);
});

test("configured production installation verification binds the exact page, operation identity, source, environment, and selected hash", async () => {
  const artifactUrl = `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${release.contentHash}.js`;
  const downloadUrl = `${artifactUrl}?download=page2webmcp-${release.contentHash}.js`;
  const pageUrl = "https://acme.example/account";
  const operationId = "e".repeat(64);
  const requests: ReleaseVerifierHttpRequest[] = [];
  let requestSequence = 0;
  const installedReport: InstalledVerificationReport = {
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
    executionEvidence: {
      authenticatedRead: { toolName: "find_order", authenticated: true, succeeded: true },
      confirmedReversibleMutation: {
        toolName: "create_support_ticket", confirmation: "explicit", reversible: true,
        succeeded: true, effectCount: 1,
      },
      authoritativeFinalState: {
        mutationToolName: "create_support_ticket", source: "target", verified: true,
      },
    },
    csp: { hosted: "allowed" },
  };
  const port = configuredReleaseVerificationPort({
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.example",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: TOKEN,
  }, {
    mode: "live",
    deploymentIdentityDigest: DEPLOYMENT_DIGEST,
    now: () => NOW,
    randomUuid: () => [
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ][requestSequence++]!,
    randomBytes: () => Buffer.alloc(32, requestSequence + 2),
    replayGuard: { admit: () => true },
    transport: {
      request: async (request: ReleaseVerifierHttpRequest) => {
        requests.push(request);
        return request.url.endsWith("/readiness")
          ? signedResponse(request, {
            protocolVersion: 2, mode: "live", webMcpImplementation: "native",
          }, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
          : signedResponse(request, installedReport, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
      },
    },
  } as never);

  const attestation = await attestReleaseInstallation({
    pageUrl,
    artifactUrl,
    downloadUrl,
    localOnly: false,
    contentHash: release.contentHash,
    integrity: release.integrity,
    manifest: release.manifest,
    targetOrigin: release.allowedOrigin,
    expectedTools,
    liveContext: {
      projectId: PROJECT_ID,
      releaseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      installationOperationId: operationId,
      sourceIdentityHash: SOURCE_IDENTITY_HASH,
      environment: "production",
    },
  }, port, new AbortController().signal);

  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1]!.body).scope, {
    operation: "installation",
    projectId: PROJECT_ID,
    releaseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    installationOperationId: operationId,
    sourceIdentityHash: SOURCE_IDENTITY_HASH,
    pageUrl,
    targetOrigin: release.allowedOrigin,
    environment: "production",
    selectedHash: release.contentHash,
  });
  assert.equal(attestation.verifierAttestation?.operation, "installation");
  assert.equal(attestation.verifierIdentity.protocolVersion, 2);
  assert.doesNotMatch(JSON.stringify(attestation), new RegExp(TOKEN));
});
