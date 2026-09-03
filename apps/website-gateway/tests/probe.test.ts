import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { WEBSITE_PROBE_SCRIPT } from "../src/observer/probe.ts";

type Node = { tagName: string; textContent: string };

function evaluate(nodes: readonly Node[], marked = false): {
  signals: string[]; signIn: boolean; forms: unknown[]; url: string; origin: string;
} {
  const context = {
    document: {
      querySelectorAll: () => nodes.map((node) => ({ ...node, getAttribute: () => null })),
      querySelector: () => (marked ? {} : null),
      forms: [] as unknown[],
    },
    location: { href: "https://widgets.example/", origin: "https://widgets.example", pathname: "/" },
    URL,
    JSON,
  };
  return JSON.parse(runInNewContext(WEBSITE_PROBE_SCRIPT, context) as string);
}

test("the probe reports the authentication signals it finds", () => {
  const signedOut = evaluate([{ tagName: "A", textContent: "Sign in" }]);
  assert.deepEqual(signedOut.signals, []);
  assert.equal(signedOut.signIn, true);

  const signedIn = evaluate([
    { tagName: "A", textContent: "Parts workspace" },
    { tagName: "BUTTON", textContent: "Sign out" },
  ]);
  assert.deepEqual(signedIn.signals, ["logout_control"], "a sign-out control is an authentication signal");
  assert.equal(signedIn.signIn, false);

  assert.deepEqual(evaluate([{ tagName: "A", textContent: "Log out" }]).signals, ["logout_control"]);
  assert.deepEqual(evaluate([{ tagName: "A", textContent: "My account" }]).signals, ["account_control"]);
  assert.deepEqual(evaluate([], true).signals, ["authenticated_status"]);
});

test("the probe bounds the signals it returns to three distinct names", () => {
  const many = evaluate([
    { tagName: "BUTTON", textContent: "Sign out" },
    { tagName: "A", textContent: "Account" },
    { tagName: "A", textContent: "Profile" },
    { tagName: "A", textContent: "Dashboard" },
  ], true);
  assert.ok(many.signals.length > 0 && many.signals.length <= 3);
  assert.equal(new Set(many.signals).size, many.signals.length);
});
