import type { OwnershipChallenge, OwnershipVerifier } from "../stores/ownership.ts";

const MAX_PROOF_BYTES = 4_096;
const FETCH_TIMEOUT_MS = 5_000;
const WELL_KNOWN_PATH = "/.well-known/page2webmcp-verification.txt";

function wellKnownProof(challenge: OwnershipChallenge): string {
  return `page2webmcp-verification=${challenge.token}\norigin=${challenge.targetOrigin}\nexpires=${challenge.expiresAt}\n`;
}

function publicHttpsHostname(origin: string): string | undefined {
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.origin !== origin || host === "localhost" || host.endsWith(".localhost")
    || /^[\d.]+$/.test(host) || host.startsWith("[")) return undefined;
  return host;
}

/**
 * Verifies the `.well-known/page2webmcp-verification.txt` proof for the
 * challenge origin: exact HTTPS origin, no redirects, plain text, bounded size,
 * byte-exact content. The proof text is the one the worker's own ownership
 * verifier recomputes, so a challenge marked verified here can be re-proved.
 */
export function createWellKnownOwnershipVerifier(
  dependencies: Readonly<{ fetch?: typeof fetch }> = {},
): OwnershipVerifier {
  const transport = dependencies.fetch ?? fetch;
  return {
    async verify(challenge, signal) {
      if (challenge.method !== "well_known") return { verified: false, reason: "OWNERSHIP_METHOD_UNSUPPORTED" };
      if (!publicHttpsHostname(challenge.targetOrigin)) return { verified: false, reason: "OWNERSHIP_ORIGIN_INVALID" };
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await transport(`${challenge.targetOrigin}${WELL_KNOWN_PATH}`, {
          method: "GET",
          redirect: "error",
          headers: { accept: "text/plain" },
          signal: AbortSignal.any([signal, timeout]),
        });
      } catch {
        return { verified: false, reason: "OWNERSHIP_PROOF_FETCH_FAILED" };
      }
      try {
        const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
        if (response.status !== 200 || mediaType !== "text/plain") {
          return { verified: false, reason: "OWNERSHIP_PROOF_MISSING" };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_PROOF_BYTES) return { verified: false, reason: "OWNERSHIP_PROOF_INVALID" };
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { return { verified: false, reason: "OWNERSHIP_PROOF_INVALID" }; }
        return content === wellKnownProof(challenge)
          ? { verified: true }
          : { verified: false, reason: "OWNERSHIP_PROOF_INVALID" };
      } catch {
        return { verified: false, reason: "OWNERSHIP_PROOF_INVALID" };
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    },
  };
}
