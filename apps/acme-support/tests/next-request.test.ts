import test from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { NextRequest as RealNextRequest } from "next/server";
import { readJsonBody } from "../app/api/_fixture.ts";
import { POST as login } from "../app/api/auth/login/route.ts";
import { POST as confirmation } from "../app/api/confirmations/route.ts";
import { POST as ticket } from "../app/api/tickets/route.ts";

function nextRequest(body: ReadableStream<Uint8Array>): NextRequest {
  return new Request("https://acme.example/api/test", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" }) as unknown as NextRequest;
}

test("Next route JSON parsing streams, counts, and cancels an undeclared oversized body", async () => {
  let pulls = 0;
  let cancelled = false;
  const request = nextRequest(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(4_096));
      if (pulls === 100) controller.close();
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readJsonBody(request), { code: "PAYLOAD_TOO_LARGE" });
  assert.equal(cancelled, true);
  assert.ok(pulls < 100);
});

test("Next route JSON parsing accepts a valid body split across chunks", async () => {
  const encoder = new TextEncoder();
  const request = nextRequest(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"email":"agent@'));
      controller.enqueue(encoder.encode('example.test","password":"fixture-password"}'));
      controller.close();
    },
  }));
  assert.deepEqual(await readJsonBody(request), { email: "agent@example.test", password: "fixture-password" });
});

test("Acme mutation handlers reject cross-origin requests with safe no-store errors", async () => {
  for (const [path, handler] of [["/api/auth/login", login], ["/api/confirmations", confirmation], ["/api/tickets", ticket]] as const) {
    const response = await handler(new RealNextRequest(`http://127.0.0.1:3200${path}`, {
      method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { code: "ORIGIN_MISMATCH" });
  }
});

test("Acme mutation handlers use bounded JSON parsing after same-origin enforcement", async () => {
  const response = await login(new RealNextRequest("http://127.0.0.1:3200/api/auth/login", {
    method: "POST", headers: { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200", "content-type": "application/json" },
    body: JSON.stringify({ email: "x".repeat(17_000), password: "fixture-password" }),
  }));
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { code: "PAYLOAD_TOO_LARGE" });
});
