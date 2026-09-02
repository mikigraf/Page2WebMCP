import assert from "node:assert/strict";
import test from "node:test";
import { createWellKnownOwnershipVerifier } from "../src/ownership/well-known-verifier.ts";
import { createOwnershipVerifier } from "../src/ownership/verifier.ts";
import type { OwnershipChallenge } from "../src/stores/ownership.ts";

const challenge: OwnershipChallenge = {
  method: "well_known",
  targetOrigin: "https://widgets.example",
  token: "A".repeat(48),
  expiresAt: "2026-09-01T12:15:00.000Z",
};
const PROOF = `page2webmcp-verification=${challenge.token}\norigin=${challenge.targetOrigin}\nexpires=${challenge.expiresAt}\n`;

function responder(status: number, body: string, contentType = "text/plain; charset=utf-8"): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://widgets.example/.well-known/page2webmcp-verification.txt");
    assert.equal(init?.redirect, "error");
    return new Response(body, { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
}

test("well-known verifier accepts only the exact proof served as plain text over https without redirects", async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await createWellKnownOwnershipVerifier({ fetch: responder(200, PROOF) }).verify(challenge, signal), { verified: true });
  for (const [name, transport] of [
    ["not found", responder(404, PROOF)],
    ["wrong content type", responder(200, PROOF, "text/html")],
    ["tampered token", responder(200, PROOF.replace("A", "B"))],
    ["trailing junk", responder(200, `${PROOF}extra\n`)],
    ["oversized", responder(200, `${"x".repeat(5_000)}`)],
    ["redirect refused", (async () => { throw new TypeError("redirect"); }) as typeof fetch],
  ] as const) {
    const outcome = await createWellKnownOwnershipVerifier({ fetch: transport }).verify(challenge, signal);
    assert.equal(outcome.verified, false, name);
  }
  const dns = await createWellKnownOwnershipVerifier({ fetch: responder(200, PROOF) })
    .verify({ ...challenge, method: "dns_txt" }, signal);
  assert.deepEqual(dns, { verified: false, reason: "OWNERSHIP_METHOD_UNSUPPORTED" });
  const loopback = await createWellKnownOwnershipVerifier({ fetch: responder(200, PROOF) })
    .verify({ ...challenge, targetOrigin: "https://127.0.0.1" }, signal);
  assert.deepEqual(loopback, { verified: false, reason: "OWNERSHIP_ORIGIN_INVALID" });
});

test("composite verifier dispatches on the challenge method", async () => {
  const calls: string[] = [];
  const verifier = createOwnershipVerifier({
    dns: { verify: async (c) => { calls.push(`dns:${c.method}`); return { verified: true }; } },
    wellKnown: { verify: async (c) => { calls.push(`wk:${c.method}`); return { verified: true }; } },
  });
  const signal = new AbortController().signal;
  await verifier.verify(challenge, signal);
  await verifier.verify({ ...challenge, method: "dns_txt" }, signal);
  assert.deepEqual(calls, ["wk:well_known", "dns:dns_txt"]);
});
