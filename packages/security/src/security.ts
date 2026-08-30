export type JsonRecord = { [key: string]: unknown };

const sensitiveKey = /authorization|cookie|password|token|secret|csrf|otp|session|api[-_]?key|credentials|private[-_]?key/i;
const sensitiveValue = /(?:authorization|cookie|password|token|secret|csrf|otp|session)\s*[:=]|\bbearer\s+\S+/i;
const MAX_EVIDENCE_DEPTH = 12;
const MAX_EVIDENCE_NODES = 1_000;
const MAX_EVIDENCE_ITEMS = 10_000;
const MAX_EVIDENCE_STRING_LENGTH = 4_096;
const MAX_EVIDENCE_OUTPUT_CHARS = 35_000;

function isBlockedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second, third] = octets;
  return first === 0 || first === 10 || first === 100 && second >= 64 && second <= 127 || first === 127 ||
    first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 ||
    first === 192 && (second === 168 || second === 0 && (third === 0 || third === 2) || second === 88 && third === 99) ||
    first === 198 && (second === 18 || second === 19 || second === 51 && third === 100) ||
    first === 203 && second === 0 && third === 113 || first >= 224;
}

function parseIpv6(hostname: string): number[] | undefined {
  const value = hostname.replace(/^\[|\]$/g, "");
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.concat(right).some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
  const omitted = 8 - left.length - right.length;
  if (halves.length === 1 ? omitted !== 0 : omitted < 1) return undefined;
  return [...left, ...Array(omitted).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
}

function isBlockedIpv6(hostname: string): boolean {
  const parts = parseIpv6(hostname);
  if (!parts) return false;
  if (parts.every((part) => part === 0) || parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return true;
  if ((parts[0] & 0xfe00) === 0xfc00 || (parts[0] & 0xffc0) === 0xfe80 || (parts[0] & 0xff00) === 0xff00) return true;
  // Permit only ordinary global-unicast space and exclude transition/documentation ranges.
  if ((parts[0] & 0xe000) !== 0x2000 || parts[0] === 0x2002
    || parts[0] === 0x2001 && (parts[1] === 0 || parts[1] === 0x10 || parts[1] === 0x0db8)) return true;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff || parts.slice(0, 6).every((part) => part === 0)) {
    return isBlockedIpv4(`${parts[6] >>> 8}.${parts[6] & 0xff}.${parts[7] >>> 8}.${parts[7] & 0xff}`);
  }
  return false;
}

function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return host === "localhost" || host.endsWith(".localhost") || isBlockedIpv4(host) || isBlockedIpv6(host);
}

export function validateResolvedAddress(value: string): { ok: boolean; code?: string } {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = normalized.split(".");
  const validIpv4 = ipv4.length === 4
    && ipv4.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  const validIpv6 = normalized.includes(":") && parseIpv6(normalized) !== undefined;
  if (!validIpv4 && !validIpv6) return { ok: false, code: "INVALID_RESOLVED_ADDRESS" };
  if (isPrivateOrReservedHost(normalized)) return { ok: false, code: "PRIVATE_NETWORK_BLOCKED" };
  return { ok: true };
}

export function validateTargetUrl(value: string): { ok: boolean; code?: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, code: "INVALID_URL" }; }
  if (url.protocol !== "https:") return { ok: false, code: "HTTPS_REQUIRED" };
  if (isPrivateOrReservedHost(url.hostname)) return { ok: false, code: "PRIVATE_NETWORK_BLOCKED" };
  if (url.username || url.password) return { ok: false, code: "EMBEDDED_CREDENTIALS_BLOCKED" };
  return { ok: true };
}

export function validateRedirectChain(targets: string[]): { ok: boolean; code?: string } {
  if (targets.length === 0) return { ok: false, code: "INVALID_URL" };
  for (const target of targets) {
    const result = validateTargetUrl(target);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function createDiscoveryFirewall(origins: string[]) {
  const allowed = new Set(origins);
  return {
    decide(request: {
      method: string;
      url: string;
      kind?: "document" | "subresource" | "download" | "upload" | "tool";
      tool?: string;
      pageText?: string;
    }): { allow: boolean; code?: string } {
      const target = validateTargetUrl(request.url);
      if (!target.ok) return { allow: false, code: target.code };
      let origin: string;
      try { origin = new URL(request.url).origin; } catch { return { allow: false, code: "INVALID_URL" }; }
      if (!allowed.has(origin)) return { allow: false, code: "ORIGIN_BLOCKED" };
      if (request.kind === "download") return { allow: false, code: "DOWNLOAD_BLOCKED" };
      if (request.kind === "upload") return { allow: false, code: "UPLOAD_BLOCKED" };
      if (request.kind === "tool") return { allow: false, code: "TOOL_BLOCKED" };
      if (!["GET", "HEAD"].includes(request.method)) return { allow: false, code: "MUTATION_BLOCKED" };
      return { allow: true };
    }
  };
}

export function sanitizeEvidence(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const seen = new WeakSet<object>();
  let nodes = 0;
  let items = 0;
  let outputChars = 0;
  const marker = (value: string): string => {
    outputChars += value.length;
    return value;
  };
  const sanitize = (current: unknown, depth: number): unknown => {
    if (outputChars >= MAX_EVIDENCE_OUTPUT_CHARS) return marker("[TRUNCATED]");
    if (depth > MAX_EVIDENCE_DEPTH) return marker("[REDACTED_DEPTH]");
    if (typeof current === "string") {
      if (sensitiveValue.test(current)) return marker("[REDACTED]");
      const safe = current.length > MAX_EVIDENCE_STRING_LENGTH ? `${current.slice(0, MAX_EVIDENCE_STRING_LENGTH)}[TRUNCATED]` : current;
      outputChars += safe.length;
      return outputChars > MAX_EVIDENCE_OUTPUT_CHARS ? marker("[TRUNCATED]") : safe;
    }
    if (typeof current === "bigint" || typeof current === "symbol" || typeof current === "function" || current === undefined || typeof current === "number" && !Number.isFinite(current)) return marker("[UNSUPPORTED_VALUE]");
    if (typeof current !== "object" || current === null) {
      outputChars += String(current).length;
      return outputChars > MAX_EVIDENCE_OUTPUT_CHARS ? marker("[TRUNCATED]") : current;
    }
    if (seen.has(current)) return marker("[REDACTED_CYCLE]");
    if (++nodes > MAX_EVIDENCE_NODES) return marker("[TRUNCATED]");
    seen.add(current);
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      outputChars += 2;
      for (const item of current) {
        if (++items > MAX_EVIDENCE_ITEMS || outputChars + 3 >= MAX_EVIDENCE_OUTPUT_CHARS) { result.push(marker("[TRUNCATED]")); break; }
        outputChars += 3;
        result.push(sanitize(item, depth + 1));
      }
      return result;
    }
    const result: JsonRecord = {};
    outputChars += 2;
    for (const [key, child] of Object.entries(current as JsonRecord)) {
      if (++items > MAX_EVIDENCE_ITEMS) return marker("[TRUNCATED]");
      outputChars += key.length + 4;
      if (outputChars > MAX_EVIDENCE_OUTPUT_CHARS) return marker("[TRUNCATED]");
      result[key] = sensitiveKey.test(key) ? marker("[REDACTED]") : sanitize(child, depth + 1);
    }
    return result;
  };
  const sanitized = sanitize(value, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized as JsonRecord : { _truncated: sanitized };
}
