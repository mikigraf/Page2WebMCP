import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryControlPlaneRepository, RepositoryError } from "../../../packages/database/src/control-plane.ts";
import { normalizeProjectInput } from "../src/projects.ts";
import { GET as listProjects } from "../app/api/projects/route.ts";
import { GET as projectDetail } from "../app/api/projects/[projectId]/route.ts";
import { authenticatedHeaders, installTestRepository, owner } from "./auth-test-helpers.ts";

const identity = {
  id: "44444444-4444-4444-4444-444444444444",
  email: "new.owner@example.test"
};

test("arbitrary supported website, OpenAPI, and GitHub sources normalize without fixture branches", () => {
  assert.deepEqual(normalizeProjectInput({ sourceType: "website", url: "https://Docs.Example:443/guide/" }), {
    ok: true,
    value: { sourceType: "website", url: "https://docs.example/guide/", sourceConfiguration: { kind: "website" }, name: "docs.example" }
  });
  assert.deepEqual(normalizeProjectInput({ sourceType: "openapi", url: "https://api.example/spec/openapi.yaml", sourceConfiguration: { kind: "openapi", targetOrigin: "https://api.example", testPageUrl: "https://api.example/", environment: "test" } }), {
    ok: true,
    value: { sourceType: "openapi", url: "https://api.example/spec/openapi.yaml", sourceConfiguration: { kind: "openapi", targetOrigin: "https://api.example", testPageUrl: "https://api.example/", environment: "test" }, name: "api.example API" }
  });
  assert.deepEqual(normalizeProjectInput({ sourceType: "github", url: "https://github.com/Example/Widget.git" }), {
    ok: true,
    value: { sourceType: "github", url: "https://github.com/Example/Widget", sourceConfiguration: { kind: "github" }, name: "Example/Widget" }
  });
  assert.deepEqual(normalizeProjectInput({ sourceType: "website", url: "https://docs.example/callback?code=secret" }), {
    ok: false,
    code: "SOURCE_QUERY_FORBIDDEN"
  });
  assert.deepEqual(normalizeProjectInput({ sourceType: "github", url: "https://github.com/example" }), {
    ok: false,
    code: "GITHUB_REPOSITORY_URL_REQUIRED"
  });
});

test("personal organization provisioning is idempotent and membership is resolved freshly", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const provisioned = await Promise.all(Array.from({ length: 20 }, () =>
    repository.provisionPersonalOrganization(identity)));
  assert.equal(new Set(provisioned.map((actor) => actor.organizationId)).size, 1);
  assert.deepEqual(new Set(provisioned.map((actor) => actor.role)), new Set(["owner"]));
  assert.deepEqual(await repository.resolveActor(identity.id), provisioned[0]);
  await assert.rejects(repository.resolveActor("55555555-5555-5555-5555-555555555555"), (error: unknown) =>
    error instanceof RepositoryError && error.code === "MEMBERSHIP_REQUIRED");
});

test("project cursor pages are stable, bounded, resumable, and never silently truncated", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const actor = await repository.provisionPersonalOrganization(identity);
  for (let index = 0; index < 7; index += 1) {
    await repository.createProject(actor, {
      name: `Project ${index}`,
      sourceType: "website",
      url: `https://project-${index}.example/`,
      idempotencyKey: `project-page-${index}`,
      inputHash: `hash-${index}`
    });
  }

  const first = await repository.listProjectsPage(actor, { limit: 3 });
  assert.equal(first.projects.length, 3);
  assert.ok(first.nextCursor);
  const second = await repository.listProjectsPage(actor, { limit: 3, cursor: first.nextCursor });
  const third = await repository.listProjectsPage(actor, { limit: 3, cursor: second.nextCursor });
  assert.equal(new Set([...first.projects, ...second.projects, ...third.projects].map(({ id }) => id)).size, 7);
  assert.equal(third.nextCursor, undefined);
  await assert.rejects(repository.listProjectsPage(actor, { limit: 3, cursor: "tampered" }), (error: unknown) =>
    error instanceof RepositoryError && error.code === "INVALID_CURSOR");
});

test("project list/detail APIs resume durable state across reloads with opaque cursors", async () => {
  const repository = installTestRepository();
  let resumableProjectId = "";
  for (let index = 0; index < 5; index += 1) {
    const project = await repository.createProject(owner, {
      name: `Durable ${index}`,
      sourceType: "website",
      url: `https://durable-${index}.example/`,
      idempotencyKey: `durable-project-${index}`,
      inputHash: `durable-project-${index}`
    });
    resumableProjectId = project.id;
  }
  const run = await repository.enqueueAnalysis(owner, {
    projectId: resumableProjectId,
    idempotencyKey: "durable-analysis",
    inputHash: "durable-analysis"
  });
  const headers = authenticatedHeaders(owner);
  const first = await listProjects(new Request("https://control.example/api/projects?limit=2", { headers }));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.projects.length, 2);
  assert.ok(firstBody.nextCursor);
  const second = await listProjects(new Request(
    `https://control.example/api/projects?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    { headers }
  ));
  assert.equal(second.status, 200);
  assert.equal((await second.json()).projects.length, 2);

  repository.listProjectSources = async () => {
    throw new Error("DETAIL_MUST_NOT_PAGE_PROJECT_SOURCES");
  };
  const detail = await projectDetail(
    new Request(`https://control.example/api/projects/${resumableProjectId}`, { headers }),
    { params: Promise.resolve({ projectId: resumableProjectId }) }
  );
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.equal(body.project.id, resumableProjectId);
  assert.deepEqual(body.source.sourceConfiguration, { kind: "website" });
  assert.equal(body.latestAnalysis.id, run.id);
  assert.equal(body.latestAnalysis.status, "queued");
});

test("project detail returns OpenAPI verification context as the authoritative source after refresh", async () => {
  const repository = installTestRepository();
  const project = await repository.createProject(owner, {
    name: "Authoritative OpenAPI context",
    sourceType: "openapi",
    url: "https://api.widgets.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: "https://app.widgets.example",
      testPageUrl: "https://app.widgets.example/checkout",
      environment: "staging"
    },
    idempotencyKey: "authoritative-openapi-context",
    inputHash: "authoritative-openapi-context"
  });
  const detail = await projectDetail(
    new Request(`https://control.example/api/projects/${project.id}`, { headers: authenticatedHeaders(owner) }),
    { params: Promise.resolve({ projectId: project.id }) }
  );
  assert.equal(detail.status, 200);
  const body = await detail.json();
  assert.deepEqual(body.source.sourceConfiguration, {
    kind: "openapi",
    targetOrigin: "https://app.widgets.example",
    testPageUrl: "https://app.widgets.example/checkout",
    environment: "staging"
  });
});
