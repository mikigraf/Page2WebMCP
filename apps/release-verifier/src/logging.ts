/**
 * Operator-only structured logging. Only identifiers, operation names, outcome codes, and
 * durations are ever written: never a token, a cookie, a credential, page content, artifact
 * source, or a URL with a query string.
 */

const SAFE_VALUE = /^[A-Za-z0-9_.:@/-]{0,200}$/;

export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export function logEvent(event: string, fields: LogFields = {}): void {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (!SAFE_VALUE.test(value)) continue;
      safe[key] = value;
    } else {
      safe[key] = value;
    }
  }
  const line = JSON.stringify({ event, at: new Date().toISOString(), ...safe });
  process.stdout.write(`${line}\n`);
}
