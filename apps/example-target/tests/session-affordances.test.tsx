import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PartsConsole } from "../src/console.ts";

const operator = { email: "operator@beaconworks.dev", password: "example-target-password" };

test("signing out ends the session and is idempotent", () => {
  const app = new PartsConsole({ operator });
  const session = app.login(operator.email, operator.password);
  assert.equal(app.isAuthenticated(session), true);
  app.logout(session);
  assert.equal(app.isAuthenticated(session), false);
  app.logout(session);
  app.logout("never-issued");
  assert.equal(app.isAuthenticated(session), false);
});

test("the console navigation shows a sign-out control only while signed in", async () => {
  const { ConsoleNavigation } = await import("../app/console-navigation.tsx");

  const signedOut = renderToStaticMarkup(<ConsoleNavigation signedIn={false} />);
  assert.match(signedOut, /Sign in/);
  assert.doesNotMatch(signedOut, /Sign out/);

  const signedIn = renderToStaticMarkup(<ConsoleNavigation signedIn />);
  // The analysis observes this affordance to confirm an authenticated session.
  assert.match(signedIn, /Sign out/);
  assert.doesNotMatch(signedIn, />Sign in</);
  assert.match(signedIn, /action="\/api\/auth\/logout"/);
});

test("the console navigation exposes a GET search affordance only while signed in", async () => {
  // Website-journey discovery only ever visits the home page, and only ever
  // proposes a GET form with named controls it can find without interaction.
  // Gating it on signedIn keeps it out of the unauthenticated observation, so
  // it is correctly discovered as an authenticated read.
  const { ConsoleNavigation } = await import("../app/console-navigation.tsx");

  const signedOut = renderToStaticMarkup(<ConsoleNavigation signedIn={false} />);
  assert.doesNotMatch(signedOut, /<form[^>]*method="get"/i);

  const signedIn = renderToStaticMarkup(<ConsoleNavigation signedIn />);
  assert.match(signedIn, /<form action="\/workspace" method="get">/i);
  assert.match(signedIn, /name="q"/);
});
