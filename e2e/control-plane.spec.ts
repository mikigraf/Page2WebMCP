import { expect, test } from "@playwright/test";
import { CONTROL_PLANE_OWNER_PASSWORD, CONTROL_PLANE_URL } from "./urls.ts";

test("control-plane creates and analyzes website, OpenAPI, and GitHub projects without manual setup", async ({ page }) => {
  const initial = await page.goto(CONTROL_PLANE_URL);
  expect(initial?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(initial?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in as owner")).toBeVisible();
  await page.getByLabel("Source type").selectOption("website");
  await page.getByLabel("Source URL").fill("https://acme.example");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toHaveText(/Project [0-9a-f-]{36} created/);
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByText("find_order", { exact: true })).toBeVisible();
  await expect(page.getByText("delete_account: blocked")).toBeVisible();
  await page.getByRole("button", { name: "Approve create_support_ticket" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "create_support_ticket: reviewed" })).toBeVisible();
  await page.getByRole("button", { name: "Publish immutable release" }).click();
  await expect(page.getByText("Immutable release published")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Acme release" })).toHaveAttribute("href", /\/api\/releases\/[0-9a-f]{64}\.js$/);

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

test("control-plane reuses ambiguous idempotency keys and resumes an analysis after reload", async ({ page }) => {
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  const observedKeys: string[] = [];
  const committedIds: string[] = [];
  let droppedProjectResponses = 0;
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    observedKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (droppedProjectResponses < 2) {
      droppedProjectResponses += 1;
      const response = await route.fetch();
      const body = await response.json() as { id: string };
      committedIds.push(body.id);
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toHaveText("Project creation failed: REQUEST_FAILED");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toHaveText(new RegExp(`Project ${committedIds[0]} created`));
  expect(observedKeys).toHaveLength(3);
  expect(new Set(observedKeys).size).toBe(1);
  expect(committedIds[1]).toBe(committedIds[0]);

  let droppedStatusResponse = false;
  await page.route("**/api/analysis-runs/*", async (route) => {
    if (!droppedStatusResponse) {
      droppedStatusResponse = true;
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByRole("status")).toHaveText("Analysis failed: REQUEST_FAILED");

  await page.reload();
  await expect(page.getByText("find_order", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume analysis" })).toBeVisible();
});

test("control-plane reconciles a capability review after the committed response is lost", async ({ page }) => {
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByRole("button", { name: "Approve create_support_ticket" })).toBeVisible();

  let committed = false;
  await page.route("**/api/capabilities/*/review", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = true;
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: "Approve create_support_ticket" }).click();

  await expect(page.getByRole("listitem").filter({ hasText: "create_support_ticket: reviewed" })).toBeVisible();
  expect(committed).toBe(true);
  await expect(page.getByText(/Review failed:/)).toHaveCount(0);
});
