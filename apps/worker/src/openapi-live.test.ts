import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createConfiguredOpenApiAnalysisAdapter,
  createConfiguredOpenApiProductionAdapter,
} from "./openapi-live.ts";
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

function frozenSource(source: string, overrides: Partial<{
  contentHash: string;
  artifactReference: string;
  finalUrl: string;
  mimeType: string;
  sizeBytes: number;
}> = {}) {
  const contentHash = createHash("sha256").update(source, "utf8").digest("hex");
  return {
    contentHash,
    artifactReference: `urn:sha256:${contentHash}`,
    finalUrl: "https://specs.widgets.example/openapi.json",
    mimeType: "application/json",
    sizeBytes: Buffer.byteLength(source, "utf8"),
    ...overrides,
  };
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

test("OpenAPI readiness freshly exercises bounded DNS and HTTPS against the selected release source", async () => {
  const requests: Parameters<OpenApiProviderControls["transport"]["request"]>[0][] = [];
  const source = JSON.stringify({ openapi: "3.1.0", info: { title: "Widgets", version: "1" }, paths: {} });
  const provider = createConfiguredOpenApiProductionAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    {
      resolver: { resolve: async (hostname) => {
        assert.equal(hostname, "specs.widgets.example");
        return ["93.184.216.34"];
      } },
      transport: { request: async (request) => {
        requests.push(request);
        return {
          status: 200,
          url: request.url,
          connectedAddress: "93.184.216.34",
          tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
          headers: { "content-type": "application/json" },
          body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
        };
      } },
    },
  );
  await provider.probe({
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    context: {
      sourceType: "openapi",
      sourceUrl: "https://specs.widgets.example/openapi.json",
      sourceIdentityHash: "b".repeat(64),
      sourceArtifact: frozenSource(source),
      sourceConfiguration: {
        kind: "openapi",
        targetOrigin: "https://widgets.example",
        testPageUrl: "https://widgets.example/webmcp-test",
        environment: "production",
      },
    },
    signal: new AbortController().signal,
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    url: "https://specs.widgets.example/openapi.json",
    method: "GET",
    headers: { accept: "application/json, application/openapi+json, application/yaml, application/x-yaml, text/yaml" },
    pinnedAddresses: ["93.184.216.34"],
    redirect: "manual",
    credentials: "omit",
    signal: requests[0]!.signal,
  });
});

test("OpenAPI readiness accepts an unchanged document through the analysis byte ceiling", async () => {
  const source = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Large widgets", version: "1" },
    paths: {},
    description: "x".repeat(70_000),
  });
  const provider = createConfiguredOpenApiProductionAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async (request) => sourceResponse(request.url, source) },
    },
  );

  await provider.probe({
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    context: {
      sourceType: "openapi",
      sourceUrl: "https://specs.widgets.example/openapi.json",
      sourceIdentityHash: "b".repeat(64),
      sourceArtifact: frozenSource(source),
      sourceConfiguration: {
        kind: "openapi", targetOrigin: "https://widgets.example",
        testPageUrl: "https://widgets.example/review", environment: "staging",
      },
    },
    signal: new AbortController().signal,
  });
});

test("OpenAPI readiness follows the analysis redirect policy before comparing the frozen final URL", async () => {
  const source = JSON.stringify({ openapi: "3.1.0", info: { title: "Widgets", version: "1" }, paths: {} });
  const requested: string[] = [];
  const provider = createConfiguredOpenApiProductionAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async (request) => {
        requested.push(request.url);
        if (request.url === "https://specs.widgets.example/openapi.json") {
          return {
            status: 302,
            url: request.url,
            connectedAddress: "93.184.216.34",
            tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
            headers: { location: "/frozen/openapi.json" },
            body: { async *[Symbol.asyncIterator]() { /* empty redirect body */ } },
          } as const;
        }
        return sourceResponse(request.url, source);
      } },
    },
  );

  await provider.probe({
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    context: {
      sourceType: "openapi",
      sourceUrl: "https://specs.widgets.example/openapi.json",
      sourceIdentityHash: "b".repeat(64),
      sourceArtifact: frozenSource(source, {
        finalUrl: "https://specs.widgets.example/frozen/openapi.json",
      }),
      sourceConfiguration: {
        kind: "openapi", targetOrigin: "https://widgets.example",
        testPageUrl: "https://widgets.example/review", environment: "staging",
      },
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(requested, [
    "https://specs.widgets.example/openapi.json",
    "https://specs.widgets.example/frozen/openapi.json",
  ]);
});

test("OpenAPI readiness rejects drift in any frozen document identity field", async () => {
  const source = JSON.stringify({ openapi: "3.1.0", info: { title: "Widgets", version: "1" }, paths: {} });
  const unchanged = frozenSource(source);
  const changedHash = "f".repeat(64);
  const changes = [
    { ...unchanged, contentHash: changedHash, artifactReference: `urn:sha256:${changedHash}` },
    { ...unchanged, artifactReference: `urn:sha256:${"e".repeat(64)}` },
    { ...unchanged, finalUrl: "https://specs.widgets.example/changed.json" },
    { ...unchanged, mimeType: "application/yaml" },
    { ...unchanged, sizeBytes: unchanged.sizeBytes + 1 },
  ];
  const provider = createConfiguredOpenApiProductionAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async (request) => sourceResponse(request.url, source) },
    },
  );
  for (const sourceArtifact of changes) {
    await assert.rejects(provider.probe({
      selectedReleaseHash: "a".repeat(64),
      publicOrigin: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
      context: {
        sourceType: "openapi",
        sourceUrl: "https://specs.widgets.example/openapi.json",
        sourceIdentityHash: "b".repeat(64),
        sourceArtifact,
        sourceConfiguration: {
          kind: "openapi", targetOrigin: "https://widgets.example",
          testPageUrl: "https://widgets.example/review", environment: "staging",
        },
      },
      signal: new AbortController().signal,
    }), /^Error: OPENAPI_SOURCE_CHANGED_AFTER_FREEZE$/);
  }
});

test("OpenAPI readiness rejects a descriptor for a different provider before network access", async () => {
  let requested = false;
  const provider = createConfiguredOpenApiProductionAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    {
      resolver: { resolve: async () => { requested = true; return ["93.184.216.34"]; } },
      transport: { request: async () => { throw new Error("UNUSED"); } },
    },
  );
  await assert.rejects(provider.probe({
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    context: {
      sourceType: "website",
      sourceUrl: "https://widgets.example",
      sourceIdentityHash: "b".repeat(64),
      sourceConfiguration: { kind: "website" },
    },
    signal: new AbortController().signal,
  }), /^Error: OPENAPI_PROVIDER_PROBE_FAILED$/);
  assert.equal(requested, false);
});

test("OpenAPI readiness redacts an unreachable or rejected artifact transport", async () => {
  const provider = createConfiguredOpenApiProductionAdapter(
    { PAGE2WEBMCP_PROVIDER_MODE: "openapi" },
    {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async () => { throw new Error("upstream credential and host detail"); } },
    },
  );
  await assert.rejects(provider.probe({
    selectedReleaseHash: "a".repeat(64),
    publicOrigin: "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases",
    context: {
      sourceType: "openapi",
      sourceUrl: "https://specs.widgets.example/openapi.json",
      sourceIdentityHash: "b".repeat(64),
      sourceArtifact: frozenSource("unreachable"),
      sourceConfiguration: {
        kind: "openapi", targetOrigin: "https://widgets.example",
        testPageUrl: "https://widgets.example/review", environment: "staging",
      },
    },
    signal: new AbortController().signal,
  }), /^Error: OPENAPI_PROVIDER_PROBE_FAILED$/);
});
