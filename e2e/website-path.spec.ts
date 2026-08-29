import { expect, test } from "@playwright/test";
import { CONTROL_PLANE_OWNER_PASSWORD, CONTROL_PLANE_URL } from "./urls.ts";

test("website path discovers safe capabilities without manual setup", async ({ page }) => {
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Source type").selectOption("website");
  await page.getByLabel("Source URL").fill("https://acme.example");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByText("find_order", { exact: true })).toBeVisible();
  await expect(page.getByText("delete_account: blocked")).toBeVisible();
});
