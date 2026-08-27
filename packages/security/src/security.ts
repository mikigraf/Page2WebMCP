export type JsonRecord = { [key: string]: unknown };
const sensitive = /authorization|cookie|password|token|secret|csrf|otp|session/i;

export function validateTargetUrl(value: string): { ok: boolean; code?: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, code: "INVALID_URL" }; }
  if (url.protocol !== "https:") return { ok: false, code: "HTTPS_REQUIRED" };
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname) || /^10\.|^192\.168\.|^169\.254\./.test(url.hostname)) return { ok: false, code: "PRIVATE_NETWORK_BLOCKED" };
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
    decide(request: { method: string; url: string }): { allow: boolean; code?: string } {
      const origin = new URL(request.url).origin;
      if (!allowed.has(origin)) return { allow: false, code: "ORIGIN_BLOCKED" };
      if (!["GET", "HEAD"].includes(request.method)) return { allow: false, code: "MUTATION_BLOCKED" };
      return { allow: true };
    }
  };
}

export function sanitizeEvidence(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as JsonRecord).flatMap(([key, current]) => {
    if (sensitive.test(key)) return [];
    if (current && typeof current === "object" && !Array.isArray(current)) return [[key, sanitizeEvidence(current)]];
    return [[key, current]];
  }));
}
