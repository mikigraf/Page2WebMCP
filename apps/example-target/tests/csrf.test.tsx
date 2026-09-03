import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PartsConsole } from "../src/console.ts";

const operator = { email: "operator@beaconworks.dev", password: "example-target-password" };

test("each session gets its own bounded request token, and unknown sessions get none", () => {
  const app = new PartsConsole({ operator });
  const first = app.login(operator.email, operator.password);
  const second = app.login(operator.email, operator.password);
  const token = app.requestToken(first);
  assert.match(String(token), /^[A-Za-z0-9_-]{22,}$/);
  assert.equal(app.requestToken(first), token, "stable for the life of the session");
  assert.notEqual(app.requestToken(second), token, "never shared between sessions");
  assert.equal(app.requestToken("never-issued"), undefined);
  app.logout(first);
  assert.equal(app.requestToken(first), undefined, "gone with the session");
});

test("the request token is exposed to the page as the meta tag the compiler resolves", async () => {
  const { RequestTokenMeta } = await import("../app/request-token-meta.tsx");
  assert.equal(renderToStaticMarkup(<RequestTokenMeta token={undefined} />), "");
  const markup = renderToStaticMarkup(<RequestTokenMeta token="abc123" />);
  assert.match(markup, /name="csrf-token"/);
  assert.match(markup, /content="abc123"/);
});

test("the reservation mutation requires the session's request token", async () => {
  process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_EMAIL = operator.email;
  process.env.PAGE2WEBMCP_EXAMPLE_TARGET_OPERATOR_PASSWORD = operator.password;
  const { NextRequest } = await import("next/server");
  const { partsConsole, SESSION_COOKIE } = await import("../app/api/_runtime.ts");
  const { POST: reserve } = await import("../app/api/reservations/route.ts");

  const session = partsConsole().login(operator.email, operator.password);
  const token = partsConsole().requestToken(session)!;
  const origin = "https://target.example";
  const body = JSON.stringify({ sku: "BP-1001", quantity: 1 });
  const request = (headers: Record<string, string>) => new NextRequest(`${origin}/api/reservations`, {
    method: "POST",
    headers: { host: "target.example", origin, "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${session}`, ...headers },
    body,
  });

  const withoutToken = await reserve(request({}));
  assert.equal(withoutToken.status, 403, "the cookie alone is not enough");
  const wrongToken = await reserve(request({ "x-csrf-token": "not-the-token" }));
  assert.equal(wrongToken.status, 403);
  // The published token clears the gate; the request then fails only on the
  // reservation's own confirmation and idempotency requirements.
  const accepted = await reserve(request({ "x-csrf-token": token }));
  assert.notEqual(accepted.status, 403, "the published token is accepted");
});
