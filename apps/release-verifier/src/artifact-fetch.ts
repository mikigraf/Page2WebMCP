import { createHash } from "node:crypto";

/**
 * A bounded, credential-free read of served artifact bytes, performed outside the browser so the
 * hash reflects what the origin serves rather than what the page claims.
 */
export type ServedArtifact = Readonly<{
  status: number;
  contentHash: string;
  byteLength: number;
}>;

export async function fetchServedArtifact(input: Readonly<{
  url: string;
  maxBytes: number;
  timeoutMs: number;
}>): Promise<ServedArtifact | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("ARTIFACT_FETCH_TIMEOUT")), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > input.maxBytes)) return undefined;
    const bytes = await boundedBytes(response, input.maxBytes);
    if (!bytes) return undefined;
    return Object.freeze({
      status: response.status,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel(new Error("ARTIFACT_TOO_LARGE"));
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
