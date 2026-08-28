import { expect, test } from "@playwright/test";

test("GitHub path prepares a constrained draft pull request without manual setup", async ({ page }) => {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Source type").selectOption("github");
  await page.getByLabel("Source URL").fill("https://github.com/acme/support");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze github" }).click();
  await expect(page.getByText("Draft pull request prepared")).toBeVisible();
});
