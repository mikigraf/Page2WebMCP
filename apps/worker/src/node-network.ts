import { Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { validateResolvedAddress } from "../../../packages/security/src/security.ts";
import type { OpenApiProviderControls } from "../../../packages/providers/src/openapi.ts";

const MAX_DNS_ANSWERS_PLUS_ONE = 17;
const DEFAULT_MAX_JSON_REQUEST_BYTES = 64 * 1_024;
const MAX_JSON_REQUEST_BYTES = 160 * 1_024;
const MAX_JSON_RESPONSE_BYTES = 64 * 1_024;
const MAX_PINNED_HEADER_COUNT = 16;
const MAX_PINNED_HEADER_VALUE_BYTES = 4_096;
const MAX_PINNED_AUTHORIZATION_BYTES = "Bearer ".length + 4_096;
const MAX_PINNED_HEADER_BYTES = 16 * 1_024;

type ResolverBoundary = Readonly<{
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
  cancel(): void;
}>;

export type NodeHttpsRequest = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;
type NodeLookupFunction = NonNullable<RequestOptions["lookup"]>;

type NodePinnedJsonRequestBase = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}>;

export type NodePinnedJsonRequest = NodePinnedJsonRequestBase & (
  | Readonly<{ method: "GET"; body?: never; maxBodyBytes?: never }>
  | Readonly<{ method: "POST"; body: string; maxBodyBytes?: number }>
);

export type NodePinnedJsonResponse = Readonly<{
  status: number;
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

export type NodePinnedJsonTransport = Readonly<{
  request(input: NodePinnedJsonRequest): Promise<NodePinnedJsonResponse>;
}>;

type PinnedJsonResolver = Readonly<{
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
}>;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("OPENAPI_FETCH_ABORTED");
}

function isNoDnsRecords(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && (error.code === "ENODATA" || error.code === "ENOTFOUND");
}

function normalizedAddress(value: string): string {
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mappedIpv4) return mappedIpv4[1]!;
  if (!value.includes(":")) return value;
  try { return new URL(`https://[${value.replace(/^\[|\]$/g, "")}]`).hostname.replace(/^\[|\]$/g, ""); }
  catch { return value; }
}

export function createNodeOpenApiResolver(
  dependencies: Readonly<{ createResolver: () => ResolverBoundary }> = {
    createResolver: () => new Resolver({ timeout: 2_000, tries: 2 }),
  },
): OpenApiProviderControls["resolver"] {
  if (!dependencies || typeof dependencies.createResolver !== "function") {
    throw new Error("OPENAPI_LIVE_CONFIGURATION_REQUIRED");
  }
  return {
    async resolve(hostname, signal) {
      if (signal.aborted) throw abortReason(signal);
      const resolver = dependencies.createResolver();
      if (!resolver || typeof resolver.resolve4 !== "function" || typeof resolver.resolve6 !== "function"
        || typeof resolver.cancel !== "function") throw new Error("OPENAPI_LIVE_CONFIGURATION_REQUIRED");
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => {
        try { resolver.cancel(); } catch { /* cancellation is best effort */ }
        rejectAbort(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", onAbort);
        try { resolver.cancel(); } catch { /* cancellation is best effort */ }
        throw abortReason(signal);
      }
      try {
        const settled = await Promise.race([
          Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]),
          aborted,
        ]);
        if (settled.some((result) => result.status === "rejected" && !isNoDnsRecords(result.reason))) {
          throw new Error("OPENAPI_DNS_RESOLUTION_FAILED");
        }
        const answers: string[] = [];
        for (const result of settled) {
          if (result.status !== "fulfilled") continue;
          for (const address of result.value) {
            answers.push(address);
            if (answers.length === MAX_DNS_ANSWERS_PLUS_ONE) return answers;
          }
        }
        return answers;
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (error instanceof Error && error.message === "OPENAPI_DNS_RESOLUTION_FAILED") throw error;
        throw new Error("OPENAPI_DNS_RESOLUTION_FAILED");
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function lookupFor(hostname: string, pinnedAddresses: readonly string[]): NodeLookupFunction {
  const values: LookupAddress[] = pinnedAddresses.map((address) => ({ address, family: isIP(address) as 4 | 6 }));
  return ((requestedHostname: string, options: unknown, callback: (...values: unknown[]) => void) => {
    if (requestedHostname !== hostname) {
      callback(new Error("OPENAPI_PINNED_ADDRESS_UNAVAILABLE"));
      return;
    }
    const all = typeof options === "object" && options !== null && "all" in options && options.all === true;
    const family = typeof options === "number" ? options
      : typeof options === "object" && options !== null && "family" in options ? options.family : 0;
    const eligible = family === 4 || family === 6 ? values.filter((value) => value.family === family) : values;
    if (eligible.length === 0) {
      callback(new Error("OPENAPI_PINNED_ADDRESS_UNAVAILABLE"));
      return;
    }
    if (all) callback(null, eligible);
    else callback(null, eligible[0]!.address, eligible[0]!.family);
  }) as NodeLookupFunction;
}

function normalizedHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value)) result[name] = value.join(", ");
  }
  return result;
}

function websiteAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.message === "WEBSITE_CONTROL_TIMEOUT"
    ? new Error("WEBSITE_CONTROL_TIMEOUT")
    : new Error("WEBSITE_CONTROL_ABORTED");
}

function validPinnedJsonRequest(input: NodePinnedJsonRequest): URL | undefined {
  const maxBodyBytes = input?.maxBodyBytes ?? DEFAULT_MAX_JSON_REQUEST_BYTES;
  const validBody = input?.method === "GET"
    ? input.body === undefined && input.maxBodyBytes === undefined
    : input?.method === "POST" && typeof input.body === "string"
      && Buffer.byteLength(input.body, "utf8") <= maxBodyBytes;
  if (!input || !validBody
    || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_JSON_REQUEST_BYTES
    || !input.headers || !validPinnedJsonHeaders(input.headers)) return undefined;
  try {
    const url = new URL(input.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return url;
  } catch { return undefined; }
}

function validPinnedJsonHeaders(headers: Readonly<Record<string, string>>): boolean {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return false;
  const entries = Object.entries(headers);
  if (entries.length === 0 || entries.length > MAX_PINNED_HEADER_COUNT) return false;
  let totalBytes = 0;
  for (const [name, value] of entries) {
    if (!/^[a-z0-9-]+$/.test(name) || typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      return false;
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    const valueLimit = name === "authorization" ? MAX_PINNED_AUTHORIZATION_BYTES : MAX_PINNED_HEADER_VALUE_BYTES;
    if (valueBytes > valueLimit) return false;
    totalBytes += Buffer.byteLength(name, "utf8") + valueBytes;
    if (totalBytes > MAX_PINNED_HEADER_BYTES) return false;
  }
  return true;
}

/** Resolves and validates every address before constructing a credential-bearing HTTPS request. */
export function createNodePinnedJsonTransport(
  dependencies: Readonly<{ resolver: PinnedJsonResolver; request: NodeHttpsRequest }> = {
    resolver: createNodeOpenApiResolver(),
    request: httpsRequest,
  },
): NodePinnedJsonTransport {
  if (!dependencies || typeof dependencies.resolver?.resolve !== "function"
    || typeof dependencies.request !== "function") throw new Error("WEBSITE_LIVE_CONFIGURATION_REQUIRED");
  return {
    async request(input) {
      const url = validPinnedJsonRequest(input);
      if (!url) throw new Error("WEBSITE_CONTROL_REQUEST_INVALID");
      if (input.signal.aborted) throw websiteAbortReason(input.signal);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      let resolved: readonly string[];
      try { resolved = await dependencies.resolver.resolve(hostname, input.signal); }
      catch {
        if (input.signal.aborted) throw websiteAbortReason(input.signal);
        throw new Error("WEBSITE_CONTROL_RETRYABLE");
      }
      if (resolved.length === 0) throw new Error("WEBSITE_CONTROL_RETRYABLE");
      if (resolved.length > 16 || resolved.some((address) => typeof address !== "string"
        || !validateResolvedAddress(normalizedAddress(address)).ok)) {
        throw new Error("WEBSITE_CONTROL_HOST_BLOCKED");
      }
      const pins = [...new Set(resolved.map(normalizedAddress))];
      if (pins.length === 0 || pins.length > 16) throw new Error("WEBSITE_CONTROL_HOST_BLOCKED");
      return await new Promise<NodePinnedJsonResponse>((resolve, reject) => {
        let request: ClientRequest;
        let activeResponse: IncomingMessage | undefined;
        let activeSocket: TLSSocket | undefined;
        let settled = false;
        let bodySent = false;
        const finishReject = (error: Error) => {
          if (settled) return;
          settled = true;
          input.signal.removeEventListener("abort", onAbort);
          reject(error);
        };
        const destroy = (error: Error) => {
          activeResponse?.once("error", () => undefined);
          activeResponse?.destroy(error);
          activeSocket?.destroy(error);
          request?.destroy(error);
        };
        const onAbort = () => {
          const error = websiteAbortReason(input.signal);
          destroy(error);
          finishReject(error);
        };
        const validatePeer = (socket: TLSSocket): Error | undefined => {
          const connectedAddress = normalizedAddress(socket.remoteAddress ?? "");
          const protocol = typeof socket.getProtocol === "function" ? socket.getProtocol() : null;
          const servername = typeof socket.servername === "string" ? socket.servername : "";
          if (socket.authorized !== true || servername !== hostname
            || (protocol !== "TLSv1.2" && protocol !== "TLSv1.3")) return new Error("WEBSITE_CONTROL_TLS_FAILED");
          if (!validateResolvedAddress(connectedAddress).ok || !pins.includes(connectedAddress)) {
            return new Error("WEBSITE_CONTROL_HOST_BLOCKED");
          }
          return undefined;
        };
        try {
          request = dependencies.request(url, {
            method: input.method,
            headers: {
              ...input.headers,
              ...(input.method === "POST"
                ? { "content-length": String(Buffer.byteLength(input.body, "utf8")) }
                : {}),
            },
            agent: false,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            servername: hostname,
            lookup: lookupFor(hostname, pins),
          }, (response) => {
            activeResponse = response;
            const socket = response.socket as TLSSocket;
            activeSocket = socket;
            const peerError = validatePeer(socket);
            if (peerError) {
              destroy(peerError);
              finishReject(peerError);
              return;
            }
            const declared = response.headers["content-length"];
            if (typeof declared === "string"
              && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_RESPONSE_BYTES)) {
              const error = new Error("WEBSITE_CONTROL_RESPONSE_TOO_LARGE");
              destroy(error);
              finishReject(error);
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0;
            response.on("data", (chunk: Buffer | Uint8Array | string) => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              length += bytes.byteLength;
              if (length > MAX_JSON_RESPONSE_BYTES) {
                const error = new Error("WEBSITE_CONTROL_RESPONSE_TOO_LARGE");
                destroy(error);
                finishReject(error);
                return;
              }
              chunks.push(bytes);
            });
            response.once("error", () => {
              if (!settled) finishReject(input.signal.aborted
                ? websiteAbortReason(input.signal) : new Error("WEBSITE_CONTROL_RETRYABLE"));
            });
            response.once("end", () => {
              if (settled) return;
              settled = true;
              input.signal.removeEventListener("abort", onAbort);
              resolve({
                status: response.statusCode ?? 0,
                url: input.url,
                headers: normalizedHeaders(response.headers),
                body: Buffer.concat(chunks, length),
              });
            });
          });
        } catch {
          finishReject(new Error("WEBSITE_CONTROL_RETRYABLE"));
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
        request.once("socket", (socket) => {
          activeSocket = socket as TLSSocket;
          socket.once("secureConnect", () => {
            if (settled || bodySent) return;
            const peerError = validatePeer(socket as TLSSocket);
            if (peerError) {
              destroy(peerError);
              finishReject(peerError);
              return;
            }
            bodySent = true;
            request.end(input.method === "POST" ? input.body : undefined);
          });
        });
        request.once("error", (error) => {
          if (settled) return;
          if (input.signal.aborted) finishReject(websiteAbortReason(input.signal));
          else {
            const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
            finishReject(/^(?:CERT_|ERR_TLS_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_)/.test(code)
              ? new Error("WEBSITE_CONTROL_TLS_FAILED") : new Error("WEBSITE_CONTROL_RETRYABLE"));
          }
        });
        if (input.signal.aborted) onAbort();
      });
    },
  };
}

function stableTransportError(error: unknown): Error {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (/^(?:CERT_|ERR_TLS_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_)/.test(code)) {
    return new Error("OPENAPI_TLS_VERIFICATION_FAILED");
  }
  return new Error("OPENAPI_FETCH_FAILED");
}

function validTransportRequest(request: Parameters<OpenApiProviderControls["transport"]["request"]>[0]): URL | undefined {
  if (!request || request.method !== "GET" || request.redirect !== "manual" || request.credentials !== "omit"
    || !request.headers || Object.keys(request.headers).length !== 1 || typeof request.headers.accept !== "string"
    || request.headers.accept.length === 0 || !Array.isArray(request.pinnedAddresses)
    || request.pinnedAddresses.length === 0 || request.pinnedAddresses.length > 16
    || request.pinnedAddresses.some((address) => typeof address !== "string" || !validateResolvedAddress(address).ok)) return undefined;
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
}

export function createNodeOpenApiTransport(
  dependencies: Readonly<{ request: NodeHttpsRequest }> = { request: httpsRequest },
): OpenApiProviderControls["transport"] {
  if (!dependencies || typeof dependencies.request !== "function") {
    throw new Error("OPENAPI_LIVE_CONFIGURATION_REQUIRED");
  }
  return {
    request(input) {
      const url = validTransportRequest(input);
      if (!url) return Promise.reject(new Error("OPENAPI_TRANSPORT_POLICY_VIOLATION"));
      if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const pins = input.pinnedAddresses.map(normalizedAddress);
      return new Promise((resolve, reject) => {
        let responseReceived = false;
        let settled = false;
        let request: ClientRequest;
        let activeResponse: IncomingMessage | undefined;
        let activeSocket: TLSSocket | undefined;
        const finishReject = (error: Error) => {
          if (settled) return;
          settled = true;
          input.signal.removeEventListener("abort", onAbort);
          reject(error);
        };
        const onAbort = () => {
          const error = abortReason(input.signal);
          activeResponse?.once("error", () => undefined);
          activeResponse?.destroy(error);
          activeSocket?.destroy(error);
          request?.destroy(error);
          finishReject(error);
        };
        try {
          request = dependencies.request(url, {
            method: "GET",
            headers: { accept: input.headers.accept },
            agent: false,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            servername: hostname,
            lookup: lookupFor(hostname, pins),
          }, (response) => {
            responseReceived = true;
            const socket = response.socket as TLSSocket;
            activeResponse = response;
            activeSocket = socket;
            const connectedAddress = normalizedAddress(socket.remoteAddress ?? "");
            const protocol = typeof socket.getProtocol === "function" ? socket.getProtocol() : null;
            const servername = typeof socket.servername === "string" ? socket.servername : "";
            const tlsValid = socket.authorized === true && servername === hostname
              && (protocol === "TLSv1.2" || protocol === "TLSv1.3");
            const peerValid = validateResolvedAddress(connectedAddress).ok && pins.includes(connectedAddress);
            if (!tlsValid || !peerValid) {
              const error = new Error(tlsValid ? "OPENAPI_DNS_REBINDING_BLOCKED" : "OPENAPI_TLS_VERIFICATION_FAILED");
              response.once("error", () => undefined);
              response.destroy(error);
              request.destroy(error);
              finishReject(error);
              return;
            }
            response.once("close", () => input.signal.removeEventListener("abort", onAbort));
            settled = true;
            resolve({
              status: response.statusCode ?? 0,
              url: input.url,
              connectedAddress,
              tls: { authorized: socket.authorized, servername, protocol },
              headers: normalizedHeaders(response.headers),
              body: response,
            });
          });
        } catch {
          finishReject(new Error("OPENAPI_FETCH_FAILED"));
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
        request.once("error", (error) => {
          if (input.signal.aborted) finishReject(abortReason(input.signal));
          else if (!responseReceived) finishReject(stableTransportError(error));
        });
        if (input.signal.aborted) {
          onAbort();
          return;
        }
        request.end();
      });
    },
  };
}
