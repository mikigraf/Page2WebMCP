import { unsafeSupabaseBrowserKey } from "./supabase-config.ts";
import { validateReleaseArtifactStorageConfiguration } from "./artifact-storage.ts";

type RuntimeEnvironment = Record<string, string | undefined>;

export function validateRuntimeConfiguration(environment: RuntimeEnvironment = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  if ((environment.PAGE2WEBMCP_SESSION_SECRET?.length ?? 0) < 32) throw new Error("SESSION_SECRET_REQUIRED");
  validateReleaseArtifactStorageConfiguration(environment);
  validateSupabaseConfiguration(environment);
  const publicOrigin = exactUrl(environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN ?? "");
  if (!publicOrigin
    || !exactOrigin(publicOrigin)
    || (publicOrigin.protocol !== "https:" && !localStackHttpOrigin(publicOrigin, environment, "3100"))) {
    throw new Error("INVALID_CONTROL_PLANE_PUBLIC_ORIGIN");
  }
  validateSharedRuntimeConfiguration(environment, true);
}

export function validateWorkerRuntimeConfiguration(environment: RuntimeEnvironment = process.env): void {
  validateSharedRuntimeConfiguration(environment, false);
}

function validateSharedRuntimeConfiguration(environment: RuntimeEnvironment, allowTestMemory: boolean): void {
  const providerMode = environment.PAGE2WEBMCP_PROVIDER_MODE;
  if (providerMode !== undefined
    && !["local", "openapi", "website", "github"].includes(providerMode)) {
    throw new Error("INVALID_PROVIDER_MODE");
  }
  const storageMode = environment.PAGE2WEBMCP_STORAGE_MODE ?? "postgres";
  if (storageMode === "memory") {
    if (!allowTestMemory) throw new Error("WORKER_POSTGRES_REQUIRED");
    const explicitTestRuntime = environment.CI === "true" || environment.PAGE2WEBMCP_TEST_MODE === "true";
    if (environment.PAGE2WEBMCP_ALLOW_EPHEMERAL_STORAGE !== "true" || !explicitTestRuntime) {
      throw new Error("EPHEMERAL_STORAGE_FORBIDDEN");
    }
  } else if (storageMode === "postgres") {
    if (!environment.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  } else {
    throw new Error("INVALID_STORAGE_MODE");
  }
  if (!allowTestMemory && (providerMode === undefined || providerMode === "local")) {
    throw new Error("WORKER_PROVIDER_MODE_REQUIRED");
  }

}

function validateSupabaseConfiguration(environment: RuntimeEnvironment): void {
  const url = exactUrl(environment.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const key = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? environment.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? "";
  if (!url || !exactOrigin(url)
    || (url.protocol !== "https:" && !localStackHttpOrigin(url, environment, "58321"))
    || key.length < 20 || unsafeSupabaseBrowserKey(key)) {
    throw new Error("SUPABASE_CONFIGURATION_REQUIRED");
  }
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith("NEXT_PUBLIC_") && name.includes("SUPABASE")
      && /(?:KEY|TOKEN|SECRET)$/.test(name) && value
      && unsafeSupabaseBrowserKey(value)) {
      throw new Error("SUPABASE_SECRET_EXPOSURE_BLOCKED");
    }
  }
}

function exactOrigin(url: URL): boolean {
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
}

function localStackHttpOrigin(url: URL, environment: RuntimeEnvironment, expectedPort: string): boolean {
  return environment.PAGE2WEBMCP_LOCAL_STACK === "true"
    && url.protocol === "http:"
    && ["127.0.0.1", "[::1]"].includes(url.hostname)
    && url.port === expectedPort
    && exactOrigin(url);
}

function exactUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
