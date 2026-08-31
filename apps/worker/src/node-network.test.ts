import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import type { LookupAddress } from "node:dns";
import type { RequestOptions } from "node:https";
import {
  createNodeOpenApiResolver,
  createNodeOpenApiTransport,
  createNodePinnedJsonTransport,
  type NodeHttpsRequest,
} from "./node-network.ts";

function dnsError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

test("Node DNS resolves bounded A and AAAA answers and cancels both queries on abort", async () => {
  let cancelCalls = 0;
  const resolver = createNodeOpenApiResolver({
    createResolver: () => ({
      resolve4: async (hostname: string) => {
        assert.equal(hostname, "specs.widgets.example");
        return ["93.184.216.34"];
      },
      resolve6: async () => ["2606:2800:220:1:248:1893:25c8:1946"],
      cancel: () => { cancelCalls += 1; },
    }),
  });
  assert.deepEqual(await resolver.resolve("specs.widgets.example", new AbortController().signal), [
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946",
  ]);

  let release!: () => void;
  const stalled = createNodeOpenApiResolver({
    createResolver: () => ({
      resolve4: async () => new Promise<string[]>((resolve) => { release = () => resolve([]); }),
      resolve6: async () => new Promise<string[]>(() => undefined),
      cancel: () => { cancelCalls += 1; release(); },
    }),
  });
  const controller = new AbortController();
  const pending = stalled.resolve("specs.widgets.example", controller.signal);
  controller.abort(new Error("OPENAPI_FETCH_ABORTED"));
  await assert.rejects(pending, /^Error: OPENAPI_FETCH_ABORTED$/);
  assert.equal(cancelCalls, 1);
});

test("Node DNS bounds excessive answers and maps resolver failures without leaking hostnames", async () => {
  const excessive = createNodeOpenApiResolver({
    createResolver: () => ({
      resolve4: async () => Array.from({ length: 40 }, (_, index) => `8.8.8.${index}`),
      resolve6: async () => [],
      cancel: () => undefined,
    }),
  });
  assert.equal((await excessive.resolve("specs.widgets.example", new AbortController().signal)).length, 17);

  const failed = createNodeOpenApiResolver({
    createResolver: () => ({
      resolve4: async () => { throw new Error("getaddrinfo ENOTFOUND secret.internal"); },
      resolve6: async () => { throw new Error("queryAaaa EAI_AGAIN secret.internal"); },
      cancel: () => undefined,
    }),
  });
  await assert.rejects(
    failed.resolve("secret.internal", new AbortController().signal),
    (error: unknown) => error instanceof Error && error.message === "OPENAPI_DNS_RESOLUTION_FAILED",
  );
});

test("Node DNS accepts A-only and AAAA-only hosts when the other family has no records", async () => {
  for (const [ipv4, ipv6, expected] of [
    [["93.184.216.34"], dnsError("ENODATA"), ["93.184.216.34"]],
    [dnsError("ENOTFOUND"), ["2606:2800:220:1:248:1893:25c8:1946"], ["2606:2800:220:1:248:1893:25c8:1946"]],
  ] as const) {
    const resolver = createNodeOpenApiResolver({
      createResolver: () => ({
        resolve4: async () => { if (ipv4 instanceof Error) throw ipv4; return ipv4; },
        resolve6: async () => { if (ipv6 instanceof Error) throw ipv6; return ipv6; },
        cancel: () => undefined,
      }),
    });
    assert.deepEqual(await resolver.resolve("specs.widgets.example", new AbortController().signal), expected);
  }
});

test("Node DNS returns an empty answer set only when both families have no records", async () => {
  const noRecords = createNodeOpenApiResolver({
    createResolver: () => ({
      resolve4: async () => { throw dnsError("ENODATA"); },
      resolve6: async () => { throw dnsError("ENOTFOUND"); },
      cancel: () => undefined,
    }),
  });
  assert.deepEqual(await noRecords.resolve("missing.example", new AbortController().signal), []);

  const partialFailure = createNodeOpenApiResolver({
    createResolver: () => ({
      resolve4: async () => { throw dnsError("EAI_AGAIN"); },
      resolve6: async () => [],
      cancel: () => undefined,
    }),
  });
  await assert.rejects(partialFailure.resolve("unstable.example", new AbortController().signal), /^Error: OPENAPI_DNS_RESOLUTION_FAILED$/);
});

test("Node DNS closes the abort-listener race during resolver construction", async () => {
  const controller = new AbortController();
  let cancelCalls = 0;
  const resolver = createNodeOpenApiResolver({
    createResolver: () => {
      controller.abort(new Error("OPENAPI_FETCH_ABORTED"));
      return {
        resolve4: async () => ["93.184.216.34"],
        resolve6: async () => [],
        cancel: () => { cancelCalls += 1; },
      };
    },
  });
  await assert.rejects(resolver.resolve("specs.widgets.example", controller.signal), /^Error: OPENAPI_FETCH_ABORTED$/);
  assert.equal(cancelCalls, 1);
});

type FakeResponseOptions = Readonly<{
  remoteAddress?: string;
  authorized?: boolean;
  servername?: string;
  protocol?: string | null;
}>;

function fakeHttpsBoundary(options: FakeResponseOptions = {}) {
  let capturedOptions: RequestOptions | undefined;
  let destroyedWith: Error | undefined;
  const request: NodeHttpsRequest = (_url, actualOptions, onResponse) => {
    capturedOptions = actualOptions;
    const client = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    client.end = () => queueMicrotask(() => {
      const response = Readable.from([Buffer.from("{}")]) as Readable & {
        statusCode?: number;
        headers: Record<string, string>;
        socket: unknown;
      };
      response.statusCode = 200;
      response.headers = { "content-type": "application/json" };
      response.socket = {
        remoteAddress: options.remoteAddress ?? "93.184.216.34",
        authorized: options.authorized ?? true,
        servername: options.servername ?? "specs.widgets.example",
        getProtocol: () => options.protocol === undefined ? "TLSv1.3" : options.protocol,
      };
      onResponse(response as never);
    });
    client.destroy = (error?: Error) => { destroyedWith = error; client.emit("error", error); };
    return client as never;
  };
  return {
    request,
    capturedOptions: () => capturedOptions,
    destroyedWith: () => destroyedWith,
  };
}

test("Node HTTPS retains requested-host SNI, pins lookup, and sends only fixed GET/Accept", async () => {
  const boundary = fakeHttpsBoundary();
  const transport = createNodeOpenApiTransport({ request: boundary.request });
  const result = await transport.request({
    url: "https://specs.widgets.example/openapi.json",
    method: "GET",
    headers: { accept: "application/json" },
    pinnedAddresses: ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    redirect: "manual",
    credentials: "omit",
    signal: new AbortController().signal,
  });
  const options = boundary.capturedOptions();
  assert.equal(options?.method, "GET");
  assert.deepEqual(options?.headers, { accept: "application/json" });
  assert.equal(options?.servername, "specs.widgets.example");
  assert.equal(options?.rejectUnauthorized, true);
  assert.equal(options?.minVersion, "TLSv1.2");
  assert.equal(options?.agent, false);
  assert.equal("auth" in (options ?? {}), false);
  assert.equal("cookie" in ((options?.headers ?? {}) as object), false);
  assert.equal("authorization" in ((options?.headers ?? {}) as object), false);
  const lookup = options?.lookup;
  assert.equal(typeof lookup, "function");
  const addresses = await new Promise<readonly LookupAddress[]>((resolve, reject) => {
    lookup?.("specs.widgets.example", { all: true }, (error, values) => error ? reject(error) : resolve(values as LookupAddress[]));
  });
  assert.deepEqual(addresses, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  assert.equal(result.connectedAddress, "93.184.216.34");
  assert.deepEqual(result.tls, { authorized: true, servername: "specs.widgets.example", protocol: "TLSv1.3" });
  assert.equal(result.url, "https://specs.widgets.example/openapi.json");
});

test("Node HTTPS rejects peer/TLS mismatches with stable errors", async () => {
  const cases: Array<readonly [FakeResponseOptions, string]> = [
    [{ remoteAddress: "8.8.8.8" }, "OPENAPI_DNS_REBINDING_BLOCKED"],
    [{ remoteAddress: "127.0.0.1" }, "OPENAPI_DNS_REBINDING_BLOCKED"],
    [{ authorized: false }, "OPENAPI_TLS_VERIFICATION_FAILED"],
    [{ servername: "attacker.example" }, "OPENAPI_TLS_VERIFICATION_FAILED"],
    [{ protocol: "TLSv1.1" }, "OPENAPI_TLS_VERIFICATION_FAILED"],
  ];
  for (const [connection, code] of cases) {
    const boundary = fakeHttpsBoundary(connection);
    const transport = createNodeOpenApiTransport({ request: boundary.request });
    await assert.rejects(transport.request({
      url: "https://specs.widgets.example/openapi.json",
      method: "GET",
      headers: { accept: "application/json" },
      pinnedAddresses: ["93.184.216.34"],
      redirect: "manual",
      credentials: "omit",
      signal: new AbortController().signal,
    }), new RegExp(`^Error: ${code}$`));
    assert.equal(boundary.destroyedWith()?.message, code);
  }
});

test("Node HTTPS canonicalizes a public IPv4-mapped peer before enforcing the pin", async () => {
  const boundary = fakeHttpsBoundary({ remoteAddress: "::ffff:93.184.216.34" });
  const result = await createNodeOpenApiTransport({ request: boundary.request }).request({
    url: "https://specs.widgets.example/openapi.json",
    method: "GET",
    headers: { accept: "application/json" },
    pinnedAddresses: ["93.184.216.34"],
    redirect: "manual",
    credentials: "omit",
    signal: new AbortController().signal,
  });
  assert.equal(result.connectedAddress, "93.184.216.34");
});

test("Node HTTPS destroys an in-flight request when the caller aborts", async () => {
  let destroyedWith: Error | undefined;
  const request: NodeHttpsRequest = () => {
    const client = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    client.end = () => undefined;
    client.destroy = (error?: Error) => { destroyedWith = error; client.emit("error", error); };
    return client as never;
  };
  const controller = new AbortController();
  const pending = createNodeOpenApiTransport({ request }).request({
    url: "https://specs.widgets.example/openapi.json",
    method: "GET",
    headers: { accept: "application/json" },
    pinnedAddresses: ["93.184.216.34"],
    redirect: "manual",
    credentials: "omit",
    signal: controller.signal,
  });
  controller.abort(new Error("OPENAPI_FETCH_TIMEOUT"));
  await assert.rejects(pending, /^Error: OPENAPI_FETCH_TIMEOUT$/);
  assert.equal(destroyedWith?.message, "OPENAPI_FETCH_TIMEOUT");
});

test("Node HTTPS closes the response and socket when aborting a stalled post-header body", async () => {
  let requestDestroyed = false;
  let responseDestroyed = false;
  let socketDestroyed = false;
  const request: NodeHttpsRequest = (_url, _options, onResponse) => {
    const client = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    client.end = () => queueMicrotask(() => {
      const response = new Readable({ read() { /* body remains stalled */ } }) as Readable & {
        statusCode?: number;
        headers: Record<string, string>;
        socket: unknown;
      };
      response.statusCode = 200;
      response.headers = { "content-type": "application/json" };
      response.on("error", () => undefined);
      const originalDestroy = response.destroy.bind(response);
      response.destroy = (error?: Error) => { responseDestroyed = true; return originalDestroy(error); };
      response.socket = {
        remoteAddress: "93.184.216.34", authorized: true, servername: "specs.widgets.example",
        getProtocol: () => "TLSv1.3",
        destroy: () => { socketDestroyed = true; },
      };
      onResponse(response as never);
    });
    client.destroy = () => { requestDestroyed = true; };
    return client as never;
  };
  const controller = new AbortController();
  await createNodeOpenApiTransport({ request }).request({
    url: "https://specs.widgets.example/openapi.json",
    method: "GET",
    headers: { accept: "application/json" },
    pinnedAddresses: ["93.184.216.34"], redirect: "manual", credentials: "omit", signal: controller.signal,
  });
  controller.abort(new Error("OPENAPI_FETCH_TIMEOUT"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestDestroyed, true);
  assert.equal(responseDestroyed, true);
  assert.equal(socketDestroyed, true);
});

test("Node HTTPS closes the construction abort-listener race before sending the request", async () => {
  const controller = new AbortController();
  let ended = false;
  let destroyed = false;
  const request: NodeHttpsRequest = () => {
    controller.abort(new Error("OPENAPI_FETCH_ABORTED"));
    const client = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    client.end = () => { ended = true; queueMicrotask(() => client.emit("error", new Error("raw abort race"))); };
    client.destroy = () => { destroyed = true; };
    return client as never;
  };
  const pending = createNodeOpenApiTransport({ request }).request({
    url: "https://specs.widgets.example/openapi.json",
    method: "GET", headers: { accept: "application/json" }, pinnedAddresses: ["93.184.216.34"],
    redirect: "manual", credentials: "omit", signal: controller.signal,
  });
  await assert.rejects(pending, /^Error: OPENAPI_FETCH_ABORTED$/);
  assert.equal(destroyed, true);
  assert.equal(ended, false);
});

test("pinned JSON transport rejects private DNS before credential-bearing HTTPS construction", async () => {
  let requestCalls = 0;
  const transport = createNodePinnedJsonTransport({
    resolver: {
      resolve: async (hostname: string) => {
        assert.equal(hostname, "127.0.0.1.nip.io");
        return ["127.0.0.1", "::1"];
      },
    },
    request: () => {
      requestCalls += 1;
      throw new Error("CREDENTIAL_TRANSPORT_MUST_NOT_START");
    },
  });
  await assert.rejects(transport.request({
    url: "https://127.0.0.1.nip.io/v1/control",
    method: "POST",
    headers: { authorization: "Bearer secret-control-token", "content-type": "application/json" },
    body: "{}",
    signal: new AbortController().signal,
  }), /^Error: WEBSITE_CONTROL_HOST_BLOCKED$/);
  assert.equal(requestCalls, 0);
});

test("pinned JSON transport writes credentials only after pinned TLS peer verification", async () => {
  let sentBody: string | undefined;
  let capturedOptions: RequestOptions | undefined;
  const request: NodeHttpsRequest = (_url, options, onResponse) => {
    capturedOptions = options;
    const client = new EventEmitter() as EventEmitter & { end(body?: string): void; destroy(error?: Error): void };
    const socket = new EventEmitter() as EventEmitter & {
      remoteAddress: string; authorized: boolean; servername: string;
      getProtocol(): string; destroy(error?: Error): void;
    };
    Object.assign(socket, {
      remoteAddress: "93.184.216.34",
      authorized: true,
      servername: "control.widgets.example",
      getProtocol: () => "TLSv1.3",
      destroy: () => undefined,
    });
    client.end = (body?: string) => {
      sentBody = body;
      const response = Readable.from([Buffer.from('{"ok":true}')]) as Readable & {
        statusCode?: number; headers: Record<string, string>; socket: unknown;
      };
      response.statusCode = 200;
      response.headers = { "content-type": "application/json" };
      response.socket = socket;
      onResponse(response as never);
    };
    client.destroy = (error?: Error) => { if (error) client.emit("error", error); };
    queueMicrotask(() => {
      client.emit("socket", socket);
      assert.equal(sentBody, undefined);
      socket.emit("secureConnect");
    });
    return client as never;
  };
  const response = await createNodePinnedJsonTransport({
    resolver: { resolve: async () => ["93.184.216.34"] },
    request,
  }).request({
    url: "https://control.widgets.example/v1/control",
    method: "POST",
    headers: { authorization: "Bearer secret-control-token", "content-type": "application/json" },
    body: '{"operation":"test"}',
    signal: new AbortController().signal,
  });
  assert.equal(sentBody, '{"operation":"test"}');
  assert.equal(capturedOptions?.servername, "control.widgets.example");
  assert.equal(capturedOptions?.rejectUnauthorized, true);
  assert.equal(capturedOptions?.minVersion, "TLSv1.2");
  assert.equal(capturedOptions?.agent, false);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(response.body)), { ok: true });
});

test("pinned JSON transport does not write credentials to an unpinned actual peer", async () => {
  let endCalls = 0;
  const request: NodeHttpsRequest = () => {
    const client = new EventEmitter() as EventEmitter & { end(body?: string): void; destroy(error?: Error): void };
    const socket = new EventEmitter() as EventEmitter & {
      remoteAddress: string; authorized: boolean; servername: string;
      getProtocol(): string; destroy(error?: Error): void;
    };
    Object.assign(socket, {
      remoteAddress: "8.8.8.8",
      authorized: true,
      servername: "control.widgets.example",
      getProtocol: () => "TLSv1.3",
      destroy: () => undefined,
    });
    client.end = () => { endCalls += 1; };
    client.destroy = (error?: Error) => { if (error) queueMicrotask(() => client.emit("error", error)); };
    queueMicrotask(() => {
      client.emit("socket", socket);
      socket.emit("secureConnect");
    });
    return client as never;
  };
  await assert.rejects(createNodePinnedJsonTransport({
    resolver: { resolve: async () => ["93.184.216.34"] }, request,
  }).request({
    url: "https://control.widgets.example/v1/control",
    method: "POST",
    headers: { authorization: "Bearer secret-control-token", "content-type": "application/json" },
    body: "{}",
    signal: new AbortController().signal,
  }), /^Error: WEBSITE_CONTROL_HOST_BLOCKED$/);
  assert.equal(endCalls, 0);
});
