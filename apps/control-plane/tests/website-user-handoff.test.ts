import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredWebsiteAuthenticationHandoffPort,
  createConfiguredWebsiteUserHandoffPort,
  type WebsiteAuthenticationHandoffBinding,
  type WebsiteUserHandoffBinding,
} from "../src/website-user-handoff.ts";
import type { NodePinnedJsonTransport } from "../../worker/src/node-network.ts";

const binding: WebsiteUserHandoffBinding = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectSourceId: "33333333-3333-4333-8333-333333333333",
  sourceSnapshotId: "55555555-5555-4555-8555-555555555555",
  sourceIdentityHash: "a".repeat(64),
  sourceUrl: "https://widgets.example/support",
  targetOrigin: "https://widgets.example",
};

const environment = {
  PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN: "https://ownership.example",
  PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN: "ownership_operator_token_abcdefghijklmnopqrstuvwxyz",
  PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN: "https://authentication.example",
  PAGE2WEBMCP_AUTH_HANDOFF_TOKEN: "authentication_operator_token_abcdefghijklmnopqrstuvwxyz",
  PAGE2WEBMCP_BROWSER_USE_API_ORIGIN: "https://browser-gateway.example",
};

const authenticationBinding: WebsiteAuthenticationHandoffBinding = {
  organizationId: binding.organizationId,
  projectId: binding.projectId,
  workflowRunId: "66666666-6666-4666-8666-666666666666",
  analysisRunId: "77777777-7777-4777-8777-777777777777",
  workflowTaskId: "88888888-8888-4888-8888-888888888888",
  sourceSnapshotId: binding.sourceSnapshotId,
  sourceIdentityHash: binding.sourceIdentityHash,
  targetOrigin: binding.targetOrigin,
  targetOriginDigest: "b".repeat(64),
  checkpointReference: `urn:sha256:${"c".repeat(64)}`,
  expiresAt: "2026-09-01T12:08:00.000Z",
};

function jsonResponse(url: string, value: unknown, status = 200) {
  return {
    status,
    url,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

test("configured website handoff issues source-bound ownership instructions without returning operator credentials", async () => {
  const requests: Parameters<NodePinnedJsonTransport["request"]>[0][] = [];
  const transport: NodePinnedJsonTransport = {
    request: async (request) => {
      requests.push(request);
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      return jsonResponse(request.url, {
        ...body,
        state: "pending",
        method: "dns_txt",
        token: "A".repeat(43),
        targetOrigin: binding.targetOrigin,
        expiresAt: "2026-09-01T12:15:00.000Z",
      });
    },
  };
  const port = createConfiguredWebsiteUserHandoffPort(environment, {
    transport,
    clock: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  const result = await port.issueOwnershipChallenge(
    binding,
    "ownership-challenge-0001",
    new AbortController().signal,
  );

  assert.deepEqual(result, {
    state: "pending",
    method: "dns_txt",
    targetOrigin: "https://widgets.example",
    expiresAt: "2026-09-01T12:15:00.000Z",
    instructions: {
      recordName: "_page2webmcp.widgets.example",
      recordType: "TXT",
      recordValue: `page2webmcp-verification=${"A".repeat(43)};origin=https://widgets.example;expires=2026-09-01T12:15:00.000Z`,
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://ownership.example/v1/website-ownership/source-attestations/issue");
  assert.equal(requests[0]!.headers.authorization, `Bearer ${environment.PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN}`);
  const requestBody = JSON.parse(requests[0]!.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(requestBody.source, {
    projectSourceId: binding.projectSourceId,
    sourceSnapshotId: binding.sourceSnapshotId,
    sourceIdentityHash: binding.sourceIdentityHash,
    sourceUrl: binding.sourceUrl,
    targetOrigin: binding.targetOrigin,
  });
  assert.deepEqual(requestBody.scope, {
    organizationId: binding.organizationId,
    projectId: binding.projectId,
  });
  assert.equal("ownership" in requestBody, false);
  assert.doesNotMatch(JSON.stringify(result), /operator_token|secretref:/i);
});

test("configured website handoff fails closed when its ownership control is absent", () => {
  assert.throws(
    () => createConfiguredWebsiteUserHandoffPort({
      ...environment,
      PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN: undefined,
    }),
    /WEBSITE_LIVE_CONFIGURATION_REQUIRED/,
  );
});

test("configured authentication handoff fails closed when either dedicated control is absent", () => {
  for (const missing of ["PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN", "PAGE2WEBMCP_AUTH_HANDOFF_TOKEN"] as const) {
    assert.throws(
      () => createConfiguredWebsiteAuthenticationHandoffPort({ ...environment, [missing]: undefined }),
      /^Error: WEBSITE_LIVE_CONFIGURATION_REQUIRED$/,
    );
  }
  assert.throws(
    () => createConfiguredWebsiteAuthenticationHandoffPort({
      ...environment,
      PAGE2WEBMCP_BROWSER_USE_API_ORIGIN: environment.PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN,
    }),
    /^Error: WEBSITE_LIVE_CONFIGURATION_REQUIRED$/,
  );
});

test("configured website handoff reports an unsupported additive store protocol without inventing state", async () => {
  const unsupported: NodePinnedJsonTransport = {
    request: async (request) => jsonResponse(request.url, { code: "NOT_FOUND" }, 404),
  };
  const port = createConfiguredWebsiteUserHandoffPort(environment, { transport: unsupported });
  await assert.rejects(
    port.ownershipStatus(binding, new AbortController().signal),
    /WEBSITE_HANDOFF_PROTOCOL_UNSUPPORTED/,
  );
});

test("configured authentication handoff returns only a gateway-origin portal and exact evidence reference", async () => {
  const requests: Parameters<NodePinnedJsonTransport["request"]>[0][] = [];
  const transport: NodePinnedJsonTransport = {
    request: async (request) => {
      requests.push(request);
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      if (request.url.endsWith("/portal")) return jsonResponse(request.url, {
        ...body,
        state: "waiting",
        targetOrigin: authenticationBinding.targetOrigin,
        expiresAt: authenticationBinding.expiresAt,
        portalUrl: "https://authentication.example/portal?handoff=safe_public_reference",
      });
      return jsonResponse(request.url, {
        ...body,
        status: "ready",
        targetOrigin: authenticationBinding.targetOrigin,
        expiresAt: authenticationBinding.expiresAt,
        authenticationEvidenceReference: `urn:sha256:${"d".repeat(64)}`,
      });
    },
  };
  const port = createConfiguredWebsiteAuthenticationHandoffPort(environment, {
    transport,
    clock: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  const portal = await port.loadAuthenticationPortal(authenticationBinding, new AbortController().signal);
  const ready = await port.checkAuthentication(
    authenticationBinding,
    "authentication-check-0001",
    new AbortController().signal,
  );

  assert.deepEqual(portal, {
    state: "waiting",
    targetOrigin: authenticationBinding.targetOrigin,
    expiresAt: authenticationBinding.expiresAt,
    portalUrl: "https://authentication.example/portal?handoff=safe_public_reference",
  });
  assert.deepEqual(ready, {
    state: "ready",
    targetOrigin: authenticationBinding.targetOrigin,
    expiresAt: authenticationBinding.expiresAt,
    authenticationEvidenceReference: `urn:sha256:${"d".repeat(64)}`,
  });
  assert.equal(requests[0]?.url, "https://authentication.example/v1/authentication/checkpoints/portal");
  assert.equal(requests[1]?.url, "https://authentication.example/v1/authentication/checkpoints/status");
  const envelope = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(envelope.scope, {
    organizationId: authenticationBinding.organizationId,
    projectId: authenticationBinding.projectId,
  });
  assert.deepEqual(envelope.workflow, {
    workflowRunId: authenticationBinding.workflowRunId,
    analysisRunId: authenticationBinding.analysisRunId,
    workflowTaskId: authenticationBinding.workflowTaskId,
  });
  assert.deepEqual(envelope.checkpoint, {
    sourceSnapshotId: authenticationBinding.sourceSnapshotId,
    sourceIdentityHash: authenticationBinding.sourceIdentityHash,
    targetOrigin: authenticationBinding.targetOrigin,
    targetOriginDigest: authenticationBinding.targetOriginDigest,
    checkpointReference: authenticationBinding.checkpointReference,
    expiresAt: authenticationBinding.expiresAt,
  });
  assert.doesNotMatch(JSON.stringify({ portal, ready }), /secretref|cdp|providerSession|operator_token/i);
});

test("authentication portal validation rejects off-origin, credential-shaped, and over-TTL responses", async () => {
  for (const portalUrl of [
    "https://evil.example/portal?handoff=safe",
    "https://authentication.example/portal?token=credential",
    "https://user:password@authentication.example/portal",
    "https://authentication.example/portal#secret",
    "https://authentication.example/live/provider-session-id",
    "https://authentication.example/sessions/raw-live-reference?handoff=safe",
    "https://authentication.example/portal?reference=safe",
  ]) {
    const transport: NodePinnedJsonTransport = {
      request: async (request) => jsonResponse(request.url, {
        ...JSON.parse(request.body ?? "{}"),
        state: "waiting",
        targetOrigin: authenticationBinding.targetOrigin,
        expiresAt: authenticationBinding.expiresAt,
        portalUrl,
      }),
    };
    const port = createConfiguredWebsiteAuthenticationHandoffPort(environment, {
      transport,
      clock: () => new Date("2026-09-01T12:00:00.000Z"),
    });
    await assert.rejects(
      port.loadAuthenticationPortal(authenticationBinding, new AbortController().signal),
      /WEBSITE_HANDOFF_RESPONSE_INVALID/,
    );
  }
});
