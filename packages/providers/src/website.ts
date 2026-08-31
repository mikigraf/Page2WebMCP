import { createHash } from "node:crypto";
import { validateResolvedAddress, validateTargetUrl } from "../../security/src/security.ts";

const DEFAULT_MAX_BYTES = 256 * 1_024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_OWNERSHIP_BYTES = 4_096;
const MAX_CHALLENGE_TTL_MS = 15 * 60 * 1_000;

export type WebsiteHttpResponse = Readonly<{
  status: number;
  url: string;
  connectedAddress: string;
  tls: Readonly<{
    authorized: true;
    servername: string;
    protocol: "TLSv1.2" | "TLSv1.3";
  }>;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}>;

export type WebsiteProviderControls = Readonly<{
  hostedScriptOrigin: string;
  resolver: {
    resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
    resolveTxt(hostname: string, signal: AbortSignal): Promise<readonly (readonly string[])[]>;
  };
  transport: {
    request(request: Readonly<{
      url: string;
      method: "GET" | "HEAD";
      headers: Readonly<Record<string, string>>;
      pinnedAddresses: readonly string[];
      redirect: "manual";
      credentials: "omit";
      signal: AbortSignal;
    }>): Promise<WebsiteHttpResponse>;
  };
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}>;

export type WebsitePreflightResult = Readonly<{
  targetOrigin: string;
  finalUrl: string;
  contentType: "text/html" | "application/xhtml+xml";
  contentReference: string;
  redirects: readonly string[];
  csp: Readonly<{
    headerPresent: boolean;
    allowsHostedScript: boolean;
    scriptSources: readonly string[];
  }>;
}>;

export type WebsiteOwnershipChallenge = Readonly<{
  method: "dns_txt" | "well_known";
  targetOrigin: string;
  token: string;
  expiresAt: string;
}>;

export type OwnershipReplayStore = Readonly<{
  consume(key: string, expiresAt: string): Promise<boolean>;
}>;

export type WebsiteOwnershipControls = WebsiteProviderControls & Readonly<{
  replayStore: OwnershipReplayStore;
  clock?: () => Date;
}>;

export type WebsiteOwnershipEvidence = Readonly<{
  source: "owner_review";
  content: string;
  reference: string;
  targetOrigin: string;
  tokenDigest: string;
  expiresAt: string;
}>;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("WEBSITE_PROVIDER_POLICY_INVALID");
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name)?.[1];
}

function normalizedContentType(headers: Readonly<Record<string, string>>): string | undefined {
  return header(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function assertVerifiedTls(response: WebsiteHttpResponse, hostname: string): Promise<void> {
  if (!response.tls || response.tls.authorized !== true || response.tls.servername !== hostname
    || !["TLSv1.2", "TLSv1.3"].includes(response.tls.protocol)) {
    await discardBody(response.body);
    throw new Error("WEBSITE_TLS_VERIFICATION_FAILED");
  }
}

function validatedWebsiteUrl(value: string): URL {
  const validation = validateTargetUrl(value);
  if (!validation.ok) throw new Error(validation.code === "PRIVATE_NETWORK_BLOCKED"
    ? "WEBSITE_SSRF_BLOCKED"
    : "WEBSITE_URL_BLOCKED");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("WEBSITE_URL_BLOCKED"); }
  if (parsed.search || parsed.hash) throw new Error("WEBSITE_URL_BLOCKED");
  return parsed;
}

async function pinnedAddresses(hostname: string, controls: WebsiteProviderControls, signal: AbortSignal): Promise<string[]> {
  const addresses = await controls.resolver.resolve(hostname, signal);
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 16
    || addresses.some((address) => typeof address !== "string" || !validateResolvedAddress(address).ok)) {
    throw new Error("WEBSITE_SSRF_BLOCKED");
  }
  return [...new Set(addresses)].sort(compareCodePoints);
}

async function discardBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  try { await body[Symbol.asyncIterator]().return?.(); } catch { /* cleanup cannot weaken the primary failure */ }
}

async function readBoundedBody(
  response: WebsiteHttpResponse,
  maximum: number,
  signal: AbortSignal,
  tooLargeCode = "WEBSITE_RESPONSE_TOO_LARGE",
): Promise<Uint8Array> {
  const declared = header(response.headers, "content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await discardBody(response.body);
    throw new Error(tooLargeCode);
  }
  const chunks: Uint8Array[] = [];
  const iterator = response.body[Symbol.asyncIterator]();
  let length = 0;
  try {
    for (;;) {
      let item: IteratorResult<Uint8Array>;
      try { item = await iterator.next(); }
      catch {
        if (signal.aborted) throw signal.reason;
        throw new Error("WEBSITE_FETCH_FAILED");
      }
      if (item.done) break;
      if (signal.aborted) throw signal.reason;
      if (!(item.value instanceof Uint8Array)) throw new Error("WEBSITE_TRANSPORT_POLICY_VIOLATION");
      length += item.value.byteLength;
      if (length > maximum) throw new Error(tooLargeCode);
      chunks.push(item.value);
    }
  } finally {
    try { await iterator.return?.(); } catch { /* cleanup cannot weaken the primary failure */ }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cspReport(headers: Readonly<Record<string, string>>, targetOrigin: string, hostedScriptOrigin: string) {
  const policy = header(headers, "content-security-policy");
  if (policy === undefined) return { headerPresent: false, allowsHostedScript: true, scriptSources: [] };
  const directives = new Map(policy.split(";").map((directive) => directive.trim().split(/\s+/))
    .filter((parts) => parts[0]).map(([name, ...values]) => [name!.toLowerCase(), values]));
  const sources = directives.get("script-src") ?? directives.get("default-src") ?? [];
  const allowsHostedScript = sources.includes("*")
    || sources.includes(hostedScriptOrigin)
    || hostedScriptOrigin === targetOrigin && sources.includes("'self'");
  return { headerPresent: true, allowsHostedScript, scriptSources: sources };
}

async function preflightWithinPolicy(
  sourceUrl: string,
  controls: WebsiteProviderControls,
  signal: AbortSignal,
): Promise<WebsitePreflightResult> {
  const initial = validatedWebsiteUrl(sourceUrl);
  const targetOrigin = initial.origin;
  const hostedScript = validatedWebsiteUrl(`${controls.hostedScriptOrigin}/`);
  if (hostedScript.origin !== controls.hostedScriptOrigin) throw new Error("WEBSITE_PROVIDER_POLICY_INVALID");
  const maxBytes = boundedInteger(controls.maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
  const maxRedirects = boundedInteger(controls.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 10);
  const redirects: string[] = [];
  let current = initial;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const pins = await pinnedAddresses(current.hostname, controls, signal);
    const result = await controls.transport.request({
      url: current.href,
      method: "GET",
      headers: { accept: "text/html, application/xhtml+xml" },
      pinnedAddresses: pins,
      redirect: "manual",
      credentials: "omit",
      signal,
    });
    if (!result) throw new Error("WEBSITE_TRANSPORT_POLICY_VIOLATION");
    await assertVerifiedTls(result, current.hostname);
    if (result.url !== current.href || !Number.isInteger(result.status)) {
      throw new Error("WEBSITE_TRANSPORT_POLICY_VIOLATION");
    }
    if (!validateResolvedAddress(result.connectedAddress).ok || !pins.includes(result.connectedAddress)) {
      await discardBody(result.body);
      throw new Error("WEBSITE_DNS_REBINDING_BLOCKED");
    }
    if (result.status >= 300 && result.status <= 399) {
      await discardBody(result.body);
      if (redirects.length >= maxRedirects) throw new Error("WEBSITE_REDIRECT_LIMIT_EXCEEDED");
      const location = header(result.headers, "location");
      if (!location) throw new Error("WEBSITE_TRANSPORT_POLICY_VIOLATION");
      let next: URL;
      try { next = validatedWebsiteUrl(new URL(location, current).href); } catch (error) { throw error; }
      if (next.origin !== targetOrigin) throw new Error("WEBSITE_REDIRECT_ORIGIN_BLOCKED");
      redirects.push(next.href);
      current = next;
      continue;
    }
    if (result.status !== 200) {
      await discardBody(result.body);
      throw new Error("WEBSITE_PUBLIC_PAGE_UNREACHABLE");
    }
    const contentType = normalizedContentType(result.headers);
    if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
      await discardBody(result.body);
      throw new Error("WEBSITE_CONTENT_TYPE_BLOCKED");
    }
    const bytes = await readBoundedBody(result, maxBytes, signal);
    return {
      targetOrigin,
      finalUrl: current.href,
      contentType,
      contentReference: `urn:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      redirects,
      csp: cspReport(result.headers, targetOrigin, hostedScript.origin),
    };
  }
}

async function withWebsiteDeadline<T>(
  controls: WebsiteProviderControls,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!controls?.resolver || !controls.transport || !controls.hostedScriptOrigin) {
    throw new Error("WEBSITE_PROVIDER_CONTROLS_REQUIRED");
  }
  const timeoutMs = boundedInteger(controls.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 60_000);
  const controller = new AbortController();
  const timeoutError = new Error("WEBSITE_PREFLIGHT_TIMEOUT");
  const callerError = new Error("WEBSITE_PREFLIGHT_ABORTED");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCaller!: (reason: Error) => void;
  const caller = new Promise<never>((_resolve, reject) => { rejectCaller = reject; });
  const abort = () => { controller.abort(callerError); rejectCaller(callerError); };
  if (controls.signal?.aborted) abort();
  else controls.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([
      action(controller.signal),
      caller,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { controller.abort(timeoutError); reject(timeoutError); }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controls.signal?.removeEventListener("abort", abort);
  }
}

export async function preflightWebsiteSource(
  sourceUrl: string,
  controls: WebsiteProviderControls,
): Promise<WebsitePreflightResult> {
  return withWebsiteDeadline(controls, (signal) => preflightWithinPolicy(sourceUrl, controls, signal));
}

function validateChallenge(challenge: WebsiteOwnershipChallenge, now: Date): URL {
  let origin: URL;
  try { origin = validatedWebsiteUrl(`${challenge.targetOrigin}/`); } catch { throw new Error("OWNERSHIP_CHALLENGE_INVALID"); }
  if (origin.origin !== challenge.targetOrigin || origin.href !== `${challenge.targetOrigin}/`
    || !/^[A-Za-z0-9_-]{32,128}$/.test(challenge.token)) throw new Error("OWNERSHIP_CHALLENGE_INVALID");
  const expiry = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiry)) throw new Error("OWNERSHIP_CHALLENGE_INVALID");
  if (expiry <= now.getTime()) throw new Error("OWNERSHIP_CHALLENGE_EXPIRED");
  if (expiry - now.getTime() > MAX_CHALLENGE_TTL_MS) throw new Error("OWNERSHIP_CHALLENGE_INVALID");
  return origin;
}

function dnsProof(challenge: WebsiteOwnershipChallenge): string {
  return `page2webmcp-verification=${challenge.token};origin=${challenge.targetOrigin};expires=${challenge.expiresAt}`;
}

function wellKnownProof(challenge: WebsiteOwnershipChallenge): string {
  return `page2webmcp-verification=${challenge.token}\norigin=${challenge.targetOrigin}\nexpires=${challenge.expiresAt}\n`;
}

async function verifyWellKnown(
  challenge: WebsiteOwnershipChallenge,
  origin: URL,
  controls: WebsiteOwnershipControls,
  signal: AbortSignal,
): Promise<void> {
  const url = `${origin.origin}/.well-known/page2webmcp-verification.txt`;
  const pins = await pinnedAddresses(origin.hostname, controls, signal);
  const result = await controls.transport.request({
    url,
    method: "GET",
    headers: { accept: "text/plain" },
    pinnedAddresses: pins,
    redirect: "manual",
    credentials: "omit",
    signal,
  });
  if (!result) throw new Error("OWNERSHIP_PROOF_MISSING");
  await assertVerifiedTls(result, origin.hostname);
  if (result.url !== url) {
    await discardBody(result.body);
    throw new Error("OWNERSHIP_ORIGIN_MISMATCH");
  }
  if (!validateResolvedAddress(result.connectedAddress).ok || !pins.includes(result.connectedAddress)) {
    await discardBody(result.body);
    throw new Error("WEBSITE_DNS_REBINDING_BLOCKED");
  }
  if (result.status !== 200 || normalizedContentType(result.headers) !== "text/plain") {
    await discardBody(result.body);
    throw new Error("OWNERSHIP_PROOF_MISSING");
  }
  const bytes = await readBoundedBody(result, MAX_OWNERSHIP_BYTES, signal, "OWNERSHIP_PROOF_INVALID");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("OWNERSHIP_PROOF_INVALID"); }
  if (content !== wellKnownProof(challenge)) throw new Error("OWNERSHIP_PROOF_INVALID");
}

export async function verifyWebsiteOwnership(
  challenge: WebsiteOwnershipChallenge,
  controls: WebsiteOwnershipControls,
): Promise<WebsiteOwnershipEvidence> {
  if (!controls?.replayStore || !controls.resolver?.resolveTxt) throw new Error("OWNERSHIP_CONTROLS_REQUIRED");
  const now = (controls.clock ?? (() => new Date()))();
  const origin = validateChallenge(challenge, now);
  await withWebsiteDeadline(controls, async (signal) => {
    if (challenge.method === "dns_txt") {
      const records = await controls.resolver.resolveTxt(`_page2webmcp.${origin.hostname}`, signal);
      if (!Array.isArray(records) || records.length > 100) throw new Error("OWNERSHIP_PROOF_INVALID");
      if (!records.some((record) => Array.isArray(record) && record.join("") === dnsProof(challenge))) {
        throw new Error("OWNERSHIP_PROOF_MISSING");
      }
      return;
    }
    await verifyWellKnown(challenge, origin, controls, signal);
  });
  const tokenDigest = createHash("sha256").update(challenge.token, "utf8").digest("hex");
  const replayKey = createHash("sha256")
    .update(`${challenge.targetOrigin}\n${tokenDigest}\n${challenge.expiresAt}`, "utf8")
    .digest("hex");
  if (!await controls.replayStore.consume(replayKey, challenge.expiresAt)) throw new Error("OWNERSHIP_PROOF_REPLAYED");
  const content = JSON.stringify({
    expiresAt: challenge.expiresAt,
    method: challenge.method,
    targetOrigin: challenge.targetOrigin,
    tokenDigest,
    version: 1,
  });
  return {
    source: "owner_review",
    content,
    reference: `urn:sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    targetOrigin: challenge.targetOrigin,
    tokenDigest,
    expiresAt: challenge.expiresAt,
  };
}
