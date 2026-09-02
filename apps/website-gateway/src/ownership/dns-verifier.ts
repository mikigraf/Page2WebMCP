import { Resolver } from "node:dns/promises";
import type { OwnershipChallenge, OwnershipVerifier } from "../stores/ownership.ts";

const MAX_RECORDS = 100;

function dnsProof(challenge: OwnershipChallenge): string {
  return `page2webmcp-verification=${challenge.token};origin=${challenge.targetOrigin};expires=${challenge.expiresAt}`;
}

/**
 * Verifies a `_page2webmcp` TXT record for the challenge origin. The proof text
 * is exactly the one the worker's own ownership verifier recomputes, so a
 * challenge this control marks verified is one the worker can re-prove itself.
 */
export function createDnsOwnershipVerifier(): OwnershipVerifier {
  return {
    async verify(challenge, signal) {
      if (challenge.method !== "dns_txt") return { verified: false, reason: "OWNERSHIP_METHOD_UNSUPPORTED" };
      let hostname: string;
      try { hostname = new URL(challenge.targetOrigin).hostname; }
      catch { return { verified: false, reason: "OWNERSHIP_ORIGIN_INVALID" }; }
      const resolver = new Resolver({ timeout: 2_000, tries: 2 });
      const abort = () => resolver.cancel();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const records = await resolver.resolveTxt(`_page2webmcp.${hostname}`);
        if (!Array.isArray(records) || records.length > MAX_RECORDS) {
          return { verified: false, reason: "OWNERSHIP_PROOF_INVALID" };
        }
        const expected = dnsProof(challenge);
        return records.some((record) => Array.isArray(record) && record.join("") === expected)
          ? { verified: true }
          : { verified: false, reason: "OWNERSHIP_PROOF_MISSING" };
      } catch {
        return { verified: false, reason: "OWNERSHIP_DNS_RESOLUTION_FAILED" };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
