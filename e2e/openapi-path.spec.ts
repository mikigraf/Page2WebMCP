import { expect, test } from "@playwright/test";

test("OpenAPI path compiles the fixture contract without manual setup", async ({ page }) => {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Source type").selectOption("openapi");
  await page.getByLabel("Source URL").fill("https://acme.example/openapi.json");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze openapi" }).click();
  await expect(page.getByText("get_order_status", { exact: true })).toBeVisible();
});
