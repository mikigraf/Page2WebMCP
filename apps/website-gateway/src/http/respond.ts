import type { ServerResponse } from "node:http";
import { MAX_CONTROL_BYTES } from "../constants.ts";
import { unavailable } from "../errors.ts";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  const encoded = JSON.stringify(payload);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_BYTES) {
    respondJson(response, 503, { error: unavailable("GATEWAY_RESPONSE_TOO_LARGE").message });
    return;
  }
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(encoded, "utf8")),
  });
  response.end(encoded);
}

export function respondHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "content-length": String(Buffer.byteLength(html, "utf8")),
  });
  response.end(html);
}
