import type { IncomingMessage } from "node:http";
import { MAX_CONTROL_BYTES } from "../constants.ts";
import { badRequest, tooLarge } from "../errors.ts";
import { isPlainRecord } from "../canonical.ts";

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && (!/^\d+$/.test(declared) || Number(declared) > MAX_CONTROL_BYTES)) {
    throw tooLarge("GATEWAY_REQUEST_TOO_LARGE");
  }
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw badRequest("GATEWAY_REQUEST_CONTENT_TYPE_INVALID");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_CONTROL_BYTES) throw tooLarge("GATEWAY_REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw badRequest("GATEWAY_REQUEST_BODY_INVALID"); }
  if (!isPlainRecord(parsed)) throw badRequest("GATEWAY_REQUEST_BODY_INVALID");
  return parsed;
}

export async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw badRequest("GATEWAY_REQUEST_CONTENT_TYPE_INVALID");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > 4_096) throw tooLarge("GATEWAY_REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
