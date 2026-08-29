import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GET } from "../app/api/releases/acme/route.ts";

test("Acme serves a mutable release URL from its configured fixture origin without false immutable caching", async () => {
  const response = await GET();
  const code = await response.text();
  const digest = createHash("sha256").update(code).digest();
  const integrity = createHash("sha384").update(code).digest("base64");
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("etag"), `"${digest.toString("hex")}"`);
  assert.equal(response.headers.get("x-page2webmcp-content-hash"), digest.toString("hex"));
  assert.equal(response.headers.get("x-page2webmcp-integrity"), `sha384-${integrity}`);
  assert.match(code, /registerPage2WebMCPTools/);
  assert.match(code, /http:\/\/127\.0\.0\.1:3200/);
  assert.doesNotMatch(code, /https:\/\/acme\.example/);
});

test("Acme release origin is not derived from request headers", async () => {
  const response = await GET();
  const code = await response.text();
  assert.match(code, /http:\/\/127\.0\.0\.1:3200/);
  assert.doesNotMatch(code, /http:\/\/localhost:3200/);
});
