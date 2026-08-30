import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  fetchOpenApiSource,
  loadPrivateOpenApiUpload,
  type OpenApiFetchResponse,
  type OpenApiProviderControls,
} from "./openapi.ts";

function body(...chunks: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield new TextEncoder().encode(chunk);
    },
  };
}

function response(status: number, url: string, headers: Record<string, string>, ...chunks: string[]): OpenApiFetchResponse {
  return { status, url, headers, body: body(...chunks) };
}

test("fetches bounded OpenAPI bytes through pinned public DNS and same-origin manual redirects", async () => {
  const requests: Parameters<OpenApiProviderControls["transport"]["request"]>[0][] = [];
  const source = '{"openapi":"3.1.0","paths":{}}';
  const controls: OpenApiProviderControls = {
    resolver: { resolve: async (hostname) => {
      assert.equal(hostname, "specs.widgets.example");
      return ["93.184.216.34"];
    } },
    transport: { request: async (request) => {
      requests.push(request);
      return requests.length === 1
        ? response(302, request.url, { location: "/canonical/openapi.json" })
        : response(200, request.url, { "content-type": "application/json; charset=utf-8" }, source.slice(0, 10), source.slice(10));
    } },
    timeoutMs: 1_000,
    maxBytes: 1_000,
    maxRedirects: 2,
  };
  const fetched = await fetchOpenApiSource("https://specs.widgets.example/openapi.json", controls);
  assert.deepEqual(requests.map(({ url, pinnedAddresses, redirect, credentials }) => ({ url, pinnedAddresses, redirect, credentials })), [
    { url: "https://specs.widgets.example/openapi.json", pinnedAddresses: ["93.184.216.34"], redirect: "manual", credentials: "omit" },
    { url: "https://specs.widgets.example/canonical/openapi.json", pinnedAddresses: ["93.184.216.34"], redirect: "manual", credentials: "omit" },
  ]);
  assert.deepEqual(fetched, {
    source,
    format: "json",
    finalUrl: "https://specs.widgets.example/canonical/openapi.json",
    contentType: "application/json",
    evidenceReference: `urn:sha256:${createHash("sha256").update(source).digest("hex")}`,
  });
});

test("blocks private DNS, cross-origin and hidden redirects before consuming a document", async () => {
  let calls = 0;
  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["127.0.0.1"] },
    transport: { request: async () => { calls += 1; throw new Error("must not run"); } },
  }), /^Error: OPENAPI_SSRF_BLOCKED$/);
  assert.equal(calls, 0);

  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json?api_key=secret", {
    resolver: { resolve: async () => ["93.184.216.34"] },
    transport: { request: async () => { calls += 1; throw new Error("must not run"); } },
  }), /^Error: OPENAPI_URL_BLOCKED$/);
  assert.equal(calls, 0);

  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["2001:db8::1"] },
    transport: { request: async () => { calls += 1; throw new Error("must not run"); } },
  }), /^Error: OPENAPI_SSRF_BLOCKED$/);
  assert.equal(calls, 0);

  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["93.184.216.34"] },
    transport: { request: async (request) => response(302, request.url, { location: "https://attacker.example/spec.json" }) },
  }), /^Error: OPENAPI_REDIRECT_ORIGIN_BLOCKED$/);

  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["93.184.216.34"] },
    transport: { request: async () => response(200, "https://attacker.example/hidden", { "content-type": "application/json" }, "{}") },
  }), /^Error: OPENAPI_TRANSPORT_POLICY_VIOLATION$/);
});

test("enforces content type, streaming byte cap, redirect cap, and total deadline", async () => {
  const base = {
    resolver: { resolve: async () => ["93.184.216.34"] },
  };
  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    ...base,
    transport: { request: async (request) => response(200, request.url, { "content-type": "text/html" }, "<html></html>") },
  }), /^Error: OPENAPI_CONTENT_TYPE_BLOCKED$/);
  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    ...base,
    maxBytes: 4,
    transport: { request: async (request) => response(200, request.url, { "content-type": "application/yaml" }, "123", "45") },
  }), /^Error: OPENAPI_RESPONSE_TOO_LARGE$/);
  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    ...base,
    maxRedirects: 0,
    transport: { request: async (request) => response(302, request.url, { location: "/again" }) },
  }), /^Error: OPENAPI_REDIRECT_LIMIT_EXCEEDED$/);
  let aborted = false;
  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    ...base,
    timeoutMs: 10,
    transport: { request: async ({ signal }) => new Promise<OpenApiFetchResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    }) },
  }), /^Error: OPENAPI_FETCH_TIMEOUT$/);
  assert.equal(aborted, true);
});

test("caller cancellation rejects promptly even when a transport ignores its signal", async () => {
  const controller = new AbortController();
  const pending = fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["93.184.216.34"] },
    timeoutMs: 100,
    signal: controller.signal,
    transport: { request: async () => new Promise<OpenApiFetchResponse>(() => undefined) },
  });
  controller.abort(new Error("caller detail must not escape"));
  await assert.rejects(pending, /^Error: OPENAPI_FETCH_ABORTED$/);
});

test("private upload abstraction accepts only bounded JSON/YAML bytes and hashes exact bytes", () => {
  const bytes = new TextEncoder().encode("openapi: 3.2.0\npaths: {}\n");
  assert.deepEqual(loadPrivateOpenApiUpload(bytes, "application/yaml"), {
    source: "openapi: 3.2.0\npaths: {}\n",
    format: "yaml",
    contentType: "application/yaml",
    evidenceReference: `urn:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
  assert.throws(() => loadPrivateOpenApiUpload(bytes, "text/plain"), /^Error: OPENAPI_CONTENT_TYPE_BLOCKED$/);
  assert.throws(() => loadPrivateOpenApiUpload(new Uint8Array(1_000_001), "application/json"), /^Error: OPENAPI_RESPONSE_TOO_LARGE$/);
  assert.throws(() => loadPrivateOpenApiUpload(Uint8Array.from([0xff]), "application/json"), /^Error: OPENAPI_INVALID_UTF8$/);
});
