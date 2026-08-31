import { expect, test } from "@playwright/test";
import { CONTROL_PLANE_OWNER_PASSWORD, CONTROL_PLANE_URL } from "./urls.ts";

test("all source paths stay selectable and OpenAPI context survives reopening the server project", async ({ page }) => {
  const suffix = Date.now();
  const apiHost = `api-${suffix}.acme.example`;
  const appHost = `app-${suffix}.acme.example`;
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  const sourceType = page.getByLabel("Source type");
  await expect(sourceType.locator("option")).toHaveCount(3);
  await sourceType.selectOption("website");
  await expect(page.getByLabel("Website URL")).toBeVisible();
  await sourceType.selectOption("github");
  await expect(page.getByLabel("GitHub repository URL")).toBeVisible();
  await sourceType.selectOption("openapi");

  await page.getByLabel("OpenAPI source URL").fill(`https://${apiHost}/openapi.json`);
  await page.getByLabel("Target origin").fill(`https://${appHost}`);
  await page.getByLabel("Same-origin test page URL").fill(`https://${appHost}/checkout`);
  await page.getByLabel("Environment").selectOption("staging");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toContainText("created");

  await page.reload();
  await page.getByRole("listitem").filter({ hasText: `${apiHost} API` }).getByRole("button", { name: "Open and resume" }).click();
  await expect(page.getByLabel("OpenAPI source URL")).toHaveValue(`https://${apiHost}/openapi.json`);
  await expect(page.getByLabel("Target origin")).toHaveValue(`https://${appHost}`);
  await expect(page.getByLabel("Same-origin test page URL")).toHaveValue(`https://${appHost}/checkout`);
  await expect(page.getByLabel("Environment")).toHaveValue("staging");
});
