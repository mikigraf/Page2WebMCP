import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../app/api/projects/route.ts";
import { resetProjectsForTest } from "../src/projects.ts";

test("project entry accepts safe website and OpenAPI URLs and keeps GitHub separate", async () => {
  resetProjectsForTest();
  const website = await POST(new Request("http://test/api/projects", { method: "POST", body: JSON.stringify({ sourceType: "website", url: "https://acme.example" }) }));
  assert.equal(website.status, 201);
  assert.deepEqual(await website.json(), { id: "project-1", sourceType: "website", url: "https://acme.example", status: "created" });

  const openApi = await POST(new Request("http://test/api/projects", { method: "POST", body: JSON.stringify({ sourceType: "openapi", url: "https://acme.example/openapi.json" }) }));
  assert.equal(openApi.status, 201);

  const github = await POST(new Request("http://test/api/projects", { method: "POST", body: JSON.stringify({ sourceType: "github", url: "https://github.com/acme/support" }) }));
  assert.equal(github.status, 201);

  const list = await GET();
  assert.equal((await list.json()).projects.length, 3);
});

test("project entry rejects private and mismatched source URLs", async () => {
  resetProjectsForTest();
  const privateTarget = await POST(new Request("http://test/api/projects", { method: "POST", body: JSON.stringify({ sourceType: "website", url: "https://127.0.0.1" }) }));
  assert.equal(privateTarget.status, 400);
  assert.deepEqual(await privateTarget.json(), { code: "PRIVATE_NETWORK_BLOCKED" });

  const wrongGithub = await POST(new Request("http://test/api/projects", { method: "POST", body: JSON.stringify({ sourceType: "github", url: "https://acme.example" }) }));
  assert.equal(wrongGithub.status, 400);
  assert.deepEqual(await wrongGithub.json(), { code: "GITHUB_URL_REQUIRED" });
});
