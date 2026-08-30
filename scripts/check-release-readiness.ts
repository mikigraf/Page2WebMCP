import { readFile, readdir } from "node:fs/promises";
import {
  checkPackageVersionDrift,
  evaluateDeploymentReadiness,
} from "../packages/operations/src/readiness.ts";

const live = process.argv.includes("--live");
if (live === process.argv.includes("--hermetic")) {
  console.error(JSON.stringify({ status: "failed", code: "READINESS_MODE_REQUIRED", liveSuccess: false }));
  process.exitCode = 1;
} else {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const migrations = await readdir(new URL("../supabase/migrations/", import.meta.url));
  const task8 = await readFile(new URL("../supabase/migrations/20260830094622_trusted_release_installations.sql", import.meta.url), "utf8");
  const task9 = await readFile(new URL("../supabase/migrations/20260830190000_workflow_event_observability.sql", import.meta.url), "utf8");
  const result = evaluateDeploymentReadiness({
    mode: live ? "live" : "hermetic",
    versionDrift: checkPackageVersionDrift(packageJson),
    migrationsCurrent: migrations.includes("20260830190000_workflow_event_observability.sql"),
    rlsVerified: /force row level security/i.test(task8) && /active workflow task lease required/i.test(task9),
    artifactIntegrityVerified: /artifact_content_hash/i.test(task8) && /integrity/i.test(task8),
    liveControlsConfigured: live ? liveControlsConfigured(process.env) : undefined,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "passed" ? 0 : result.status === "skipped" ? 2 : 1;
}

function liveControlsConfigured(environment: NodeJS.ProcessEnv): boolean {
  return environment.PAGE2WEBMCP_STORAGE_MODE === "postgres"
    && boundedSecret(environment.DATABASE_URL)
    && exactHttpsOrigin(environment.PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN)
    && boundedSecret(environment.PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN)
    && ["github", "website", "openapi"].includes(environment.PAGE2WEBMCP_PROVIDER_MODE ?? "");
}

function boundedSecret(value: string | undefined): boolean {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096;
}

function exactHttpsOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}
