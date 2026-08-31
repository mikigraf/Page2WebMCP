import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/projects/route.ts";
import { InMemoryControlPlaneRepository } from "../../../packages/database/src/control-plane.ts";
import { authenticatedHeaders, installTestRepository, owner } from "./auth-test-helpers.ts";

const authHeaders = authenticatedHeaders(owner);

function request(
  method: "GET" | "POST",
  body?: unknown,
  cookie = authHeaders.cookie,
  idempotencyKey = "project-request"
): Request {
  return new Request("https://control.example/api/projects", {
    method,
    headers: {
      ...authHeaders,
      cookie,
      "content-type": "application/json",
      ...(method === "POST" && idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test("projects require a signed session and legacy role cookies are rejected", async () => {
  installTestRepository(new InMemoryControlPlaneRepository());
  const anonymous = await GET(request("GET", undefined, ""));
  assert.equal(anonymous.status, 401);
  const forged = await POST(request("POST", {
    sourceType: "website",
    url: "https://acme.example"
  }, "page2webmcp_role=owner"));
  assert.equal(forged.status, 401);
});

test("project entry persists scoped fixture sources with opaque IDs", async () => {
  installTestRepository(new InMemoryControlPlaneRepository());
  const website = await POST(request("POST", { sourceType: "website", url: "https://acme.example" }, undefined, "website-project"));
  assert.equal(website.status, 201);
  const websiteBody = await website.json();
  assert.match(websiteBody.id, /^[0-9a-f-]{36}$/);
  assert.equal(websiteBody.sourceType, "website");
  assert.equal(websiteBody.url, "https://acme.example/");

  assert.equal((await POST(request("POST", {
    sourceType: "openapi",
    url: "https://acme.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: "https://acme.example",
      testPageUrl: "https://acme.example/checkout",
      environment: "test"
    }
  }, undefined, "openapi-project"))).status, 201);
  assert.equal((await POST(request("POST", {
    sourceType: "github",
    url: "https://github.com/acme/support"
  }, undefined, "github-project"))).status, 201);

  const list = await GET(request("GET"));
  assert.equal((await list.json()).projects.length, 3);
});

test("OpenAPI project creation requires a same-origin HTTPS verification context", async () => {
  installTestRepository(new InMemoryControlPlaneRepository());
  const missing = await POST(request("POST", {
    sourceType: "openapi",
    url: "https://api.acme.example/openapi.json"
  }, undefined, "openapi-context-missing"));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "OPENAPI_VERIFICATION_CONTEXT_REQUIRED");

  const mismatched = await POST(request("POST", {
    sourceType: "openapi",
    url: "https://api.acme.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: "https://acme.example",
      testPageUrl: "https://other.example/checkout",
      environment: "preview"
    }
  }, undefined, "openapi-context-invalid"));
  assert.equal(mismatched.status, 400);
  assert.equal((await mismatched.json()).code, "OPENAPI_VERIFICATION_CONTEXT_REQUIRED");

  const strictWebsite = await POST(request("POST", {
    sourceType: "website",
    url: "https://acme.example",
    sourceConfiguration: { kind: "github" }
  }, undefined, "website-context-invalid"));
  assert.equal(strictWebsite.status, 400);
});

test("project entry fails closed for private and invalid source shapes while accepting arbitrary public sources", async () => {
  installTestRepository(new InMemoryControlPlaneRepository());
  const privateTarget = await POST(request("POST", { sourceType: "website", url: "https://127.0.0.1" }));
  assert.equal(privateTarget.status, 400);
  assert.equal((await privateTarget.json()).code, "PRIVATE_NETWORK_BLOCKED");

  const arbitraryPublic = await POST(request("POST", { sourceType: "website", url: "https://other.example" }));
  assert.equal(arbitraryPublic.status, 201);
  assert.equal((await arbitraryPublic.json()).url, "https://other.example/");

  const wrongGithub = await POST(request("POST", { sourceType: "github", url: "https://acme.example" }));
  assert.equal(wrongGithub.status, 400);
  assert.equal((await wrongGithub.json()).code, "GITHUB_URL_REQUIRED");
});

test("project creation requires a valid idempotency key and replays only identical input", async () => {
  installTestRepository(new InMemoryControlPlaneRepository());
  const input = { sourceType: "website", url: "https://acme.example" };
  const missing = await POST(request("POST", input, undefined, ""));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "IDEMPOTENCY_KEY_REQUIRED");

  const first = await POST(request("POST", input, undefined, "same-project-key"));
  const replay = await POST(request("POST", input, undefined, "same-project-key"));
  assert.equal(first.status, 201);
  assert.equal((await replay.json()).id, (await first.json()).id);

  const conflict = await POST(request("POST", {
    sourceType: "openapi",
    url: "https://acme.example/openapi.json",
    sourceConfiguration: { kind: "openapi", targetOrigin: "https://acme.example", testPageUrl: "https://acme.example/", environment: "test" }
  }, undefined, "same-project-key"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_CONFLICT");
});
