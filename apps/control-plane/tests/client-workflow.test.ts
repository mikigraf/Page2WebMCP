import assert from "node:assert/strict";
import test from "node:test";
import {
  clearClientWorkflow,
  completeOperation,
  loadWorkflow,
  operationKey,
  reconcileProjectWorkflow,
  saveWorkflow
} from "../src/client-workflow.ts";

test("operation keys survive ambiguous retries and rotate only for a different request", () => {
  const storage = new MemoryStorage();
  let sequence = 0;
  const createKey = () => `key-${++sequence}`;

  const first = operationKey(storage, "create-project", '{"sourceType":"website"}', createKey);
  const retry = operationKey(storage, "create-project", '{"sourceType":"website"}', createKey);
  const changed = operationKey(storage, "create-project", '{"sourceType":"openapi"}', createKey);

  assert.equal(first, "key-1");
  assert.equal(retry, first);
  assert.equal(changed, "key-2");
  completeOperation(storage, "create-project", first);
  assert.equal(operationKey(storage, "create-project", '{"sourceType":"openapi"}', createKey), changed);
  completeOperation(storage, "create-project", changed);
  assert.equal(operationKey(storage, "create-project", '{"sourceType":"openapi"}', createKey), "key-3");
});

test("workflow state round-trips across reload and invalid state fails closed", () => {
  const storage = new MemoryStorage();
  const workflow = {
    sourceType: "openapi" as const,
    url: "https://api.acme.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi" as const,
      targetOrigin: "https://app.acme.example",
      testPageUrl: "https://app.acme.example/checkout",
      environment: "staging" as const
    },
    projectId: "project-1",
    analysisRunId: "run-1",
    workflowRunId: "workflow-1"
  };
  saveWorkflow(storage, workflow as never);
  assert.deepEqual(loadWorkflow(storage), workflow);

  storage.setItem("page2webmcp.workflow.v1", JSON.stringify({ sourceType: "unknown", url: "https://acme.example" }));
  assert.equal(loadWorkflow(storage), undefined);
  assert.equal(storage.getItem("page2webmcp.workflow.v1"), null);
});

test("OpenAPI recovery state keeps bounded verification context and fails closed when it is malformed", () => {
  const storage = new MemoryStorage();
  saveWorkflow(storage, {
    sourceType: "openapi",
    url: "https://api.acme.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi",
      targetOrigin: "https://app.acme.example",
      testPageUrl: "https://app.acme.example/checkout",
      environment: "production"
    }
  } as never);
  assert.deepEqual(loadWorkflow(storage)?.sourceConfiguration, {
    kind: "openapi",
    targetOrigin: "https://app.acme.example",
    testPageUrl: "https://app.acme.example/checkout",
    environment: "production"
  });

  storage.setItem("page2webmcp.workflow.v1", JSON.stringify({
    sourceType: "openapi",
    url: "https://api.acme.example/openapi.json",
    sourceConfiguration: { kind: "openapi", targetOrigin: "not-a-url", testPageUrl: "https://app.acme.example/", environment: "test" }
  }));
  assert.equal(loadWorkflow(storage), undefined);
  assert.equal(storage.getItem("page2webmcp.workflow.v1"), null);
});

test("authoritative refresh preserves compatible workflow and release recovery only for the same source and analysis", () => {
  const current = {
    sourceType: "openapi" as const,
    url: "https://api.acme.example/openapi.json",
    sourceConfiguration: {
      kind: "openapi" as const,
      targetOrigin: "https://app.acme.example",
      testPageUrl: "https://app.acme.example/checkout",
      environment: "staging" as const
    },
    projectId: "project-1",
    analysisRunId: "analysis-1",
    workflowRunId: "workflow-1",
    releaseUrl: "https://releases.acme.example/project-1"
  };
  const authoritative = {
    sourceType: current.sourceType,
    url: current.url,
    sourceConfiguration: current.sourceConfiguration,
    projectId: current.projectId,
    analysisRunId: current.analysisRunId
  };
  assert.deepEqual(reconcileProjectWorkflow(current, authoritative), current);

  assert.deepEqual(reconcileProjectWorkflow(current, { ...authoritative, projectId: "project-2" }), {
    ...authoritative,
    projectId: "project-2"
  });
  assert.deepEqual(reconcileProjectWorkflow(current, { ...authoritative, analysisRunId: "analysis-2" }), {
    ...authoritative,
    analysisRunId: "analysis-2"
  });
  assert.deepEqual(reconcileProjectWorkflow(current, {
    ...authoritative,
    sourceConfiguration: { ...authoritative.sourceConfiguration, environment: "production" }
  }), {
    ...authoritative,
    sourceConfiguration: { ...authoritative.sourceConfiguration, environment: "production" }
  });
});

test("clearing a workflow removes persisted workflow and pending operation keys only", () => {
  const storage = new MemoryStorage();
  saveWorkflow(storage, { sourceType: "website", url: "https://acme.example" });
  operationKey(storage, "create-project", "{}", () => "key-1");
  storage.setItem("unrelated", "keep");

  clearClientWorkflow(storage);

  assert.equal(loadWorkflow(storage), undefined);
  assert.equal(storage.getItem("unrelated"), "keep");
  assert.equal(storage.length, 1);
});

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}
