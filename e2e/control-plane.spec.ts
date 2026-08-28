import { expect, test } from "@playwright/test";

test("control-plane creates and analyzes website, OpenAPI, and GitHub projects without manual setup", async ({ page }) => {
  await page.goto("http://127.0.0.1:3100");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in as owner")).toBeVisible();
  await page.getByLabel("Source type").selectOption("website");
  await page.getByLabel("Source URL").fill("https://acme.example");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toHaveText(/Project project-\d+ created/);
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByText("find_order", { exact: true })).toBeVisible();
  await expect(page.getByText("delete_account: blocked")).toBeVisible();
  await page.getByRole("button", { name: "Approve create_support_ticket" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "create_support_ticket: reviewed" })).toBeVisible();
  await page.getByRole("button", { name: "Publish immutable release" }).click();
  await expect(page.getByText("Immutable release published")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Acme release" })).toHaveAttribute("href", "https://acme.example/api/releases/acme");

  await page.getByLabel("Source type").selectOption("openapi");
  await page.getByLabel("Source URL").fill("https://acme.example/openapi.json");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze openapi" }).click();
  await expect(page.getByText("get_order_status", { exact: true })).toBeVisible();

  await page.getByLabel("Source type").selectOption("github");
  await page.getByLabel("Source URL").fill("https://github.com/acme/support");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze github" }).click();
  await expect(page.getByText("Draft pull request prepared")).toBeVisible();
});
