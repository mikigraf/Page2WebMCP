import { InMemoryControlPlaneRepository, type ControlPlaneRepository } from "./control-plane.ts";
import { createPostgresRepository } from "./postgres.ts";

type FactoryOptions = {
  nodeEnv?: string;
  mode?: "memory" | "postgres";
  databaseUrl?: string;
  allowEphemeralStorage?: boolean;
};

let singleton: ControlPlaneRepository | undefined;

export function createControlPlaneRepository(options: FactoryOptions = {}): ControlPlaneRepository {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const mode = options.mode
    ?? parseMode(process.env.PAGE2WEBMCP_STORAGE_MODE)
    ?? (databaseUrl ? "postgres" : nodeEnv === "production" ? "postgres" : "memory");

  const allowEphemeralStorage = options.allowEphemeralStorage
    ?? process.env.PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE === "true";
  if (mode === "memory") {
    if (nodeEnv === "production" && !allowEphemeralStorage) throw new Error("EPHEMERAL_STORAGE_FORBIDDEN");
    return new InMemoryControlPlaneRepository();
  }
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  return createPostgresRepository({ connectionString: databaseUrl });
}

export function getControlPlaneRepository(): ControlPlaneRepository {
  singleton ??= createControlPlaneRepository();
  return singleton;
}

export function setControlPlaneRepositoryForTest(repository: ControlPlaneRepository | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_REPOSITORY_OVERRIDE_FORBIDDEN");
  singleton = repository;
}

function parseMode(value: string | undefined): "memory" | "postgres" | undefined {
  if (!value) return undefined;
  if (value === "memory" || value === "postgres") return value;
  throw new Error("INVALID_STORAGE_MODE");
}
