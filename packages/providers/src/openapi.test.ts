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

function response(
  status: number,
  url: string,
  headers: Record<string, string>,
  chunks: string[] = [],
  connection: Pick<OpenApiFetchResponse, "connectedAddress" | "tls"> = {
    connectedAddress: "93.184.216.34",
    tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
  },
): OpenApiFetchResponse {
  return { status, url, headers, body: body(...chunks), ...connection };
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
        : response(200, request.url, { "content-type": "application/json; charset=utf-8" }, [source.slice(0, 10), source.slice(10)]);
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
    transport: { request: async () => response(200, "https://attacker.example/hidden", { "content-type": "application/json" }, ["{}"]) },
  }), /^Error: OPENAPI_TRANSPORT_POLICY_VIOLATION$/);
});

test("rejects empty, malformed, excessive, mixed, private, reserved, and metadata DNS answers", async () => {
  const blockedAnswers: readonly (readonly string[])[] = [
    [],
    ["not-an-address"],
    Array.from({ length: 17 }, () => "8.8.8.8"),
    ["8.8.8.8", "10.0.0.1"],
    ["0.0.0.1"], ["10.0.0.1"], ["100.64.0.1"], ["127.0.0.1"], ["169.254.169.254"],
    ["172.16.0.1"], ["192.168.0.1"], ["192.0.2.1"], ["192.88.99.1"], ["198.18.0.1"],
    ["198.51.100.1"], ["203.0.113.1"], ["224.0.0.1"], ["240.0.0.1"],
    ["::"], ["::1"], ["fc00::1"], ["fe80::1"], ["ff02::1"], ["2001:db8::1"],
    ["2002::1"], ["2001::1"], ["2001:10::1"], ["::ffff:7f00:1"],
  ];
  for (const addresses of blockedAnswers) {
    let transportCalls = 0;
    await assert.rejects(fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
      resolver: { resolve: async () => addresses },
      transport: { request: async () => { transportCalls += 1; throw new Error("must not run"); } },
    }), /^Error: OPENAPI_SSRF_BLOCKED$/);
    assert.equal(transportCalls, 0);
  }
});

test("rejects actual-peer rebinding and invalid TLS attestation before consuming a response", async () => {
  const base = { resolver: { resolve: async () => ["93.184.216.34"] } };
  const variants: Array<readonly [Pick<OpenApiFetchResponse, "connectedAddress" | "tls">, RegExp]> = [
    [{ connectedAddress: "8.8.8.8", tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" } }, /^Error: OPENAPI_DNS_REBINDING_BLOCKED$/],
    [{ connectedAddress: "127.0.0.1", tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" } }, /^Error: OPENAPI_DNS_REBINDING_BLOCKED$/],
    [{ connectedAddress: "93.184.216.34", tls: { authorized: false, servername: "specs.widgets.example", protocol: "TLSv1.3" } }, /^Error: OPENAPI_TLS_VERIFICATION_FAILED$/],
    [{ connectedAddress: "93.184.216.34", tls: { authorized: true, servername: "attacker.example", protocol: "TLSv1.3" } }, /^Error: OPENAPI_TLS_VERIFICATION_FAILED$/],
    [{ connectedAddress: "93.184.216.34", tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.1" } }, /^Error: OPENAPI_TLS_VERIFICATION_FAILED$/],
  ];
  for (const [connection, expected] of variants) {
    let bodyStarted = false;
    await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
      ...base,
      transport: { request: async (request) => ({
        ...response(200, request.url, { "content-type": "application/json" }, [], connection),
        body: { async *[Symbol.asyncIterator]() { bodyStarted = true; yield new TextEncoder().encode("{}"); } },
      }) },
    }), expected);
    assert.equal(bodyStarted, false);
  }
});

test("maps malformed connection metadata to stable policy errors without raw type failures", async () => {
  await assert.rejects(fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["93.184.216.34"] },
    transport: { request: async (request) => ({
      ...response(200, request.url, { "content-type": "application/json" }, ["{}"]),
      connectedAddress: undefined,
    } as unknown as OpenApiFetchResponse) },
  }), /^Error: OPENAPI_TRANSPORT_POLICY_VIOLATION$/);
});

test("accepts a socket peer that is the canonical equivalent of a pinned public IPv6 address", async () => {
  const fetched = await fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["2606:2800:0220:0001:0248:1893:25c8:1946"] },
    transport: { request: async (request) => response(
      200,
      request.url,
      { "content-type": "application/json" },
      ["{}"],
      {
        connectedAddress: "2606:2800:220:1:248:1893:25c8:1946",
        tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
      },
    ) },
  });
  assert.equal(fetched.source, "{}");
});

test("accepts IPv4-mapped socket notation only when its public IPv4 is pinned", async () => {
  const fetched = await fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    resolver: { resolve: async () => ["93.184.216.34"] },
    transport: { request: async (request) => response(
      200,
      request.url,
      { "content-type": "application/json" },
      ["{}"],
      {
        connectedAddress: "::ffff:93.184.216.34",
        tls: { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" },
      },
    ) },
  });
  assert.equal(fetched.source, "{}");
});

test("does not start HTTPS when cancellation lands after an uncooperative DNS lookup", async () => {
  let release!: (addresses: readonly string[]) => void;
  let transportCalls = 0;
  const controller = new AbortController();
  const pending = fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    signal: controller.signal,
    resolver: { resolve: async () => new Promise((resolve) => { release = resolve; }) },
    transport: { request: async () => { transportCalls += 1; throw new Error("must not run"); } },
  });
  controller.abort();
  release(["93.184.216.34"]);
  await assert.rejects(pending, /^Error: OPENAPI_FETCH_ABORTED$/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportCalls, 0);
});

test("enforces content type, streaming byte cap, redirect cap, and total deadline", async () => {
  const base = {
    resolver: { resolve: async () => ["93.184.216.34"] },
  };
  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    ...base,
    transport: { request: async (request) => response(200, request.url, { "content-type": "text/html" }, ["<html></html>"]) },
  }), /^Error: OPENAPI_CONTENT_TYPE_BLOCKED$/);
  await assert.rejects(() => fetchOpenApiSource("https://specs.widgets.example/openapi.json", {
    ...base,
    maxBytes: 4,
    transport: { request: async (request) => response(200, request.url, { "content-type": "application/yaml" }, ["123", "45"]) },
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
