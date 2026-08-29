import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoveryFirewall, sanitizeEvidence, validateRedirectChain, validateTargetUrl } from "./security.ts";

test("security policy rejects unsafe targets and mutations during discovery", () => {
  assert.equal(validateTargetUrl("http://127.0.0.1:3000").ok, false);
  assert.deepEqual(createDiscoveryFirewall(["https://acme.example"]).decide({ method: "POST", url: "https://acme.example/api/tickets" }), { allow: false, code: "MUTATION_BLOCKED" });
});

test("target validation blocks loopback, non-public IPv4, and IPv6 literal addresses", () => {
  for (const target of [
    "https://127.23.45.67/", "https://10.0.0.1/", "https://172.16.0.1/", "https://192.168.0.1/", "https://169.254.0.1/",
    "https://0.0.0.0/", "https://224.0.0.1/", "https://[::]/", "https://[::1]/", "https://[fc00::1]/", "https://[fe80::1]/", "https://[ff00::1]/",
    "https://[::ffff:192.168.1.1]/", "https://[::127.0.0.1]/", "https://192.88.99.1/"
  ]) assert.deepEqual(validateTargetUrl(target), { ok: false, code: "PRIVATE_NETWORK_BLOCKED" });
});

test("target validation canonicalizes alternate IPv4 forms before applying the blocklist", () => {
  for (const target of ["https://127.1/", "https://2130706433/", "https://0x7f000001/", "https://0177.0.0.1/"]) {
    assert.deepEqual(validateTargetUrl(target), { ok: false, code: "PRIVATE_NETWORK_BLOCKED" });
  }
  assert.deepEqual(validateTargetUrl("https://198.51.100.4/"), { ok: false, code: "PRIVATE_NETWORK_BLOCKED" });
  assert.deepEqual(validateTargetUrl("https://8.8.8.8/"), { ok: true });
  assert.deepEqual(validateTargetUrl("https://198.51.101.4/"), { ok: true });
  assert.deepEqual(validateTargetUrl("https://203.0.114.4/"), { ok: true });
});

test("target validation normalizes trailing-dot localhost names", () => {
  assert.deepEqual(validateTargetUrl("https://localhost./"), { ok: false, code: "PRIVATE_NETWORK_BLOCKED" });
  assert.deepEqual(validateTargetUrl("https://LOCALHOST.../"), { ok: false, code: "PRIVATE_NETWORK_BLOCKED" });
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

test("evidence sanitization redacts nested arrays and safely bounds cyclic input", () => {
  const cyclic: Record<string, unknown> = { password: "canary", nested: [{ token: "canary", safe: "kept" }] };
  cyclic.self = cyclic;
  const sanitized = sanitizeEvidence(cyclic);
  assert.equal(JSON.stringify(sanitized).includes("canary"), false);
  assert.equal((sanitized.nested as Array<{ safe: string }>)[0].safe, "kept");
  assert.equal(sanitized.self, "[REDACTED_CYCLE]");
});

test("evidence sanitization redacts secret-bearing array strings and bounds output", () => {
  const sanitized = sanitizeEvidence({ events: ["Bearer canary", ...Array.from({ length: 100_000 }, () => "safe")] });
  assert.equal((sanitized.events as unknown[])[0], "[REDACTED]");
  assert.ok(JSON.stringify(sanitized).length <= 70_000);
});

test("evidence sanitization bounds arrays made entirely of redaction markers", () => {
  const sanitized = sanitizeEvidence({ events: Array.from({ length: 100_000 }, () => "Bearer canary") });
  assert.ok(JSON.stringify(sanitized).length <= 70_000);
});

test("evidence sanitization bounds arrays of empty strings", () => {
  const sanitized = sanitizeEvidence({ events: Array.from({ length: 100_000 }, () => "") });
  assert.ok(JSON.stringify(sanitized).length <= 70_000);
});

test("evidence sanitization preserves a record shape when the top level is truncated", () => {
  const sanitized = sanitizeEvidence(Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`field${index}`, "safe"])));
  assert.equal(Array.isArray(sanitized), false);
  assert.equal(typeof sanitized, "object");
});

test("evidence sanitization redacts common secret key variants and normalizes non-JSON values", () => {
  const sanitized = sanitizeEvidence({
    apiKey: "canary", api_key: "canary", "x-api-key": "canary", credentials: "canary", privateKey: "canary",
    count: 1n, marker: Symbol("canary"), callback: () => "canary"
  });
  assert.equal(JSON.stringify(sanitized).includes("canary"), false);
  assert.deepEqual([sanitized.count, sanitized.marker, sanitized.callback], ["[UNSUPPORTED_VALUE]", "[UNSUPPORTED_VALUE]", "[UNSUPPORTED_VALUE]"]);
});

test("discovery firewall fails closed on malformed URLs", () => {
  assert.deepEqual(createDiscoveryFirewall(["https://acme.example"]).decide({ method: "GET", url: "not a URL" }), { allow: false, code: "INVALID_URL" });
});

test("discovery firewall revalidates allowlisted URLs before applying origin and method policy", () => {
  assert.deepEqual(createDiscoveryFirewall(["https://127.0.0.1"]).decide({ method: "GET", url: "https://127.0.0.1/private" }), { allow: false, code: "PRIVATE_NETWORK_BLOCKED" });
  assert.deepEqual(createDiscoveryFirewall(["https://acme.example"]).decide({ method: "GET", url: "https://user:password@acme.example/private" }), { allow: false, code: "EMBEDDED_CREDENTIALS_BLOCKED" });
});
