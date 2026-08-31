import { Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { validateResolvedAddress } from "../../../packages/security/src/security.ts";
import type { OpenApiProviderControls } from "../../../packages/providers/src/openapi.ts";

const MAX_DNS_ANSWERS_PLUS_ONE = 17;

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
