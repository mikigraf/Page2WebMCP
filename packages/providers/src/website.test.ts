import assert from "node:assert/strict";
import test from "node:test";
import {
  preflightWebsiteSource,
  verifyWebsiteOwnership,
  type WebsiteHttpResponse,
  type WebsiteProviderControls,
} from "./website.ts";

const publicAddress = "93.184.216.34";
const targetOrigin = "https://widgets.example";

function body(value: string): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(value); } };
}

function response(input: Partial<WebsiteHttpResponse> = {}): WebsiteHttpResponse {
  return {
    status: 200,
    url: `${targetOrigin}/`,
    connectedAddress: publicAddress,
    tls: { authorized: true, servername: "widgets.example", protocol: "TLSv1.3" },
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; script-src 'self' https://scripts.page2webmcp.example",
    },
    body: body("<!doctype html><title>Widgets</title>"),
    ...input,
  };
}

function controls(
  request: WebsiteProviderControls["transport"]["request"] = async () => response(),
): WebsiteProviderControls {
  return {
    hostedScriptOrigin: "https://scripts.page2webmcp.example",
    resolver: {
      resolve: async () => [publicAddress],
      resolveTxt: async () => [],
    },
    transport: { request },
    timeoutMs: 1_000,
  };
}

test("website preflight pins public DNS and returns a bounded CSP/reachability report", async () => {
  const requests: unknown[] = [];
  const result = await preflightWebsiteSource(`${targetOrigin}/`, controls(async (request) => {
    requests.push(request);
    return response();
  }));

  assert.deepEqual(requests, [{
    url: `${targetOrigin}/`,
    method: "GET",
    headers: { accept: "text/html, application/xhtml+xml" },
    pinnedAddresses: [publicAddress],
    redirect: "manual",
    credentials: "omit",
    signal: requests.length === 1
      ? (requests[0] as { signal: AbortSignal }).signal
      : new AbortController().signal,
  }]);
  assert.equal(result.targetOrigin, targetOrigin);
  assert.equal(result.finalUrl, `${targetOrigin}/`);
  assert.equal(result.contentType, "text/html");
  assert.equal(result.csp.headerPresent, true);
  assert.equal(result.csp.allowsHostedScript, true);
  assert.deepEqual(result.csp.scriptSources, ["'self'", "https://scripts.page2webmcp.example"]);
  assert.match(result.contentReference, /^urn:sha256:[a-f0-9]{64}$/);
  assert.equal("body" in result, false);
});

test("website preflight rejects unsafe URLs, DNS destinations, redirect origins, and rebinding", async () => {
  for (const unsafe of [
    "http://widgets.example/",
    "https://user:password@widgets.example/",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://224.0.0.1/",
  ]) {
    await assert.rejects(preflightWebsiteSource(unsafe, controls()), /WEBSITE_(?:URL|SSRF)_BLOCKED/);
  }

  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({
    status: 302,
    headers: { location: "https://other.example/" },
    body: body(""),
  }))), /WEBSITE_REDIRECT_ORIGIN_BLOCKED/);

  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({
    connectedAddress: "93.184.216.35",
  }))), /WEBSITE_DNS_REBINDING_BLOCKED/);

  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, {
    ...controls(),
    resolver: { resolve: async () => ["169.254.169.254"], resolveTxt: async () => [] },
  }), /WEBSITE_SSRF_BLOCKED/);
});

test("website preflight rejects bad status/content type/size/time and reports restrictive CSP", async () => {
  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({ status: 401 }))), /WEBSITE_PUBLIC_PAGE_UNREACHABLE/);
  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({ headers: { "content-type": "application/octet-stream" } }))), /WEBSITE_CONTENT_TYPE_BLOCKED/);
  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, { ...controls(async () => response({ body: body("x".repeat(33)) })), maxBytes: 32 }), /WEBSITE_RESPONSE_TOO_LARGE/);
  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, { ...controls(async ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))), timeoutMs: 10 }), /WEBSITE_PREFLIGHT_TIMEOUT/);

  const restrictive = await preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({
    headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'; script-src 'self'" },
  })));
  assert.equal(restrictive.csp.allowsHostedScript, false);
});

test("website preflight maps secret-bearing body stream failures to a stable code", async () => {
  const secretBearingBody: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => { throw new Error("ECONNRESET token=live-secret-never-log"); },
      };
    },
  };
  await assert.rejects(
    preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({ body: secretBearingBody }))),
    /^Error: WEBSITE_FETCH_FAILED$/,
  );
});

test("website preflight requires exact authorized modern-TLS transport attestation", async () => {
  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({
    tls: { authorized: false, servername: "widgets.example", protocol: "TLSv1.3" } as unknown as WebsiteHttpResponse["tls"],
  }))), /WEBSITE_TLS_VERIFICATION_FAILED/);
  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({
    tls: { authorized: true, servername: "other.example", protocol: "TLSv1.3" },
  }))), /WEBSITE_TLS_VERIFICATION_FAILED/);
  await assert.rejects(preflightWebsiteSource(`${targetOrigin}/`, controls(async () => response({
    tls: { authorized: true, servername: "widgets.example", protocol: "TLSv1" } as unknown as WebsiteHttpResponse["tls"],
  }))), /WEBSITE_TLS_VERIFICATION_FAILED/);
});

test("ownership verification accepts exact DNS TXT proof once and stores only a token digest", async () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const expiresAt = "2026-08-30T12:10:00.000Z";
  const consumed = new Set<string>();
  const replayStore = { consume: async (key: string) => consumed.has(key) ? false : (consumed.add(key), true) };
  const provider = {
    ...controls(),
    resolver: {
      resolve: async () => [publicAddress],
      resolveTxt: async (hostname: string) => {
        assert.equal(hostname, "_page2webmcp.widgets.example");
        return [[`page2webmcp-verification=${token};origin=${targetOrigin};expires=${expiresAt}`]];
      },
    },
  };
  const input = { method: "dns_txt" as const, targetOrigin, token, expiresAt };
  const proof = await verifyWebsiteOwnership(input, { ...provider, replayStore, clock: () => now });
  assert.equal(proof.source, "owner_review");
  assert.match(proof.reference, /^urn:sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(proof.content, new RegExp(token));
  assert.deepEqual(JSON.parse(proof.content), {
    expiresAt,
    method: "dns_txt",
    targetOrigin,
    tokenDigest: proof.tokenDigest,
    version: 1,
  });
  await assert.rejects(verifyWebsiteOwnership(input, { ...provider, replayStore, clock: () => now }), /OWNERSHIP_PROOF_REPLAYED/);
});

test("ownership verification accepts only exact same-origin well-known proof", async () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const token = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const expiresAt = "2026-08-30T12:05:00.000Z";
  const exact = `page2webmcp-verification=${token}\norigin=${targetOrigin}\nexpires=${expiresAt}\n`;
  const seen: unknown[] = [];
  const provider = controls(async (request) => {
    seen.push(request);
    return response({
      url: `${targetOrigin}/.well-known/page2webmcp-verification.txt`,
      headers: { "content-type": "text/plain" },
      body: body(exact),
    });
  });
  const result = await verifyWebsiteOwnership(
    { method: "well_known" as const, targetOrigin, token, expiresAt },
    { ...provider, replayStore: { consume: async () => true }, clock: () => now },
  );
  assert.equal(result.targetOrigin, targetOrigin);
  assert.equal((seen[0] as { url: string }).url, `${targetOrigin}/.well-known/page2webmcp-verification.txt`);

  for (const invalid of [exact.replace(token, `${token}x`), exact.replace(targetOrigin, "https://other.example"), `${exact}extra`]) {
    await assert.rejects(verifyWebsiteOwnership(
      { method: "well_known" as const, targetOrigin, token, expiresAt },
      {
        ...controls(async () => response({
          url: `${targetOrigin}/.well-known/page2webmcp-verification.txt`,
          headers: { "content-type": "text/plain" },
          body: body(invalid),
        })),
        replayStore: { consume: async () => true },
        clock: () => now,
      },
    ), /OWNERSHIP_PROOF_INVALID/);
  }
});

test("ownership verification rejects expired, excessive, missing, and wrong-host proof", async () => {
  const token = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const base = controls();
  const replayStore = { consume: async () => true };
  await assert.rejects(verifyWebsiteOwnership(
    { method: "dns_txt", targetOrigin, token, expiresAt: "2026-08-30T11:59:59.000Z" },
    { ...base, replayStore, clock: () => new Date("2026-08-30T12:00:00.000Z") },
  ), /OWNERSHIP_CHALLENGE_EXPIRED/);
  await assert.rejects(verifyWebsiteOwnership(
    { method: "dns_txt", targetOrigin, token, expiresAt: "2026-08-30T13:00:00.000Z" },
    { ...base, replayStore, clock: () => new Date("2026-08-30T12:00:00.000Z") },
  ), /OWNERSHIP_CHALLENGE_INVALID/);
  await assert.rejects(verifyWebsiteOwnership(
    { method: "dns_txt", targetOrigin, token, expiresAt: "2026-08-30T12:05:00.000Z" },
    { ...base, replayStore, clock: () => new Date("2026-08-30T12:00:00.000Z") },
  ), /OWNERSHIP_PROOF_MISSING/);
  await assert.rejects(verifyWebsiteOwnership(
    { method: "well_known", targetOrigin, token, expiresAt: "2026-08-30T12:05:00.000Z" },
    {
      ...controls(async () => response({
        url: "https://other.example/.well-known/page2webmcp-verification.txt",
        headers: { "content-type": "text/plain" },
      })),
      replayStore,
      clock: () => new Date("2026-08-30T12:00:00.000Z"),
    },
  ), /OWNERSHIP_ORIGIN_MISMATCH/);
});
