import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresControlPlaneRepository } from "./postgres.ts";
import type { RepositoryActor } from "./control-plane.ts";

test("idle PostgreSQL pool errors are handled with a non-sensitive structured diagnostic", async () => {
  const pool = new pg.Pool({ connectionString: "postgresql://example.invalid/database", allowExitOnIdle: true });
  const logs: string[] = [];
  const repository = new PostgresControlPlaneRepository({
    connectionString: "postgresql://ignored.invalid/database",
    pool,
    writeLog: (line) => logs.push(line)
  });

  assert.doesNotThrow(() => pool.emit("error", new Error("postgresql://user:secret@example.invalid/database")));
  assert.deepEqual(logs.map((line) => JSON.parse(line)), [{
    level: "error",
    event: "database_pool_error",
    outcome: "failure",
    code: "DATABASE_CONNECTION_ERROR",
    schema_version: 1
  }]);
  assert.doesNotMatch(logs[0]!, /secret|example\.invalid/);
  await repository.close();
});

test("completed OpenAPI results read their frozen snapshot after analysis evidence retention", async () => {
  const contentHash = "d".repeat(64);
  const sourceArtifact = {
    contentHash,
    artifactReference: `urn:sha256:${contentHash}`,
    finalUrl: "https://specs.widgets.example/openapi.json",
    mimeType: "application/json",
    sizeBytes: 87,
  } as const;
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      if (text.startsWith("select analysis.result")) {
        return { rows: [{
          result: {
            diagnostics: [{ code: "NO_SUPPORTED_OPERATIONS", operationKey: "document" }],
            sourceArtifact,
          },
          release_code: null,
          release_hash: null,
          allowed_origin: null,
          release_manifest: null,
          provider_mode: "openapi",
          provider_adapter: "bounded-openapi",
          provider_adapter_version: 1,
          provider_fixture: false,
          source_content_hash: sourceArtifact.contentHash,
          source_artifact_reference: sourceArtifact.artifactReference,
          source_artifact_metadata: {
            finalUrl: sourceArtifact.finalUrl,
            mimeType: sourceArtifact.mimeType,
            sizeBytes: sourceArtifact.sizeBytes,
          },
        }] };
      }
      if (text.startsWith("select plan, status")) return { rows: [] };
      if (text.startsWith("select id, organization_id") && text.includes("from public.analysis_evidence")) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    on: () => undefined,
    end: async () => undefined,
  } as unknown as pg.Pool;
  const repository = new PostgresControlPlaneRepository({
    connectionString: "postgresql://ignored.invalid/database",
    pool,
  });
  const actor: RepositoryActor = {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    role: "owner",
  };

  assert.deepEqual((await repository.getAnalysisResult(actor, "22222222-2222-2222-2222-222222222222"))?.sourceArtifact,
    sourceArtifact);
  assert.equal(queries.some((text) => text.includes("expires_at > now()")), true);
  await repository.close();
});
