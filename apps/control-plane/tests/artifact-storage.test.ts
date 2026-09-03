import assert from "node:assert/strict";
import { StorageApiError } from "@supabase/supabase-js";
import test from "node:test";
import {
  createConfiguredReleaseArtifactStore,
  type ReleaseArtifactClientFactory,
  type ReleaseArtifactStorageClient,
} from "../src/artifact-storage.ts";

const CODE = "export const widgets = true;\n";
const CONTENT_HASH = "6f0901af00f30388e07d943979ba73bea46effc8e6c1b1ad385f8889d3099225";
const INTEGRITY = "sha384-YmsCfxJaZ5VLqWgfoZRSpRyZb7wZQCLa10orEGxrKN/qSZ5ScDRDKVI8xaIO6EhF";
const TARGET_ORIGIN = "https://widgets.example";
const HOSTED_SERVER = "https://bimqgiedckdurqiywctl.supabase.co";
const HOSTED_PREFIX = `${HOSTED_SERVER}/storage/v1/object/public/page2webmcp-releases`;
const LOCAL_SERVER = "http://127.0.0.1:58321";
const LOCAL_PREFIX = `${LOCAL_SERVER}/storage/v1/object/public/page2webmcp-releases`;
const SECRET = "sb_secret_test-only-artifact-storage-key";
const ARTIFACT_URL = `${HOSTED_PREFIX}/${CONTENT_HASH}.js`;
const DOWNLOAD_URL = `${ARTIFACT_URL}?download=page2webmcp-${CONTENT_HASH}.js`;

type UploadResult = Awaited<ReturnType<ReturnType<ReleaseArtifactStorageClient["storage"]["from"]>["upload"]>>;
type UploadCall = Readonly<{ bucket: string; path: string; body: Uint8Array; options: unknown }>;
type ClientCall = Readonly<{ server: string; secret: string; options: Parameters<ReleaseArtifactClientFactory>[2] }>;

function exactResponse(
  url: string,
  body: BodyInit = CODE,
  options: Readonly<{
    status?: number;
    contentType?: string;
    disposition?: string;
    setCookie?: string;
    contentLength?: string;
    redirected?: boolean;
  }> = {},
): Response {
  const headers = new Headers({ "content-type": options.contentType ?? "application/javascript" });
  if (options.disposition) headers.set("content-disposition", options.disposition);
  if (options.setCookie) headers.set("set-cookie", options.setCookie);
  if (options.contentLength) headers.set("content-length", options.contentLength);
  const response = new Response(body, { status: options.status ?? 200, headers });
  Object.defineProperty(response, "url", { value: url });
  if (options.redirected) Object.defineProperty(response, "redirected", { value: true });
  return response;
}

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PAGE2WEBMCP_SUPABASE_URL: HOSTED_SERVER,
    PAGE2WEBMCP_SUPABASE_SECRET_KEY: SECRET,
    PAGE2WEBMCP_PUBLIC_ORIGIN: HOSTED_PREFIX,
    ...overrides,
  };
}

function input(overrides: Partial<{ code: string; contentHash: string; integrity: string; targetOrigin: string }> = {}) {
  return { code: CODE, contentHash: CONTENT_HASH, integrity: INTEGRITY, targetOrigin: TARGET_ORIGIN, ...overrides };
}

function harness(options: Readonly<{
  environment?: Record<string, string | undefined>;
  uploadResult?: UploadResult | (() => Promise<UploadResult>);
  responses?: readonly (Response | Error | (() => Promise<Response>))[];
  deadlineMs?: number;
}> = {}) {
  const uploadCalls: UploadCall[] = [];
  const clientCalls: ClientCall[] = [];
  const fetchCalls: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
  const responseQueue = [...(options.responses ?? [
    exactResponse(ARTIFACT_URL),
    exactResponse(DOWNLOAD_URL, CODE, {
      disposition: `attachment; filename="page2webmcp-${CONTENT_HASH}.js"`,
    }),
  ])];
  const uploadResult = options.uploadResult ?? { data: { path: `${CONTENT_HASH}.js` }, error: null };
  const clientFactory: ReleaseArtifactClientFactory = (server, secret, clientOptions) => {
    clientCalls.push({ server, secret, options: clientOptions });
    return {
      storage: {
        from(bucket) {
          return {
            async upload(path, body, uploadOptions) {
              uploadCalls.push({ bucket, path, body: Buffer.from(body), options: uploadOptions });
              return typeof uploadResult === "function" ? await uploadResult() : uploadResult;
            },
          };
        },
      },
    };
  };
  const fetcher: typeof fetch = async (resource, init) => {
    const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
    fetchCalls.push({ url, init });
    const next = responseQueue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return await next();
    if (!next) throw new Error("unexpected fetch");
    return next;
  };
  return {
    store: createConfiguredReleaseArtifactStore(options.environment ?? environment(), {
      createClient: clientFactory,
      fetch: fetcher,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    }),
    uploadCalls,
    clientCalls,
    fetchCalls,
  };
}

test("publishes exact hosted bytes once and verifies both public identities", async () => {
  const fixture = harness();
  const published = await fixture.store.publish(input(), new AbortController().signal);

  assert.deepEqual(published, {
    artifactUrl: ARTIFACT_URL,
    downloadUrl: DOWNLOAD_URL,
    contentHash: CONTENT_HASH,
    integrity: INTEGRITY,
    localOnly: false,
  });
  assert.equal(fixture.clientCalls.length, 1);
  assert.equal(fixture.clientCalls[0]?.server, HOSTED_SERVER);
  assert.equal(fixture.clientCalls[0]?.secret, SECRET);
  assert.deepEqual(fixture.clientCalls[0]?.options.auth, {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  });
  assert.equal(typeof fixture.clientCalls[0]?.options.global.fetch, "function");
  assert.equal(fixture.uploadCalls.length, 1);
  assert.equal(fixture.uploadCalls[0]?.bucket, "page2webmcp-releases");
  assert.equal(fixture.uploadCalls[0]?.path, `${CONTENT_HASH}.js`);
  assert.deepEqual(fixture.uploadCalls[0]?.body, Buffer.from(CODE));
  assert.deepEqual(fixture.uploadCalls[0]?.options, {
    contentType: "application/javascript",
    cacheControl: "31536000",
    upsert: false,
  });
  assert.deepEqual(fixture.fetchCalls.map(({ url }) => url), [ARTIFACT_URL, DOWNLOAD_URL]);
  for (const call of fixture.fetchCalls) {
    assert.equal(call.init?.redirect, "error");
    assert.equal(call.init?.credentials, "omit");
    assert.equal(call.init?.cache, "no-store");
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test("marks only the exact Docker Storage topology local-only", async () => {
  const localArtifact = `${LOCAL_PREFIX}/${CONTENT_HASH}.js`;
  const localDownload = `${localArtifact}?download=page2webmcp-${CONTENT_HASH}.js`;
  const fixture = harness({
    environment: environment({
      PAGE2WEBMCP_LOCAL_STACK: "true",
      PAGE2WEBMCP_SUPABASE_URL: LOCAL_SERVER,
      PAGE2WEBMCP_PUBLIC_ORIGIN: LOCAL_PREFIX,
    }),
    responses: [
      exactResponse(localArtifact),
      exactResponse(localDownload, CODE, {
        disposition: `attachment; filename=page2webmcp-${CONTENT_HASH}.js`,
      }),
    ],
  });

  assert.deepEqual(await fixture.store.publish(input(), new AbortController().signal), {
    artifactUrl: localArtifact,
    downloadUrl: localDownload,
    contentHash: CONTENT_HASH,
    integrity: INTEGRITY,
    localOnly: true,
  });
});

test("rejects malformed candidate identity, size, and target before any I/O", async () => {
  const invalidInputs = [
    input({ code: "" }),
    input({ code: "x".repeat(65_537) }),
    input({ contentHash: "0".repeat(64) }),
    input({ contentHash: CONTENT_HASH.toUpperCase() }),
    input({ integrity: "sha384-invalid" }),
    input({ targetOrigin: "http://widgets.example" }),
    input({ targetOrigin: "https://widgets.example/path" }),
    input({ targetOrigin: "https://user@widgets.example" }),
  ];

  for (const candidate of invalidInputs) {
    const fixture = harness();
    await assert.rejects(
      fixture.store.publish(candidate, new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_INPUT_INVALID$/,
    );
    assert.equal(fixture.clientCalls.length, 0);
    assert.equal(fixture.uploadCalls.length, 0);
    assert.equal(fixture.fetchCalls.length, 0);
  }
});

test("rejects missing, aliased, browser-exposed, and mismatched Storage configuration", () => {
  const invalidEnvironments = [
    environment({ PAGE2WEBMCP_SUPABASE_URL: undefined }),
    environment({ PAGE2WEBMCP_SUPABASE_SECRET_KEY: undefined }),
    environment({ PAGE2WEBMCP_PUBLIC_ORIGIN: undefined }),
    environment({ PAGE2WEBMCP_SUPABASE_URL: `${HOSTED_SERVER}/` }),
    environment({ PAGE2WEBMCP_PUBLIC_ORIGIN: `${HOSTED_PREFIX}/` }),
    environment({ PAGE2WEBMCP_LOCAL_STACK: "true" }),
    environment({ PAGE2WEBMCP_SUPABASE_URL: LOCAL_SERVER }),
    environment({ PAGE2WEBMCP_LOCAL_STACK: "true", PAGE2WEBMCP_SUPABASE_URL: LOCAL_SERVER }),
    environment({ PAGE2WEBMCP_LOCAL_STACK: "true", PAGE2WEBMCP_PUBLIC_ORIGIN: LOCAL_PREFIX }),
    environment({
      PAGE2WEBMCP_LOCAL_STACK: "true",
      PAGE2WEBMCP_SUPABASE_URL: "http://127.0.0.1:54321",
      PAGE2WEBMCP_PUBLIC_ORIGIN: "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases",
    }),
    environment({
      PAGE2WEBMCP_LOCAL_STACK: "true",
      PAGE2WEBMCP_SUPABASE_URL: "http://localhost:58321",
      PAGE2WEBMCP_PUBLIC_ORIGIN: "http://localhost:58321/storage/v1/object/public/page2webmcp-releases",
    }),
    environment({ NEXT_PUBLIC_PAGE2WEBMCP_SUPABASE_URL: HOSTED_SERVER }),
    environment({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: SECRET }),
    environment({ PAGE2WEBMCP_SUPABASE_SERVICE_ROLE_KEY: SECRET }),
    environment({ SUPABASE_SECRET_KEY: SECRET }),
  ];
  for (const candidate of invalidEnvironments) {
    assert.throws(
      () => createConfiguredReleaseArtifactStore(candidate, {
        createClient: (() => { throw new Error("must not construct client"); }) as ReleaseArtifactClientFactory,
      }),
      /^Error: RELEASE_ARTIFACT_(?:CONFIGURATION_REQUIRED|SECRET_EXPOSURE_BLOCKED)$/,
    );
  }

  assert.doesNotThrow(() => createConfiguredReleaseArtifactStore(environment({
    NEXT_PUBLIC_SUPABASE_URL: "https://auth.example",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_browser-auth-only",
  }), {
    createClient: (() => { throw new Error("not called until publish"); }) as ReleaseArtifactClientFactory,
  }));
});

test("reconciles only pinned current and documented legacy typed object-exists errors", async () => {
  const accepted = [
    new StorageApiError("current", 409, "409", "storage", "ResourceAlreadyExists"),
    new StorageApiError("current", 400, "KeyAlreadyExists"),
    new StorageApiError("legacy", 400, "409"),
  ];
  for (const duplicate of accepted) {
    const fixture = harness({ uploadResult: { data: null, error: duplicate } });
    const published = await fixture.store.publish(input(), new AbortController().signal);
    assert.equal(published.contentHash, CONTENT_HASH);
    assert.equal(fixture.uploadCalls.length, 1);
    assert.equal(fixture.fetchCalls.length, 2);
  }
});

test("reconciles an ambiguous upload response loss only through both exact public byte identities", async () => {
  const responseLoss = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("socket closed after request body"), { code: "ECONNRESET" }),
  });
  const fixture = harness({
    uploadResult: async () => { throw responseLoss; },
  });

  const published = await fixture.store.publish(input(), new AbortController().signal);
  assert.equal(published.contentHash, CONTENT_HASH);
  assert.equal(fixture.uploadCalls.length, 1);
  assert.deepEqual(fixture.fetchCalls.map(({ url }) => url), [ARTIFACT_URL, DOWNLOAD_URL]);

  const mismatch = harness({
    uploadResult: async () => { throw responseLoss; },
    responses: [exactResponse(ARTIFACT_URL, "export const wrong = true;\n")],
  });
  await assert.rejects(
    mismatch.store.publish(input(), new AbortController().signal),
    /^Error: RELEASE_ARTIFACT_MISMATCH$/,
  );
});

test("reconciles the pinned Supabase SDK StorageUnknownError response-loss shape", async () => {
  const calls: string[] = [];
  const responseLoss = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("socket closed after durable upload"), { code: "UND_ERR_SOCKET" }),
  });
  const store = createConfiguredReleaseArtifactStore(environment(), {
    fetch: async (resource, init) => {
      const url = typeof resource === "string" ? resource : resource instanceof URL
        ? resource.toString() : resource.url;
      calls.push(url);
      if (init?.method === "POST") throw responseLoss;
      if (url === ARTIFACT_URL) return exactResponse(ARTIFACT_URL);
      if (url === DOWNLOAD_URL) return exactResponse(DOWNLOAD_URL, CODE, {
        disposition: `attachment; filename="page2webmcp-${CONTENT_HASH}.js"`,
      });
      throw new Error("unexpected request");
    },
  });

  const published = await store.publish(input(), new AbortController().signal);
  assert.equal(published.contentHash, CONTENT_HASH);
  assert.equal(calls.length, 3);
  assert.match(calls[0]!, new RegExp(`${CONTENT_HASH}\\.js$`));
  assert.deepEqual(calls.slice(1), [ARTIFACT_URL, DOWNLOAD_URL]);
});

test("does not treat arbitrary upload exceptions as response loss", async () => {
  const errors = [
    Object.assign(new Error("database rejected upload"), { code: "ECONNRESET" }),
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("name resolution failed"), { code: "ENOTFOUND" }),
    }),
    Object.assign(new Error("wrapped"), {
      name: "StorageUnknownError",
      originalError: Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" }),
      }),
    }),
  ];
  for (const error of errors) {
    const fixture = harness({ uploadResult: async () => { throw error; } });
    await assert.rejects(
      fixture.store.publish(input(), new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_UPLOAD_FAILED$/,
    );
    assert.equal(fixture.fetchCalls.length, 0);
  }
});

test("rejects unrelated typed and untyped conflicts without message parsing or public reconciliation", async () => {
  const rejected = [
    new StorageApiError("ResourceAlreadyExists in a message", 409, "Duplicate"),
    new StorageApiError("plain conflict", 409, "409"),
    new StorageApiError("legacy code is not absent", 400, "409", "storage", "OtherConflict"),
    new StorageApiError("wrong status", 422, "ResourceAlreadyExists"),
    new StorageApiError("other 400", 400, "Duplicate"),
    { status: 409, statusCode: "ResourceAlreadyExists", message: SECRET },
  ];
  for (const error of rejected) {
    const fixture = harness({ uploadResult: { data: null, error } });
    await assert.rejects(
      fixture.store.publish(input(), new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_UPLOAD_FAILED$/,
    );
    assert.equal(fixture.fetchCalls.length, 0);
    assert.equal(fixture.uploadCalls.length, 1);
  }
});

test("never overwrites or accepts mismatched bytes during typed conflict reconciliation", async () => {
  const typed = harness({
    uploadResult: {
      data: null,
      error: new StorageApiError("duplicate", 409, "409", "storage", "ResourceAlreadyExists"),
    },
    responses: [exactResponse(ARTIFACT_URL, "export const wrong = true;\n")],
  });
  await assert.rejects(
    typed.store.publish(input(), new AbortController().signal),
    /^Error: RELEASE_ARTIFACT_MISMATCH$/,
  );
  assert.equal(typed.uploadCalls.length, 1);
  assert.equal(typed.fetchCalls.length, 1);
});

test("binds SDK upload fetch to the exact POST endpoint without stripping legitimate auth headers", async () => {
  const transportCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const uploadUrl = `${HOSTED_SERVER}/storage/v1/object/page2webmcp-releases/${CONTENT_HASH}.js`;
  const clientFactory: ReleaseArtifactClientFactory = (server, secret, clientOptions) => ({
    storage: {
      from(bucket) {
        return {
          async upload(path, body, uploadOptions) {
            const response = await clientOptions.global.fetch(`${server}/storage/v1/object/${bucket}/${path}`, {
              method: "POST",
              headers: { authorization: `Bearer ${secret}`, apikey: secret },
              body: Uint8Array.from(body).buffer,
            });
            assert.equal(response.status, 200);
            assert.deepEqual(uploadOptions, {
              contentType: "application/javascript", cacheControl: "31536000", upsert: false,
            });
            return { data: { path }, error: null };
          },
        };
      },
    },
  });
  const responses = [
    exactResponse(uploadUrl, "", { contentType: "application/json" }),
    exactResponse(ARTIFACT_URL),
    exactResponse(DOWNLOAD_URL, CODE, {
      disposition: `attachment; filename="page2webmcp-${CONTENT_HASH}.js"`,
    }),
  ];
  const store = createConfiguredReleaseArtifactStore(environment(), {
    createClient: clientFactory,
    fetch: async (resource, init) => {
      const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
      transportCalls.push({ url, init });
      return responses.shift()!;
    },
  });

  await store.publish(input(), new AbortController().signal);
  assert.equal(transportCalls[0]?.url, uploadUrl);
  assert.equal(transportCalls[0]?.init?.method, "POST");
  assert.equal(transportCalls[0]?.init?.redirect, "error");
  assert.equal(transportCalls[0]?.init?.credentials, "omit");
  const headers = new Headers(transportCalls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
  assert.equal(headers.get("apikey"), SECRET);
  assert.equal(new Headers(transportCalls[1]?.init?.headers).has("authorization"), false);
});

test("rejects SDK upload method or URL drift before transmitting Storage credentials", async () => {
  for (const attempted of [
    { url: `https://attacker.example/${CONTENT_HASH}.js`, method: "POST" },
    {
      url: `${HOSTED_SERVER}/storage/v1/object/page2webmcp-releases/${CONTENT_HASH}.js`,
      method: "PUT",
    },
  ]) {
    let transportCalls = 0;
    const clientFactory: ReleaseArtifactClientFactory = (_server, secret, clientOptions) => ({
      storage: {
        from() {
          return {
            async upload() {
              await clientOptions.global.fetch(attempted.url, {
                method: attempted.method,
                headers: { authorization: `Bearer ${secret}`, apikey: secret },
              });
              return { data: { path: `${CONTENT_HASH}.js` }, error: null };
            },
          };
        },
      },
    });
    const store = createConfiguredReleaseArtifactStore(environment(), {
      createClient: clientFactory,
      fetch: async () => {
        transportCalls += 1;
        throw new Error("must not transmit");
      },
    });

    await assert.rejects(
      store.publish(input(), new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_UPLOAD_FAILED$/,
    );
    assert.equal(transportCalls, 0);
  }
});

test("blocks upload redirects and cross-origin final responses without credential-bearing follow-up", async () => {
  const uploadUrl = `${HOSTED_SERVER}/storage/v1/object/page2webmcp-releases/${CONTENT_HASH}.js`;
  for (const response of [
    exactResponse(uploadUrl, "redirect", { status: 307 }),
    exactResponse(`https://attacker.example/${CONTENT_HASH}.js`, "redirected", { redirected: true }),
  ]) {
    const transportCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const clientFactory: ReleaseArtifactClientFactory = (server, secret, clientOptions) => ({
      storage: {
        from(bucket) {
          return {
            async upload(path) {
              await clientOptions.global.fetch(`${server}/storage/v1/object/${bucket}/${path}`, {
                method: "POST",
                headers: { authorization: `Bearer ${secret}`, apikey: secret },
              });
              return { data: { path }, error: null };
            },
          };
        },
      },
    });
    const store = createConfiguredReleaseArtifactStore(environment(), {
      createClient: clientFactory,
      fetch: async (resource, init) => {
        const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
        transportCalls.push({ url, init });
        return response;
      },
    });

    await assert.rejects(
      store.publish(input(), new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_UPLOAD_FAILED$/,
    );
    assert.equal(transportCalls.length, 1);
    assert.equal(transportCalls[0]?.url, uploadUrl);
    assert.equal(transportCalls[0]?.init?.redirect, "error");
    assert.equal(new Headers(transportCalls[0]?.init?.headers).get("apikey"), SECRET);
  }
});

test("keeps upload and public-read failures redacted and never retries uncontrolled errors", async () => {
  const upload = harness({ uploadResult: async () => { throw new Error(`${SECRET} ${HOSTED_PREFIX} candidate:${CODE}`); } });
  await assert.rejects(upload.store.publish(input(), new AbortController().signal), (error: unknown) => {
    assert.equal((error as Error).message, "RELEASE_ARTIFACT_UPLOAD_FAILED");
    assert.doesNotMatch(String(error), new RegExp(SECRET));
    assert.doesNotMatch(String(error), /widgets|supabase\.co/);
    return true;
  });
  assert.equal(upload.uploadCalls.length, 1);
  assert.equal(upload.fetchCalls.length, 0);

  const reads = harness({ responses: [new Error(`${SECRET} ${ARTIFACT_URL}`)] });
  await assert.rejects(reads.store.publish(input(), new AbortController().signal), (error: unknown) => {
    assert.equal((error as Error).message, "RELEASE_ARTIFACT_READ_FAILED");
    assert.doesNotMatch(String(error), new RegExp(SECRET));
    assert.doesNotMatch(String(error), /supabase\.co/);
    return true;
  });
  assert.equal(reads.fetchCalls.length, 1);
});

test("retries only transient public statuses within one three-read operation budget", async () => {
  for (const transient of [404, 408, 425, 429, 500, 503]) {
    const fixture = harness({ responses: [
      exactResponse(ARTIFACT_URL, "pending", { status: transient }),
      exactResponse(ARTIFACT_URL),
      exactResponse(DOWNLOAD_URL, CODE, {
        disposition: `attachment; filename="page2webmcp-${CONTENT_HASH}.js"`,
      }),
    ] });
    await fixture.store.publish(input(), new AbortController().signal);
    assert.equal(fixture.fetchCalls.length, 3);
  }

  const exhausted = harness({ responses: [
    exactResponse(ARTIFACT_URL, "pending", { status: 404 }),
    exactResponse(ARTIFACT_URL, "pending", { status: 429 }),
    exactResponse(ARTIFACT_URL, "pending", { status: 503 }),
  ] });
  await assert.rejects(
    exhausted.store.publish(input(), new AbortController().signal),
    /^Error: RELEASE_ARTIFACT_READ_FAILED$/,
  );
  assert.equal(exhausted.fetchCalls.length, 3);

  for (const permanent of [302, 400, 401, 403, 409]) {
    const fixture = harness({ responses: [exactResponse(ARTIFACT_URL, "invalid", { status: permanent })] });
    await assert.rejects(
      fixture.store.publish(input(), new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_READ_FAILED$/,
    );
    assert.equal(fixture.fetchCalls.length, 1);
  }
});

test("cancels a transient response body before reusing the public-read budget", async () => {
  let cancellations = 0;
  const pendingBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("not visible yet"));
    },
    cancel() {
      cancellations += 1;
    },
  });
  const fixture = harness({ responses: [
    exactResponse(ARTIFACT_URL, pendingBody, { status: 404 }),
    exactResponse(ARTIFACT_URL),
    exactResponse(DOWNLOAD_URL, CODE, {
      disposition: `attachment; filename="page2webmcp-${CONTENT_HASH}.js"`,
    }),
  ] });

  await fixture.store.publish(input(), new AbortController().signal);
  assert.equal(cancellations, 1);
  assert.equal(fixture.fetchCalls.length, 3);
});

test("fails closed without retry on exact-serving, MIME, cookie, or download-disposition mismatch", async () => {
  const mismatches: readonly (readonly Response[])[] = [
    [exactResponse(ARTIFACT_URL, "export const changed = true;\n")],
    [exactResponse(ARTIFACT_URL, CODE, { contentType: "text/javascript" })],
    [exactResponse(`${ARTIFACT_URL}/redirected`)],
    [
      exactResponse(ARTIFACT_URL),
      exactResponse(DOWNLOAD_URL),
    ],
    [
      exactResponse(ARTIFACT_URL),
      exactResponse(DOWNLOAD_URL, CODE, { disposition: "inline" }),
    ],
  ];

  for (const responses of mismatches) {
    const fixture = harness({ responses });
    await assert.rejects(
      fixture.store.publish(input(), new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_MISMATCH$/,
    );
    assert.equal(fixture.fetchCalls.length, responses.length);
  }
});

test("accepts only exact safe single or Supabase dual download filename disposition", async () => {
  const expected = `page2webmcp-${CONTENT_HASH}.js`;
  for (const disposition of [
    `attachment; filename=${expected}`,
    `attachment; filename="${expected}"`,
    `attachment; filename=${expected}; filename*=UTF-8''${expected}`,
  ]) {
    const fixture = harness({ responses: [
      exactResponse(ARTIFACT_URL),
      exactResponse(DOWNLOAD_URL, CODE, { disposition }),
    ] });
    await fixture.store.publish(input(), new AbortController().signal);
  }

  for (const disposition of [
    `attachment; filename=${expected}; filename*=UTF-8''wrong.js`,
    `attachment; filename=wrong.js; filename*=UTF-8''${expected}`,
    `attachment; filename=${expected}; filename=${expected}`,
    `attachment; filename=${expected}; filename*=UTF-8''${expected}; size=29`,
    `attachment; filename*=UTF-8''${expected}`,
    `inline; filename=${expected}; filename*=UTF-8''${expected}`,
  ]) {
    const fixture = harness({ responses: [
      exactResponse(ARTIFACT_URL),
      exactResponse(DOWNLOAD_URL, CODE, { disposition }),
    ] });
    await assert.rejects(
      fixture.store.publish(input(), new AbortController().signal),
      /^Error: RELEASE_ARTIFACT_MISMATCH$/,
    );
  }
});

test("cancels response bodies on every rejected non-consumed public response path", async () => {
  const cases: ReadonlyArray<Readonly<{
    response: (body: ReadableStream<Uint8Array>) => readonly Response[];
    code: "RELEASE_ARTIFACT_READ_FAILED" | "RELEASE_ARTIFACT_MISMATCH";
  }>> = [
    { response: (body) => [exactResponse(ARTIFACT_URL, body, { status: 400 })], code: "RELEASE_ARTIFACT_READ_FAILED" },
    { response: (body) => [exactResponse(`${ARTIFACT_URL}/wrong`, body)], code: "RELEASE_ARTIFACT_MISMATCH" },
    { response: (body) => [exactResponse(ARTIFACT_URL, body, { contentType: "text/javascript" })], code: "RELEASE_ARTIFACT_MISMATCH" },
    {
      response: (body) => [
        exactResponse(ARTIFACT_URL),
        exactResponse(DOWNLOAD_URL, body, { disposition: "inline" }),
      ],
      code: "RELEASE_ARTIFACT_MISMATCH",
    },
    {
      response: (body) => [exactResponse(ARTIFACT_URL, body, { contentLength: "65537" })],
      code: "RELEASE_ARTIFACT_MISMATCH",
    },
    {
      response: (body) => [exactResponse(ARTIFACT_URL, body, { contentLength: "not-a-number" })],
      code: "RELEASE_ARTIFACT_MISMATCH",
    },
  ];

  for (const item of cases) {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("unconsumed"));
      },
      cancel() {
        cancellations += 1;
      },
    });
    const fixture = harness({ responses: item.response(body) });
    await assert.rejects(
      fixture.store.publish(input(), new AbortController().signal),
      new RegExp(`^Error: ${item.code}$`),
    );
    assert.equal(cancellations, 1);
  }
});

test("cancels a pending response reader when the total lifecycle expires", async () => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations += 1;
    },
  });
  const fixture = harness({ deadlineMs: 5, responses: [exactResponse(ARTIFACT_URL, body)] });

  await assert.rejects(
    fixture.store.publish(input(), new AbortController().signal),
    /^Error: RELEASE_ARTIFACT_DEADLINE_EXCEEDED$/,
  );
  assert.equal(cancellations, 1);
});

test("bounds public response streaming before accepting bytes", async () => {
  const fixture = harness({ responses: [
    exactResponse(ARTIFACT_URL, new Uint8Array(65_537)),
  ] });
  await assert.rejects(
    fixture.store.publish(input(), new AbortController().signal),
    /^Error: RELEASE_ARTIFACT_MISMATCH$/,
  );
  assert.equal(fixture.fetchCalls.length, 1);
});

test("honors caller cancellation and the one total deadline across upload and reads", async () => {
  const preAborted = harness();
  const controller = new AbortController();
  controller.abort(new Error(`${SECRET} must stay redacted`));
  await assert.rejects(
    preAborted.store.publish(input(), controller.signal),
    /^Error: RELEASE_ARTIFACT_ABORTED$/,
  );
  assert.equal(preAborted.clientCalls.length, 0);

  const timedOut = harness({
    deadlineMs: 5,
    uploadResult: () => new Promise<UploadResult>(() => undefined),
  });
  await assert.rejects(
    timedOut.store.publish(input(), new AbortController().signal),
    /^Error: RELEASE_ARTIFACT_DEADLINE_EXCEEDED$/,
  );
  assert.equal(timedOut.uploadCalls.length, 1);
  assert.equal(timedOut.fetchCalls.length, 0);
});

test("does not miss a caller abort between the publish precheck and lifecycle listener", async () => {
  const controller = new AbortController();
  let reads = 0;
  Object.defineProperty(controller.signal, "aborted", {
    configurable: true,
    get() {
      reads += 1;
      if (reads === 1) {
        controller.abort(new Error(`${SECRET} must stay redacted`));
        return false;
      }
      return true;
    },
  });
  const fixture = harness();

  await assert.rejects(
    fixture.store.publish(input(), controller.signal),
    /^Error: RELEASE_ARTIFACT_ABORTED$/,
  );
  assert.equal(fixture.clientCalls.length, 0);
  assert.equal(fixture.fetchCalls.length, 0);
});

test("a CDN cookie on the public artifact does not fail publication", async () => {
  // Hosted Storage sits behind Cloudflare, which attaches __cf_bm to every
  // public read. The bytes are still exact and hash-verified.
  const cookie = "__cf_bm=abc123; path=/; HttpOnly; Secure; SameSite=None";
  const fixture = harness({
    responses: [
      exactResponse(ARTIFACT_URL, CODE, { setCookie: cookie }),
      exactResponse(DOWNLOAD_URL, CODE, {
        setCookie: cookie,
        disposition: `attachment; filename="page2webmcp-${CONTENT_HASH}.js"`,
      }),
    ],
  });
  const published = await fixture.store.publish(input(), new AbortController().signal);
  assert.equal(published.artifactUrl, ARTIFACT_URL);
  assert.equal(published.contentHash, CONTENT_HASH);
});
