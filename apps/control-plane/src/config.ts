type RuntimeEnvironment = Record<string, string | undefined>;

export function validateRuntimeConfiguration(environment: RuntimeEnvironment = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  if ((environment.PAGE2WEBMCP_SESSION_SECRET?.length ?? 0) < 32) throw new Error("SESSION_SECRET_REQUIRED");
  const ownerPassword = environment.PAGE2WEBMCP_OWNER_PASSWORD ?? "";
  const editorPassword = environment.PAGE2WEBMCP_EDITOR_PASSWORD ?? "";
  if (ownerPassword.length < 32 || editorPassword.length < 32) throw new Error("AUTH_CREDENTIALS_REQUIRED");
  if (ownerPassword === editorPassword) throw new Error("AUTH_CREDENTIALS_MUST_DIFFER");
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
  if (environment.PAGE2WEBMCP_PROVIDER_MODE && environment.PAGE2WEBMCP_PROVIDER_MODE !== "local") {
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

  const fixtureApp = exactUrl(environment.PAGE2WEBMCP_FIXTURE_APP_URL ?? "https://acme.example");
  if (!fixtureApp || fixtureApp.protocol !== "https:" || fixtureApp.origin !== fixtureApp.toString().replace(/\/$/, "")) {
    throw new Error("INVALID_FIXTURE_APP_URL");
  }
  const fixtureGithub = exactUrl(environment.PAGE2WEBMCP_FIXTURE_GITHUB_URL ?? "https://github.com/acme/support");
  if (!fixtureGithub || fixtureGithub.protocol !== "https:" || fixtureGithub.hostname !== "github.com") {
    throw new Error("INVALID_FIXTURE_GITHUB_URL");
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
