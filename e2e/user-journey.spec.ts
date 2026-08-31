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

  await page.evaluate(({ apiHost, appHost }) => sessionStorage.setItem("page2webmcp.workflow.v1", JSON.stringify({
    sourceType: "openapi",
    url: `https://stale-${apiHost}/openapi.json`,
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: `https://stale-${appHost}`,
      testPageUrl: `https://stale-${appHost}/checkout`,
      environment: "production"
    },
    projectId: [...document.querySelectorAll("[role=status]")].find((element) => element.textContent?.includes("created"))?.textContent?.match(/[0-9a-f-]{36}/)?.[0]
  })), { apiHost, appHost });
  await page.reload();
  await expect(page.getByLabel("OpenAPI source URL")).toHaveValue(`https://${apiHost}/openapi.json`);
  await expect(page.getByLabel("Target origin")).toHaveValue(`https://${appHost}`);
  await expect(page.getByLabel("Same-origin test page URL")).toHaveValue(`https://${appHost}/checkout`);
  await expect(page.getByLabel("Environment")).toHaveValue("staging");
});

test("provider unavailability is a failed analysis, never a successful result", async ({ page }) => {
  const suffix = Date.now();
  await page.goto(CONTROL_PLANE_URL);
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Password").fill(CONTROL_PLANE_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Source type").selectOption("website");
  await page.getByLabel("Website URL").fill(`https://provider-${suffix}.acme.example/`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toContainText("created");

  await page.route("**/api/projects/analyze", (route) => route.fulfill({ json: { runId: "provider-run" } }));
  await page.route("**/api/analysis-runs/provider-run", (route) => route.fulfill({ json: {
    run: { status: "failed", errorCode: "PROVIDER_UNAVAILABLE" }, capabilities: []
  } }));
  await page.getByRole("button", { name: "Analyze website" }).click();
  await expect(page.getByRole("status")).toHaveText("Source provider unavailable: PROVIDER_UNAVAILABLE");
  await expect(page.getByRole("status")).not.toContainText("Analysis complete");
});
