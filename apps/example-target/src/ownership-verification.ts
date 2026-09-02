const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_CONTENT_LENGTH = 1_024;

/**
 * Returns the exact `.well-known/page2webmcp-verification.txt` body the control
 * plane issued for this site, or `null` when it is missing or malformed so the
 * route fails closed. The value may carry literal newlines or escaped `\n`,
 * because hosting dashboards differ in how they accept multi-line variables.
 */
export function parseOwnershipVerification(
  environment: Record<string, string | undefined>,
): string | null {
  const raw = environment.PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION;
  if (!raw || raw.length > MAX_CONTENT_LENGTH) return null;
  const lines = raw.replace(/\\n/g, "\n").replace(/\r/g, "").trimEnd().split("\n");
  if (lines.length !== 3) return null;
  const token = valueOf(lines[0], "page2webmcp-verification");
  const origin = valueOf(lines[1], "origin");
  const expires = valueOf(lines[2], "expires");
  if (!token || !origin || !expires || !TOKEN.test(token) || !httpsOrigin(origin) || !isoInstant(expires)) return null;
  return `page2webmcp-verification=${token}\norigin=${origin}\nexpires=${expires}\n`;
}

function valueOf(line: string, key: string): string | null {
  return line.startsWith(`${key}=`) ? line.slice(key.length + 1) : null;
}

function httpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function isoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
