import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_CREDENTIAL_BYTES = 8_192;
const MAX_CONTROL_RESPONSE_BYTES = 1_048_576;
// Candidate verification drives a real browser in the release verifier and
// routinely takes longer than twenty seconds, so the operator's deadline has to
// outlast it or the command aborts a request the server is completing.
export const PRODUCTION_CONTROL_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = PRODUCTION_CONTROL_REQUEST_TIMEOUT_MS;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const API_PATH = /^\/api\/[A-Za-z0-9_./-]+$/;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export type ProductionOperatorCredentials = Readonly<{ email: string; password: string }>;

export async function readProductionOperatorCredentials(path: string | undefined): Promise<ProductionOperatorCredentials> {
  if (!path || path.length > 4_096 || /[\r\n]/.test(path)) {
    throw new Error("PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED");
  }
  let bytes: Buffer;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600
        || metadata.size < 2 || metadata.size > MAX_CREDENTIAL_BYTES
        || typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error("INVALID");
      }
      const bounded = Buffer.allocUnsafe(MAX_CREDENTIAL_BYTES + 1);
      const { bytesRead } = await handle.read(bounded, 0, bounded.byteLength, 0);
      const after = await handle.stat();
      if (bytesRead !== metadata.size || after.dev !== metadata.dev || after.ino !== metadata.ino
        || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs
        || after.ctimeMs !== metadata.ctimeMs) throw new Error("INVALID");
      bytes = Buffer.from(bounded.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED");
  }
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED"); }
  if (!plainRecord(value) || Object.keys(value).sort().join("\0") !== "email\0password"
    || typeof value.email !== "string" || value.email.length < 3 || value.email.length > 254
    || value.email.trim() !== value.email || /[\s\r\n]/.test(value.email) || !value.email.includes("@")
    || typeof value.password !== "string" || value.password.length < 8 || value.password.length > 4_096
    || /[\r\n]/.test(value.password)) {
    throw new Error("PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED");
  }
  return Object.freeze({ email: value.email, password: value.password });
}

export class ProductionLiveControlSession {
  readonly #origin: string;
  readonly #transport: typeof fetch;
  readonly #cookies = new Map<string, string>();

  constructor(origin: string, dependencies: Readonly<{ fetch?: typeof fetch }> = {}) {
    if (!exactHttpsOrigin(origin) || dependencies.fetch !== undefined && typeof dependencies.fetch !== "function") {
      throw new Error("PRODUCTION_CONTROL_SESSION_CONFIGURATION_REQUIRED");
    }
    this.#origin = origin;
    this.#transport = dependencies.fetch ?? fetch;
  }

  async login(credentials: ProductionOperatorCredentials): Promise<unknown> {
    if (!credentials || typeof credentials.email !== "string" || typeof credentials.password !== "string") {
      throw new Error("PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED");
    }
    const key = `live-login:${createHash("sha256").update(credentials.email, "utf8").digest("hex")}`;
    return this.#mutation("/api/auth/login", credentials, key, false);
  }

  async get<T>(path: string): Promise<T> {
    return this.#request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
    return this.#mutation<T>(path, body, idempotencyKey, true);
  }

  async #mutation<T>(path: string, body: unknown, idempotencyKey: string, authenticated: boolean): Promise<T> {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new Error("PRODUCTION_CONTROL_IDEMPOTENCY_INVALID");
    const csrf = await this.get<{ csrfToken: unknown }>(authenticated ? "/api/auth/session" : "/api/auth/csrf");
    if (typeof csrf.csrfToken !== "string" || !/^v1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(csrf.csrfToken)) {
      throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID");
    }
    return this.#request<T>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-csrf-token": csrf.csrfToken,
      },
      body: JSON.stringify(body),
    });
  }

  async #request<T>(path: string, init: RequestInit): Promise<T> {
    if (!API_PATH.test(path)) throw new Error("PRODUCTION_CONTROL_REQUEST_INVALID");
    const url = `${this.#origin}${path}`;
    const headers = new Headers(init.headers);
    headers.set("origin", this.#origin);
    headers.set("sec-fetch-site", "same-origin");
    const cookie = [...this.#cookies].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) headers.set("cookie", cookie);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("PRODUCTION_CONTROL_REQUEST_TIMEOUT")), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let response: Response;
    try {
      response = await this.#transport(url, { ...init, headers, redirect: "error", signal: controller.signal });
    } catch {
      throw new Error("PRODUCTION_CONTROL_REQUEST_FAILED");
    } finally { clearTimeout(timer); }
    if (response.url !== url || response.redirected
      || !/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID");
    }
    this.#absorbCookies(response.headers);
    const bytes = await boundedBody(response);
    let value: unknown;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID"); }
    if (!response.ok) {
      const code = plainRecord(value) && typeof value.code === "string" && /^[A-Z0-9_]{1,80}$/.test(value.code)
        ? value.code : `CONTROL_HTTP_${response.status}`;
      throw new Error(code);
    }
    return value as T;
  }

  #absorbCookies(headers: Headers): void {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    const serialized = extended.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
    for (const value of serialized) {
      if (Buffer.byteLength(value, "utf8") > 8_192) throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID");
      const pair = value.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      const name = separator > 0 ? pair.slice(0, separator) : "";
      const cookieValue = separator > 0 ? pair.slice(separator + 1) : "";
      if (!COOKIE_NAME.test(name) || cookieValue.length > 4_096 || /[\r\n;]/.test(cookieValue)) {
        throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID");
      }
      if (/Max-Age=0(?:;|$)/i.test(value)) this.#cookies.delete(name);
      else {
        if (!this.#cookies.has(name) && this.#cookies.size >= 32) throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID");
        this.#cookies.set(name, cookieValue);
      }
    }
  }
}

async function boundedBody(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CONTROL_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("PRODUCTION_CONTROL_RESPONSE_INVALID");
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { try { reader.releaseLock(); } catch { /* already cancelled */ } }
  return Buffer.concat(chunks, size);
}

function exactHttpsOrigin(value: string): boolean {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.pathname === "/"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
