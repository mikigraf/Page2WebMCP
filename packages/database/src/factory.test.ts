import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryControlPlaneRepository } from "./control-plane.ts";
import { createControlPlaneRepository } from "./factory.ts";
import { PostgresControlPlaneRepository } from "./postgres.ts";

test("repository factory fails closed for ephemeral storage in production", () => {
  assert.throws(
    () => createControlPlaneRepository({ nodeEnv: "production", mode: "postgres" }),
    /DATABASE_URL_REQUIRED/
  );
  assert.throws(
    () => createControlPlaneRepository({ nodeEnv: "production", mode: "memory", allowEphemeralStorage: false }),
    /EPHEMERAL_STORAGE_FORBIDDEN/
  );
  assert.ok(createControlPlaneRepository({
    nodeEnv: "production",
    mode: "memory",
    allowEphemeralStorage: true
  }) instanceof InMemoryControlPlaneRepository);
  assert.ok(createControlPlaneRepository({ nodeEnv: "test", mode: "memory" }) instanceof InMemoryControlPlaneRepository);
  const postgres = createControlPlaneRepository({
    nodeEnv: "production",
    mode: "postgres",
    databaseUrl: "postgresql://example.invalid/database"
  });
  assert.ok(postgres instanceof PostgresControlPlaneRepository);
});
