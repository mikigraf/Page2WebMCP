import { expect, test } from "@playwright/test";
import { CONTROL_PLANE_OWNER_PASSWORD, CONTROL_PLANE_URL } from "./urls.ts";

test("OpenAPI path compiles the fixture contract without manual setup", async ({ page }) => {
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Source type").selectOption("openapi");
  await page.getByLabel("Source URL").fill("https://acme.example/openapi.json");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze openapi" }).click();
  await expect(page.getByText("get_order_status", { exact: true })).toBeVisible();
});
