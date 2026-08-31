import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createConfiguredOpenApiAnalysisAdapter } from "./openapi-live.ts";
import type { OpenApiProviderControls } from "../../../packages/providers/src/openapi.ts";

function sourceResponse(url: string, source: string) {
  return {
    status: 200,
    url,
    connectedAddress: "93.184.216.34",
    tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
    headers: { "content-type": "application/json" },
    body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
  } as const;
}

test("configured OpenAPI factory fails only invalid operator mode or transport construction at startup", async () => {
  assert.throws(() => createConfiguredOpenApiAnalysisAdapter({}, {}), /^Error: OPENAPI_LIVE_CONFIGURATION_REQUIRED$/);
  assert.throws(() => createConfiguredOpenApiAnalysisAdapter({ PAGE2WEBMCP_PROVIDER_MODE: "local" }, {}), /^Error: OPENAPI_LIVE_CONFIGURATION_REQUIRED$/);
  assert.throws(() => createConfiguredOpenApiAnalysisAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    { resolver: {} as OpenApiProviderControls["resolver"] },
  ), /^Error: OPENAPI_LIVE_CONFIGURATION_REQUIRED$/);
  assert.throws(() => createConfiguredOpenApiAnalysisAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    { groupingPort: {} as never },
  ), /^Error: OPENAPI_LIVE_CONFIGURATION_REQUIRED$/);

  const adapter = createConfiguredOpenApiAnalysisAdapter({ PAGE2WEBMCP_PROVIDER_MODE: "openapi" }, {});
  await assert.rejects(adapter({
    sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json",
  }, new AbortController().signal), /^RepositoryError: OPENAPI_VERIFICATION_CONTEXT_REQUIRED$/);
});

test("configured OpenAPI factory consumes per-run context and ignores deployment target defaults", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0", info: { title: "Widgets", version: "1" },
    paths: { "/widgets": { get: {
      operationId: "listWidgets",
      responses: { "200": { description: "ok", content: { "application/json": {
        schema: { type: "array", items: { type: "string", maxLength: 32 } },
      } } } },
    } } },
  });
  const requests: Parameters<OpenApiProviderControls["transport"]["request"]>[0][] = [];
  const adapter = createConfiguredOpenApiAnalysisAdapter({
    PAGE2WEBMCP_PROVIDER_MODE: "openapi",
    PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN: "https://deployment-default.invalid",
    PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL: "https://deployment-default.invalid/test",
    PAGE2WEBMCP_OPENAPI_ENVIRONMENT: "production",
  }, {
    resolver: { resolve: async () => ["93.184.216.34"] },
    transport: { request: async (request) => { requests.push(request); return sourceResponse(request.url, source); } },
  });
  const result = await adapter({
    sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi", targetOrigin: "https://run-context.example",
      testPageUrl: "https://run-context.example/review", environment: "staging",
    },
  }, new AbortController().signal);
  assert.equal(result.release?.allowedOrigin, "https://run-context.example");
  assert.deepEqual(JSON.parse(result.evidence[0]!.content), {
    adapter: "bounded-openapi",
    adapterVersion: 1,
    environment: "staging",
    openApiVersion: "3.1.0",
    sourceDigest: `urn:sha256:${createHash("sha256").update(source).digest("hex")}`,
    targetOrigin: "https://run-context.example",
    testPageUrl: "https://run-context.example/review",
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.headers, {
    accept: "application/json, application/openapi+json, application/yaml, application/x-yaml, text/yaml",
  });
  assert.equal("cookie" in requests[0]!.headers, false);
  assert.equal("authorization" in requests[0]!.headers, false);
});
