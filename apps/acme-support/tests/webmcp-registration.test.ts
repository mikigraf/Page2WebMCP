import test from "node:test";
import assert from "node:assert/strict";
import { loadWebMcpArtifact } from "../app/webmcp-registration.tsx";

test("failed artifact loads clear the cache and emit only safe diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const target = {} as Window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  let calls = 0;
  const diagnostics: Array<{ phase: string; code: string }> = [];
  globalThis.fetch = async () => { calls += 1; return new Response("secret upstream detail", { status: 503 }); };
  try {
    await assert.rejects(loadWebMcpArtifact((event) => diagnostics.push(event)), /WEBMCP_RELEASE_UNAVAILABLE/);
    await assert.rejects(loadWebMcpArtifact((event) => diagnostics.push(event)), /WEBMCP_RELEASE_UNAVAILABLE/);
    assert.equal(calls, 2);
    assert.deepEqual(diagnostics, [
      { phase: "load", code: "RELEASE_UNAVAILABLE" },
      { phase: "load", code: "RELEASE_UNAVAILABLE" },
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret/i);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("stalled artifact fetches time out, abort, and can be retried", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalSetTimeout = globalThis.setTimeout;
  const target = {} as Window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  let calls = 0;
  let aborted = false;
  const diagnostics: Array<{ phase: string; code: string }> = [];
  globalThis.setTimeout = ((callback: () => void) => originalSetTimeout(callback, 0)) as typeof setTimeout;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (calls > 1) return new Response("retry failure", { status: 503 });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal!.reason);
      }, { once: true });
    });
  };
  try {
    await assert.rejects(
      Promise.race([
        loadWebMcpArtifact((event) => diagnostics.push(event)),
        new Promise<never>((_resolve, reject) => originalSetTimeout(() => reject(new Error("TEST_STALLED")), 50)),
      ]),
      /WEBMCP_RELEASE_TIMEOUT/,
    );
    assert.equal(aborted, true);
    await assert.rejects(loadWebMcpArtifact((event) => diagnostics.push(event)), /WEBMCP_RELEASE_UNAVAILABLE/);
    assert.equal(calls, 2);
    assert.deepEqual(diagnostics, [
      { phase: "load", code: "LOAD_TIMEOUT" },
      { phase: "load", code: "RELEASE_UNAVAILABLE" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});

test("artifact downloads stream, cancel above the byte cap, and can be retried", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const target = {} as Window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  let calls = 0;
  let pulls = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > 1) return new Response("retry failure", { status: 503 });
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(40_000));
        if (pulls === 100) controller.close();
      },
      cancel() { cancelled = true; },
    }));
  };
  try {
    await assert.rejects(loadWebMcpArtifact(), /WEBMCP_RELEASE_TOO_LARGE/);
    assert.equal(cancelled, true);
    assert.ok(pulls < 100);
    await assert.rejects(loadWebMcpArtifact(), /WEBMCP_RELEASE_UNAVAILABLE/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
});
