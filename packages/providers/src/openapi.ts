import { createHash } from "node:crypto";
import { validateResolvedAddress, validateTargetUrl } from "../../security/src/security.ts";

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

export type OpenApiFetchResponse = Readonly<{
  status: number;
  url: string;
  connectedAddress: string;
  tls: Readonly<{
    authorized: boolean;
    servername: string;
    protocol: string | null;
  }>;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}>;

export type OpenApiProviderControls = Readonly<{
  resolver: Readonly<{
    resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  }>;
  transport: Readonly<{
    request(request: Readonly<{
      url: string;
      method: "GET";
      headers: Readonly<{ accept: string }>;
      pinnedAddresses: readonly string[];
      redirect: "manual";
      credentials: "omit";
      signal: AbortSignal;
    }>): Promise<OpenApiFetchResponse>;
  }>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}>;

export type OpenApiSource = Readonly<{
  source: string;
  format: "json" | "yaml";
  contentType: string;
  evidenceReference: string;
  sizeBytes: number;
  finalUrl?: string;
}>;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("OPENAPI_PROVIDER_POLICY_INVALID");
  return value;
}

function contentType(headers: Readonly<Record<string, string>>): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type");
  return entry?.[1].split(";", 1)[0]?.trim().toLowerCase();
}

function header(headers: Readonly<Record<string, string>>, target: string): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === target)?.[1];
}

function sourceFormat(value: string): "json" | "yaml" {
  if (["application/json", "application/openapi+json", "application/vnd.oai.openapi+json"].includes(value)) return "json";
  if (["application/yaml", "application/x-yaml", "text/yaml", "application/vnd.oai.openapi", "application/vnd.oai.openapi+yaml"].includes(value)) return "yaml";
  throw new Error("OPENAPI_CONTENT_TYPE_BLOCKED");
}

function decodeSource(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("OPENAPI_INVALID_UTF8");
  }
}

function immutableSource(bytes: Uint8Array, contentTypeValue: string, finalUrl?: string): OpenApiSource {
  return {
    source: decodeSource(bytes),
    format: sourceFormat(contentTypeValue),
    contentType: contentTypeValue,
    evidenceReference: `urn:sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sizeBytes: bytes.byteLength,
    ...(finalUrl ? { finalUrl } : {}),
  };
}

async function readBoundedBody(response: OpenApiFetchResponse, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = header(response.headers, "content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await discardBody(response.body);
    throw new Error("OPENAPI_RESPONSE_TOO_LARGE");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try { next = await iterator.next(); }
      catch {
        if (signal.aborted) throw signal.reason;
        throw new Error("OPENAPI_FETCH_FAILED");
      }
      if (next.done) break;
      const chunk = next.value;
      if (signal.aborted) throw signal.reason;
      if (!(chunk instanceof Uint8Array)) throw new Error("OPENAPI_TRANSPORT_POLICY_VIOLATION");
      length += chunk.byteLength;
      if (length > maximum) throw new Error("OPENAPI_RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
  } finally {
    try { await iterator.return?.(); } catch { /* transport cleanup cannot weaken the primary policy result */ }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function discardBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  try { await body[Symbol.asyncIterator]().return?.(); } catch { /* best-effort transport cleanup */ }
}

function normalizedAddress(value: string): string {
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mappedIpv4) return mappedIpv4[1]!;
  if (!value.includes(":")) return value;
  try { return new URL(`https://[${value.replace(/^\[|\]$/g, "")}]`).hostname.replace(/^\[|\]$/g, ""); }
  catch { return value; }
}

async function assertVerifiedConnection(
  response: OpenApiFetchResponse,
  hostname: string,
  pinnedAddresses: readonly string[],
): Promise<void> {
  if (typeof response.connectedAddress !== "string") {
    await discardBody(response.body);
    throw new Error("OPENAPI_TRANSPORT_POLICY_VIOLATION");
  }
  if (!response.tls || response.tls.authorized !== true || response.tls.servername !== hostname
    || response.tls.protocol !== "TLSv1.2" && response.tls.protocol !== "TLSv1.3") {
    await discardBody(response.body);
    throw new Error("OPENAPI_TLS_VERIFICATION_FAILED");
  }
  const connectedAddress = normalizedAddress(response.connectedAddress);
  if (!validateResolvedAddress(connectedAddress).ok
    || !pinnedAddresses.some((address) => normalizedAddress(address) === connectedAddress)) {
    await discardBody(response.body);
    throw new Error("OPENAPI_DNS_REBINDING_BLOCKED");
  }
}

async function fetchWithinPolicy(urlValue: string, controls: OpenApiProviderControls, signal: AbortSignal): Promise<OpenApiSource> {
  const maximum = boundedInteger(controls.maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
  const maximumRedirects = boundedInteger(controls.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 10);
  const target = validateTargetUrl(urlValue);
  if (!target.ok) throw new Error(target.code === "PRIVATE_NETWORK_BLOCKED" ? "OPENAPI_SSRF_BLOCKED" : "OPENAPI_URL_BLOCKED");
  let current = new URL(urlValue);
  if (current.hash || current.search || current.href !== urlValue) throw new Error("OPENAPI_URL_BLOCKED");
  const allowedOrigin = current.origin;
  for (let redirects = 0; ; redirects += 1) {
    if (signal.aborted) throw signal.reason;
    const addressValues = await controls.resolver.resolve(current.hostname, signal);
    if (signal.aborted) throw signal.reason;
    if (!Array.isArray(addressValues) || addressValues.length === 0 || addressValues.length > 16
      || addressValues.some((address) => typeof address !== "string" || !validateResolvedAddress(address).ok)) {
      throw new Error("OPENAPI_SSRF_BLOCKED");
    }
    const pinnedAddresses = [...new Set(addressValues)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const response = await controls.transport.request({
      url: current.href,
      method: "GET",
      headers: { accept: "application/json, application/openapi+json, application/yaml, application/x-yaml, text/yaml" },
      pinnedAddresses,
      redirect: "manual",
      credentials: "omit",
      signal,
    });
    if (!response) throw new Error("OPENAPI_TRANSPORT_POLICY_VIOLATION");
    await assertVerifiedConnection(response, current.hostname, pinnedAddresses);
    if (response.url !== current.href || !Number.isInteger(response.status)) {
      throw new Error("OPENAPI_TRANSPORT_POLICY_VIOLATION");
    }
    if (response.status >= 300 && response.status <= 399) {
      await discardBody(response.body);
      if (redirects >= maximumRedirects) throw new Error("OPENAPI_REDIRECT_LIMIT_EXCEEDED");
      const location = header(response.headers, "location");
      if (!location) throw new Error("OPENAPI_TRANSPORT_POLICY_VIOLATION");
      let redirect: URL;
      try { redirect = new URL(location, current); } catch { throw new Error("OPENAPI_URL_BLOCKED"); }
      const validation = validateTargetUrl(redirect.href);
      if (!validation.ok) throw new Error(validation.code === "PRIVATE_NETWORK_BLOCKED" ? "OPENAPI_SSRF_BLOCKED" : "OPENAPI_URL_BLOCKED");
      if (redirect.origin !== allowedOrigin) throw new Error("OPENAPI_REDIRECT_ORIGIN_BLOCKED");
      if (redirect.hash || redirect.search) throw new Error("OPENAPI_URL_BLOCKED");
      current = redirect;
      continue;
    }
    if (response.status !== 200) {
      await discardBody(response.body);
      throw new Error("OPENAPI_FETCH_FAILED");
    }
    const responseContentType = contentType(response.headers);
    if (!responseContentType) {
      await discardBody(response.body);
      throw new Error("OPENAPI_CONTENT_TYPE_BLOCKED");
    }
    try { sourceFormat(responseContentType); } catch (error) {
      await discardBody(response.body);
      throw error;
    }
    const bytes = await readBoundedBody(response, maximum, signal);
    return immutableSource(bytes, responseContentType, current.href);
  }
}

export async function fetchOpenApiSource(url: string, controls: OpenApiProviderControls): Promise<OpenApiSource> {
  if (!controls?.resolver || !controls.transport) throw new Error("OPENAPI_PROVIDER_CONTROLS_REQUIRED");
  const timeoutMs = boundedInteger(controls.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 60_000);
  const controller = new AbortController();
  const timeoutError = new Error("OPENAPI_FETCH_TIMEOUT");
  const callerError = new Error("OPENAPI_FETCH_ABORTED");
  let rejectCaller!: (error: Error) => void;
  const callerCancellation = new Promise<never>((_resolve, reject) => { rejectCaller = reject; });
  const callerAbort = () => {
    controller.abort(callerError);
    rejectCaller(callerError);
  };
  if (controls.signal?.aborted) callerAbort();
  else controls.signal?.addEventListener("abort", callerAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchWithinPolicy(url, controls, controller.signal),
      callerCancellation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controls.signal?.removeEventListener("abort", callerAbort);
  }
}

export function loadPrivateOpenApiUpload(
  bytes: Uint8Array,
  contentTypeValue: string,
  maximumBytes = DEFAULT_MAX_BYTES,
): OpenApiSource {
  const maximum = boundedInteger(maximumBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
  if (!(bytes instanceof Uint8Array)) throw new Error("OPENAPI_UPLOAD_INVALID");
  if (bytes.byteLength > maximum) throw new Error("OPENAPI_RESPONSE_TOO_LARGE");
  const normalizedContentType = contentTypeValue.split(";", 1)[0]!.trim().toLowerCase();
  sourceFormat(normalizedContentType);
  return immutableSource(bytes, normalizedContentType);
}
