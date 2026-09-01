import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredWebsiteUserHandoffPort,
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
