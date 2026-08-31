import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("control plane is a TypeScript Next App Router application with a durable analysis endpoint", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/projects/analyze/route.ts", import.meta.url), "utf8");
  assert.match(page, /Page2WebMCP/);
  assert.match(route, /enqueueAnalysis/);
  assert.match(route, /processNextAnalysis/);
  assert.doesNotMatch(route, /runFixtureWorkflow/);
});

test("auth/project UI exposes actionable SSR states without trusting browser role storage", async () => {
  const entry = await readFile(new URL("../app/project-entry.tsx", import.meta.url), "utf8");
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(entry, /Create account/);
  assert.match(entry, /Recover password/);
  assert.match(entry, /Your projects/);
  assert.match(entry, /Open and resume/);
  assert.match(entry, /Load more projects/);
  assert.match(entry, /Set new password/);
  assert.match(entry, /Sign out all devices/);
  assert.match(entry, /currentCsrfToken/);
  assert.match(entry, /anonymousCsrfRoutes/);
  assert.match(entry, /Create tested patch and draft PR/);
  assert.match(entry, /Exact reviewed capability/);
  assert.match(entry, /Plan digest/);
  assert.match(entry, /Input schema/);
  assert.match(entry, /Required scopes/);
  assert.match(entry, /Verify exact candidate/);
  assert.match(entry, /Copy trusted-loader script/);
  assert.match(entry, /Check installed target/);
  assert.match(entry, /release\.installation\.verificationPageUrl/);
  assert.doesNotMatch(entry, /const pageUrl = new URL\(url\)\.origin/);
  assert.match(entry, /Local-only artifact/);
  assert.match(entry, /Self-hosted artifact URL/);
  assert.match(entry, /nothing was merged or installed/i);
  assert.match(entry, /\/api\/workflow-runs\//);
  assert.doesNotMatch(entry, /sourceType === "github"\}>Publish immutable release/);
  assert.doesNotMatch(entry, /draftPullRequest\?\.draft/);
  assert.doesNotMatch(entry, /fixed Acme fixture|page2webmcp_role|localStorage/);
  assert.match(proxy, /Refresh only/);
  assert.match(proxy, /getAuthService\(\)\.refreshForProxy/);
  assert.doesNotMatch(proxy, /role|organizationId/);
});

test("project entry offers all source paths and describes OpenAPI verification context", async () => {
  const entry = await readFile(new URL("../app/project-entry.tsx", import.meta.url), "utf8");
  assert.match(entry, /<option value="website">Website URL<\/option>/);
  assert.match(entry, /<option value="openapi">OpenAPI URL<\/option>/);
  assert.match(entry, /<option value="github">GitHub repository<\/option>/);
  assert.match(entry, /OpenAPI source URL/);
  assert.match(entry, /Target origin/);
  assert.match(entry, /Same-origin test page URL/);
  assert.match(entry, /Environment/);
  assert.match(entry, /sourceConfiguration/);
  assert.match(entry, /body\.source\.sourceConfiguration/);
});
