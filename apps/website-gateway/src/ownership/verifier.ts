import type { OwnershipVerifier } from "../stores/ownership.ts";
import { createDnsOwnershipVerifier } from "./dns-verifier.ts";
import { createWellKnownOwnershipVerifier } from "./well-known-verifier.ts";

/** Dispatches each check to the verifier for the method the challenge was issued with. */
export function createOwnershipVerifier(
  dependencies: Readonly<{ dns?: OwnershipVerifier; wellKnown?: OwnershipVerifier }> = {},
): OwnershipVerifier {
  const dns = dependencies.dns ?? createDnsOwnershipVerifier();
  const wellKnown = dependencies.wellKnown ?? createWellKnownOwnershipVerifier();
  return {
    verify(challenge, signal) {
      if (challenge.method === "dns_txt") return dns.verify(challenge, signal);
      if (challenge.method === "well_known") return wellKnown.verify(challenge, signal);
      return Promise.resolve({ verified: false, reason: "OWNERSHIP_METHOD_UNSUPPORTED" });
    },
  };
}
