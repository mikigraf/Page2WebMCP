import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  ApiError,
  assertSameOrigin,
  createRequestId,
  errorResponse,
  parseJsonBody,
  requireActor
} from "../src/api.ts";
import { installTestRepository } from "./auth-test-helpers.ts";

test("API body parsing is strict and bounded", async () => {
  const schema = z.object({ value: z.string() }).strict();
  assert.deepEqual(
    await parseJsonBody(new Request("https://control.example/api/test", {
      method: "POST",
      body: JSON.stringify({ value: "safe" })
    }), schema),
    { value: "safe" }
  );
  await assert.rejects(
    parseJsonBody(new Request("https://control.example/api/test", {
      method: "POST",
      body: JSON.stringify({ value: "safe", extra: true })
    }), schema),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID_REQUEST"
  );
  await assert.rejects(
    parseJsonBody(new Request("https://control.example/api/test", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(70_000) })
    }), schema),
    (error: unknown) => error instanceof ApiError && error.code === "REQUEST_TOO_LARGE"
  );
});

test("API body parsing cancels an undeclared oversized stream before buffering it", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(4_096));
      if (pulls === 100) controller.close();
    },
    cancel() { cancelled = true; }
  });
  const request = new Request("https://control.example/api/test", {
    method: "POST",
    body,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    parseJsonBody(request, z.object({ value: z.string() }).strict()),
    (error: unknown) => error instanceof ApiError && error.code === "REQUEST_TOO_LARGE"
  );
  assert.equal(cancelled, true);
  assert.ok(pulls < 100);
});

test("authenticated mutation rejects forged cookies and cross-site origins", async () => {
  installTestRepository();
  const forged = new Request("https://control.example/api/projects", {
    method: "POST",
    headers: { cookie: "page2webmcp_role=owner", origin: "https://control.example" }
  });
  await assert.rejects(requireActor(forged), (error: unknown) =>
    error instanceof ApiError && error.code === "AUTH_REQUIRED");

  const crossSite = new Request("https://control.example/api/projects", {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site"
    }
  });
  assert.throws(() => assertSameOrigin(crossSite), (error: unknown) => error instanceof ApiError && error.code === "CROSS_SITE_REQUEST_BLOCKED");
  const missingOrigin = new Request("https://control.example/api/projects", { method: "POST" });
  assert.throws(() => assertSameOrigin(missingOrigin), (error: unknown) => error instanceof ApiError && error.code === "CROSS_SITE_REQUEST_BLOCKED");
});

test("same-origin validation uses the configured public origin behind a reverse proxy", () => {
  const previous = process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN;
  process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN = "https://control.example";
  try {
    assert.doesNotThrow(() => assertSameOrigin(new Request("http://internal:3100/api/projects", {
      method: "POST",
      headers: { origin: "https://control.example", "sec-fetch-site": "same-origin" }
    })));
    assert.throws(() => assertSameOrigin(new Request("http://internal:3100/api/projects", {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }
    })), (error: unknown) => error instanceof ApiError && error.code === "CROSS_SITE_REQUEST_BLOCKED");
  } finally {
    if (previous === undefined) delete process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN;
    else process.env.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN = previous;
  }
});

test("safe error responses include stable correlation without raw details", async () => {
  const requestId = createRequestId();
  const response = errorResponse(new Error("password=do-not-leak"), requestId);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("x-request-id"), requestId);
  const body = await response.json();
  assert.deepEqual(body, {
    code: "INTERNAL_ERROR",
    error: { code: "INTERNAL_ERROR", retryable: false },
    requestId
  });
  assert.doesNotMatch(JSON.stringify(body), /do-not-leak/);
});

test("an unexpected failure is logged server-side with its cause and correlation", async () => {
  // The client body stays opaque, but discarding the cause entirely leaves a
  // production 500 unattributable. The server log carries it.
  const requestId = createRequestId();
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { lines.push(String(line)); };
  try {
    errorResponse(new TypeError("upstream shape changed"), requestId);
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(logged.event, "unhandled_api_failure");
  assert.equal(logged.request_id, requestId);
  assert.equal(logged.error_name, "TypeError");
  assert.equal(logged.error_message, "upstream shape changed");
  assert.equal(typeof logged.stack, "string");
});

test("a mapped failure is not logged as unhandled", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { lines.push(String(line)); };
  try {
    errorResponse(new ApiError("NOT_FOUND", 404), createRequestId());
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines, []);
});
