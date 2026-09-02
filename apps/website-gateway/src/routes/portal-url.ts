import { HANDOFF_PARAMETER } from "../constants.ts";

const PARAMETER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
/** The exact family of names the control plane's portal sanitizer forbids. */
const FORBIDDEN_PARAMETER =
  /token|secret|password|passcode|cookie|csrf|otp|credential|api[-_]?key|code|session|provider|live|cdp/i;

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.origin === value && url.href === `${value}/`;
  } catch { return false; }
}

/** Builds the only portal URL shape the control plane will accept, or nothing. */
export function portalUrlFor(origin: string, handoff: string, parameterName = "handoff"): string | undefined {
  if (!exactHttpsOrigin(origin)) return undefined;
  if (!PARAMETER_NAME.test(parameterName) || FORBIDDEN_PARAMETER.test(parameterName)) return undefined;
  if (!HANDOFF_PARAMETER.test(handoff)) return undefined;
  const candidate = `${origin}/portal?${parameterName}=${handoff}`;
  return safePortalUrl(candidate, origin);
}

/** Mirrors the control plane sanitizer so this service never emits a URL it would reject. */
export function safePortalUrl(value: string, origin: string): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash
      || url.pathname !== "/portal" || url.searchParams.size !== 1 || url.href !== value) return undefined;
    for (const [name, parameter] of url.searchParams) {
      if (name !== "handoff" || !PARAMETER_NAME.test(name) || FORBIDDEN_PARAMETER.test(name)
        || !HANDOFF_PARAMETER.test(parameter)) return undefined;
    }
    return url.toString();
  } catch { return undefined; }
}
