import assert from "node:assert/strict";
import test from "node:test";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
const ORIGIN = "https://page2webmcp-example-target.vercel.app";
const EXPIRES = "2026-09-03T12:00:00.000Z";
const CONTENT = `page2webmcp-verification=${TOKEN}\norigin=${ORIGIN}\nexpires=${EXPIRES}\n`;

const { GET } = await import("../app/.well-known/page2webmcp-verification.txt/route.ts");
const { parseOwnershipVerification } = await import("../src/ownership-verification.ts");

test("ownership verification parses the exact well-known content, with literal or escaped newlines", () => {
  assert.equal(parseOwnershipVerification({ PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION: CONTENT }), CONTENT);
  assert.equal(
    parseOwnershipVerification({ PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION: CONTENT.replace(/\n/g, "\\n") }),
    CONTENT,
  );
  assert.equal(
    parseOwnershipVerification({ PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION: CONTENT.trimEnd() }),
    CONTENT,
  );
});

test("ownership verification rejects missing, malformed, or tampered content", () => {
  for (const value of [
    undefined,
    "",
    "page2webmcp-verification=short\norigin=https://x.example\nexpires=2026-09-03T12:00:00.000Z\n",
    `page2webmcp-verification=${TOKEN}\norigin=http://insecure.example\nexpires=${EXPIRES}\n`,
    `page2webmcp-verification=${TOKEN}\norigin=${ORIGIN}\nexpires=not-a-date\n`,
    `${CONTENT}extra=line\n`,
    `<script>${CONTENT}`,
  ]) {
    assert.equal(parseOwnershipVerification({ PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION: value }), null, String(value));
  }
});

test("well-known route serves the content as plain text and fails closed without it", async () => {
  delete process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION;
  const missing = GET();
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OWNERSHIP_VERIFICATION = CONTENT;
  const served = GET();
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(served.headers.get("cache-control"), "no-store");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await served.text(), CONTENT);
});
