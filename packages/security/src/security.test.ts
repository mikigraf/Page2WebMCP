import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoveryFirewall, sanitizeEvidence, validateRedirectChain, validateTargetUrl } from "./security.ts";

test("security policy rejects unsafe targets and mutations during discovery", () => {
  assert.equal(validateTargetUrl("http://127.0.0.1:3000").ok, false);
  assert.deepEqual(createDiscoveryFirewall(["https://acme.example"]).decide({ method: "POST", url: "https://acme.example/api/tickets" }), { allow: false, code: "MUTATION_BLOCKED" });
});

test("redirect chains revalidate every target instead of trusting the initial URL", () => {
  assert.deepEqual(validateRedirectChain(["https://acme.example", "https://cdn.acme.example/path"]), { ok: true });
  assert.deepEqual(validateRedirectChain(["https://acme.example", "https://127.0.0.1/admin"]), { ok: false, code: "PRIVATE_NETWORK_BLOCKED" });
  assert.deepEqual(validateRedirectChain(["https://acme.example", "https://user:password@cdn.acme.example/path"]), { ok: false, code: "EMBEDDED_CREDENTIALS_BLOCKED" });
});

test("evidence sanitization removes credential values recursively", () => {
  const sanitized = sanitizeEvidence({ authorization: "Bearer canary", request: { cookie: "session=canary", value: "safe" } });
  assert.equal(JSON.stringify(sanitized).includes("canary"), false);
  assert.equal((sanitized.request as { value: string }).value, "safe");
});
