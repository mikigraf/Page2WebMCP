import assert from "node:assert/strict";
import test from "node:test";
import { startGateway, envelope, sha256Hex, TEST_TOKENS } from "./harness.ts";

const token = TEST_TOKENS["evidence-store"];
const content = JSON.stringify({ version: 1, observations: [] });

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: "org-1",
    projectId: "project-1",
    analysisRunId: "run-1",
    source: "runtime",
    content,
    reference: `urn:sha256:${sha256Hex(content)}`,
    ...overrides,
  };
}

test("evidence put verifies the content hash and get returns the identical record", async () => {
  const gateway = await startGateway();
  try {
    const stored = await gateway.json("/v1/website-evidence/put", envelope("evidence-put", { record: record() }), { token });
    assert.equal(stored.status, 200);
    assert.equal(stored.body?.reference, `urn:sha256:${sha256Hex(content)}`);
    assert.equal(stored.body?.organizationId, "org-1");

    const read = await gateway.json("/v1/website-evidence/get", envelope("evidence-get", {
      reference: `urn:sha256:${sha256Hex(content)}`,
      organizationId: "org-1", projectId: "project-1", analysisRunId: "run-1",
    }), { token });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body?.record, record());
  } finally { await gateway.close(); }
});

test("evidence put rejects a content hash mismatch and a non-runtime source", async () => {
  const gateway = await startGateway();
  try {
    const mismatched = await gateway.json("/v1/website-evidence/put",
      envelope("evidence-put", { record: record({ reference: `urn:sha256:${"0".repeat(64)}` }) }), { token });
    assert.equal(mismatched.status, 400);
    const wrongSource = await gateway.json("/v1/website-evidence/put",
      envelope("evidence-put", { record: record({ source: "owner_review" }) }), { token });
    assert.equal(wrongSource.status, 400);
  } finally { await gateway.close(); }
});

test("evidence get refuses a different owner and an unknown reference", async () => {
  const gateway = await startGateway();
  try {
    await gateway.json("/v1/website-evidence/put", envelope("evidence-put", { record: record() }), { token });
    const wrongOwner = await gateway.json("/v1/website-evidence/get", envelope("evidence-get", {
      reference: `urn:sha256:${sha256Hex(content)}`,
      organizationId: "org-2", projectId: "project-1", analysisRunId: "run-1",
    }), { token });
    assert.equal(wrongOwner.status, 403);
    const unknown = await gateway.json("/v1/website-evidence/get", envelope("evidence-get", {
      reference: `urn:sha256:${"1".repeat(64)}`,
      organizationId: "org-1", projectId: "project-1", analysisRunId: "run-1",
    }), { token });
    assert.equal(unknown.status, 404);
  } finally { await gateway.close(); }
});

test("evidence put refuses a record whose ownership differs from the request envelope", async () => {
  const gateway = await startGateway();
  try {
    const foreign = await gateway.json("/v1/website-evidence/put",
      envelope("evidence-put", { record: record({ organizationId: "org-2" }) }), { token });
    assert.equal(foreign.status, 403);
  } finally { await gateway.close(); }
});
