import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryProjectRepository } from "./repository.ts";

test("tenant repository prevents cross-organization project reads", () => {
  const repository = new InMemoryProjectRepository();
  const project = repository.create({ organizationId: "org-a", name: "Acme" });
  assert.equal(repository.get("org-a", project.id).name, "Acme");
  assert.throws(() => repository.get("org-b", project.id), { code: "FORBIDDEN" });
});
