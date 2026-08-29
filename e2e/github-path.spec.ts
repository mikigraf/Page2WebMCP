import { expect, test } from "@playwright/test";
import { CONTROL_PLANE_OWNER_PASSWORD, CONTROL_PLANE_URL } from "./urls.ts";

test("GitHub path prepares a constrained draft pull request without manual setup", async ({ page }) => {
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Source type").selectOption("github");
  await page.getByLabel("Source URL").fill("https://github.com/acme/support");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze github" }).click();
  await expect(page.getByText("Draft pull request prepared")).toBeVisible();
});
