import { expect, test } from "@playwright/test";

test("website path discovers safe capabilities without manual setup", async ({ page }) => {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Source type").selectOption("website");
  await page.getByLabel("Source URL").fill("https://acme.example");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByText("find_order", { exact: true })).toBeVisible();
  await expect(page.getByText("delete_account: blocked")).toBeVisible();
});
