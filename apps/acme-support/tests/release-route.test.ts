import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../app/api/releases/acme/route.ts";

test("Acme serves the compiled WebMCP release as an immutable JavaScript artifact", async () => {
  const response = await GET(new Request("https://acme.example/api/releases/acme"));
  const code = await response.text();
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  assert.match(response.headers.get("etag") ?? "", /^[a-f0-9]{64}$/);
  assert.match(code, /registerPage2WebMCPTools/);
  assert.match(code, /https:\/\/acme\.example/);
});
