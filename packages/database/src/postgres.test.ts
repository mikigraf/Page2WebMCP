import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresControlPlaneRepository } from "./postgres.ts";

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
