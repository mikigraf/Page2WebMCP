import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { CONTROL_PLANE_OWNER_PASSWORD, CONTROL_PLANE_URL } from "./urls.ts";

test("website URL creates, publishes, and serves the immutable bundle", async ({ page }) => {
  const sourceUrl = `https://journey-${Date.now()}.acme.example/`;
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Signed in with current owner membership/)).toBeVisible();

  await page.getByLabel("Source type").selectOption("website");
  await page.getByLabel("Website URL").fill(sourceUrl);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toContainText("created");
  await expect(page.getByText(`Ownership verified for ${new URL(sourceUrl).origin}.`)).toBeVisible();

  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByRole("status")).toContainText("candidate");
  await page.getByRole("button", { name: "Approve create_support_ticket" }).click();
  await expect(page.getByRole("status")).toContainText("ready for verification");

  await page.getByRole("button", { name: "Verify exact candidate" }).click();
  await expect(page.getByRole("status")).toHaveText("Exact candidate verified");
  await page.getByRole("button", { name: "Publish immutable release" }).click();
  await expect(page.getByRole("status")).toHaveText("Immutable release published");

  const artifactLink = page.getByRole("link", { name: "Download immutable release" });
  await expect(artifactLink).toBeVisible();
  const artifactUrl = await artifactLink.getAttribute("href");
  expect(artifactUrl).toMatch(/^http:\/\/127\.0\.0\.1:3100\/api\/releases\/[0-9a-f]{64}\.js$/);
  const artifactResponse = await page.request.get(artifactUrl!);
  expect(artifactResponse.status()).toBe(200);
  expect(artifactResponse.headers()["content-type"]).toContain("text/javascript");
  const artifactBytes = await artifactResponse.body();
  const contentHash = artifactUrl!.match(/\/([0-9a-f]{64})\.js$/)![1]!;
  expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(contentHash);
  expect(artifactResponse.headers()["x-page2webmcp-content-hash"]).toBe(contentHash);
});
