import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createOpenApiAnalysisAdapter } from "./workflow.ts";

test("OpenAPI worker adapter binds exact source bytes to generic canonical plans without leaking examples", async () => {
  const secret = "sk-live-never-persist";
  const source = JSON.stringify({ openapi: "3.1.0", info: { title: "Widgets", version: "1" }, paths: { "/widgets/{id}": { get: {
    operationId: "LookupWidget",
    parameters: [{ in: "path", name: "id", required: true, example: secret, schema: { type: "string", maxLength: 32 } }],
    responses: { "200": { description: secret, content: { "application/json": {
      example: { token: secret },
      schema: { type: "object", required: ["id"], properties: { id: { type: "string", maxLength: 32 } } },
    } } } },
  } } } });
  const adapter = createOpenApiAnalysisAdapter({
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review/openapi",
    environment: "test",
    provider: {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async ({ url }) => ({
        status: 200,
        url,
        headers: { "content-type": "application/json" },
        body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
      }) },
    },
  });
  const result = await adapter({ sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json" }, new AbortController().signal);
  assert.equal(result.capabilities.length, 1);
  assert.equal(result.capabilities[0]!.plan.targetOrigin, "https://widgets.example");
  assert.equal(result.release.manifest && typeof result.release.manifest === "object", true);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.capabilities[0]!.plan.evidence[0]!.reference, result.evidence[0]!.reference);
  assert.deepEqual(JSON.parse(String(result.evidence[0]!.content)), {
    adapter: "bounded-openapi",
    adapterVersion: 1,
    environment: "test",
    openApiVersion: "3.1.0",
    sourceDigest: `urn:sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`,
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review/openapi",
  });
  assert.doesNotMatch(JSON.stringify(result), /sk-live|never-persist/i);
});

test("OpenAPI worker adapter fails closed for other source types or when no browser-safe plan exists", async () => {
  const source = JSON.stringify({ openapi: "3.1.0", info: { title: "Widgets", version: "1" }, paths: { "/admin": { delete: {
    responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "boolean" } } } } },
  } } } });
  const adapter = createOpenApiAnalysisAdapter({
    targetOrigin: "https://widgets.example",
    testPageUrl: "https://widgets.example/review/openapi",
    environment: "test",
    provider: {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async ({ url }) => ({
        status: 200,
        url,
        headers: { "content-type": "application/json" },
        body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(source); } },
      }) },
    },
  });
  await assert.rejects(() => adapter({ sourceType: "website", sourceUrl: "https://widgets.example" }, new AbortController().signal), /SOURCE_TYPE_UNSUPPORTED/);
  await assert.rejects(() => adapter({ sourceType: "openapi", sourceUrl: "https://specs.widgets.example/openapi.json" }, new AbortController().signal), /NO_BROWSER_SAFE_CAPABILITIES/);

  assert.throws(() => createOpenApiAnalysisAdapter({
    targetOrigin: "http://widgets.example",
    testPageUrl: "https://other.example/review/openapi",
    environment: "test",
    provider: {
      resolver: { resolve: async () => ["93.184.216.34"] },
      transport: { request: async () => { throw new Error("must not fetch"); } },
    },
  }), /OPENAPI_VERIFICATION_CONTEXT_REQUIRED/);
});
