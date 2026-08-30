import { unsafeSupabaseBrowserKey } from "./supabase-config.ts";

type RuntimeEnvironment = Record<string, string | undefined>;

export function validateRuntimeConfiguration(environment: RuntimeEnvironment = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  if ((environment.PAGE2WEBMCP_SESSION_SECRET?.length ?? 0) < 32) throw new Error("SESSION_SECRET_REQUIRED");
  validateSupabaseConfiguration(environment);
  const publicOrigin = exactUrl(environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN ?? "");
  const permitsHttp = environment.PAGE2WEBMCP_TEST_MODE === "true";
  if (!publicOrigin
    || publicOrigin.origin !== publicOrigin.toString().replace(/\/$/, "")
    || (publicOrigin.protocol !== "https:" && !(permitsHttp && publicOrigin.protocol === "http:"))) {
    throw new Error("INVALID_CONTROL_PLANE_PUBLIC_ORIGIN");
  }
  validateSharedRuntimeConfiguration(environment, true);
}

export function validateWorkerRuntimeConfiguration(environment: RuntimeEnvironment = process.env): void {
  validateSharedRuntimeConfiguration(environment, false);
}

function validateSharedRuntimeConfiguration(environment: RuntimeEnvironment, allowTestMemory: boolean): void {
  if (environment.PAGE2WEBMCP_PROVIDER_MODE
    && !["local", "github"].includes(environment.PAGE2WEBMCP_PROVIDER_MODE)) {
    throw new Error("LIVE_PROVIDER_UNSUPPORTED");
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

}

function validateSupabaseConfiguration(environment: RuntimeEnvironment): void {
  const url = exactUrl(environment.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const key = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? environment.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? "";
  const permitsHttp = environment.PAGE2WEBMCP_TEST_MODE === "true";
  if (!url || url.origin !== url.toString().replace(/\/$/, "")
    || (url.protocol !== "https:" && !(permitsHttp && url.protocol === "http:"))
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

function exactUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
