export function unsafeSupabaseBrowserKey(value: string): boolean {
  if (!value || /service[_-]?role|sb_secret_/i.test(value)) return true;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    if (parts[1]!.length > 4_096) return true;
    const normalized = parts[1]!.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return !claims || typeof claims !== "object" || Array.isArray(claims)
      || (claims as { role?: unknown }).role !== "anon";
  } catch {
    return true;
  }
}
