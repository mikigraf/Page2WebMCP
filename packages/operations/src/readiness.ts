export const PINNED_RELEASE_VERSIONS = Object.freeze({
  node: "24",
  pnpm: "10.14.0",
  typescript: "5.9.2",
  next: "16.3.3",
  react: "19.2.8",
  playwright: "1.62.1",
  supabaseJs: "2.112.4",
  supabaseSsr: "0.12.5",
  browserUseApi: "v4",
  browserUseModel: "browser-use-2.0",
  githubApi: "2026-03-10",
  redocly: "2.45.0",
  compilerManifest: "3",
});

export type VersionDrift = Readonly<{ component: string; expected: string; actual: string }>;

type PackageManifest = Readonly<{
  packageManager?: unknown;
  engines?: Readonly<Record<string, unknown>>;
  dependencies?: Readonly<Record<string, unknown>>;
  devDependencies?: Readonly<Record<string, unknown>>;
}>;

export function checkPackageVersionDrift(manifest: PackageManifest): VersionDrift[] {
  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};
  const actual: Record<string, string> = {
    node: typeof manifest.engines?.node === "string" && /^>=24(?:\.0\.0)?$/.test(manifest.engines.node)
      ? "24" : String(manifest.engines?.node ?? "missing"),
    pnpm: typeof manifest.packageManager === "string" && manifest.packageManager.startsWith("pnpm@")
      ? manifest.packageManager.slice(5) : "missing",
    typescript: version(dependencies.typescript ?? devDependencies.typescript),
    next: version(dependencies.next),
    react: version(dependencies.react),
    playwright: version(devDependencies["@playwright/test"]),
    supabaseJs: version(dependencies["@supabase/supabase-js"]),
    supabaseSsr: version(dependencies["@supabase/ssr"]),
  };
  const expected = PINNED_RELEASE_VERSIONS;
  return Object.entries(actual).flatMap(([component, current]) => {
    const pinned = expected[component as keyof typeof expected];
    return current === pinned ? [] : [{ component, expected: pinned, actual: current }];
  });
}

type DeploymentReadinessInput = Readonly<{
  mode: "hermetic" | "live";
  versionDrift: readonly VersionDrift[];
  migrationsCurrent: boolean;
  rlsVerified: boolean;
  artifactIntegrityVerified: boolean;
  liveControlsConfigured?: boolean;
}>;

export type DeploymentReadiness = Readonly<{
  status: "passed" | "failed" | "skipped";
  code: string;
  liveSuccess: boolean;
}>;

export function evaluateDeploymentReadiness(input: DeploymentReadinessInput): DeploymentReadiness {
  if (input.versionDrift.length > 0) return { status: "failed", code: "VERSION_DRIFT", liveSuccess: false };
  if (!input.migrationsCurrent) return { status: "failed", code: "MIGRATIONS_OUTDATED", liveSuccess: false };
  if (!input.rlsVerified) return { status: "failed", code: "RLS_NOT_VERIFIED", liveSuccess: false };
  if (!input.artifactIntegrityVerified) return { status: "failed", code: "ARTIFACT_INTEGRITY_FAILED", liveSuccess: false };
  if (input.mode === "hermetic") return { status: "passed", code: "HERMETIC_READINESS_PASSED", liveSuccess: false };
  if (input.liveControlsConfigured !== true) return { status: "skipped", code: "LIVE_CONTROLS_REQUIRED", liveSuccess: false };
  return { status: "passed", code: "LIVE_READINESS_PASSED", liveSuccess: true };
}

export const RECOVERY_SCENARIOS = Object.freeze([
  "provider_outage",
  "stuck_workflow",
  "leaked_browser_session",
  "bad_model_parser_compiler",
  "compromised_artifact",
  "github_revocation",
  "rollback",
  "restore",
] as const);

export type RecoveryScenario = typeof RECOVERY_SCENARIOS[number];
export type RecoveryResult = Readonly<{
  scenario: RecoveryScenario;
  status: "passed" | "failed";
  failures: string[];
}>;

export function runRecoveryCheck(scenario: RecoveryScenario, input: Readonly<Record<string, boolean>>): RecoveryResult {
  const failures: string[] = [];
  if (scenario === "provider_outage") {
    requireFact(input.providerUnavailable, failures, "OUTAGE_NOT_REPRODUCED");
    requireFact(input.retryScheduled, failures, "RETRY_NOT_SCHEDULED");
    rejectFact(input.duplicateSideEffect, failures, "DUPLICATE_SIDE_EFFECT");
  } else if (scenario === "stuck_workflow") {
    requireFact(input.expiredLease, failures, "LEASE_NOT_EXPIRED");
    requireFact(input.reconciled, failures, "WORKFLOW_NOT_RECONCILED");
    rejectFact(input.duplicateClaim, failures, "DUPLICATE_CLAIM");
  } else if (scenario === "leaked_browser_session") {
    requireFact(input.terminal, failures, "WORKFLOW_NOT_TERMINAL");
    requireFact(input.reconcileAttempted, failures, "BROWSER_RECONCILE_NOT_ATTEMPTED");
    rejectFact(input.browserSessionActive, failures, "BROWSER_SESSION_LEAKED");
  } else if (scenario === "bad_model_parser_compiler") {
    requireFact(input.invalidCandidate, failures, "INVALID_CANDIDATE_NOT_REPRODUCED");
    requireFact(input.promotionBlocked, failures, "PROMOTION_NOT_BLOCKED");
  } else if (scenario === "compromised_artifact") {
    requireFact(input.hashMismatch, failures, "HASH_MISMATCH_NOT_REPRODUCED");
    requireFact(input.deliveryBlocked, failures, "DELIVERY_NOT_BLOCKED");
    requireFact(input.previousReleaseImmutable, failures, "PREVIOUS_RELEASE_MUTABLE");
  } else if (scenario === "github_revocation") {
    requireFact(input.revoked, failures, "GITHUB_NOT_REVOKED");
    requireFact(input.workflowStopped, failures, "WORKFLOW_NOT_STOPPED");
    rejectFact(input.merged, failures, "AUTONOMOUS_MERGE");
    rejectFact(input.installed, failures, "AUTONOMOUS_INSTALL");
  } else if (scenario === "rollback") {
    requireFact(input.previousReleaseImmutable, failures, "PREVIOUS_RELEASE_MUTABLE");
    requireFact(input.pointerChanged, failures, "ROLLBACK_POINTER_UNCHANGED");
    rejectFact(input.artifactMutated, failures, "IMMUTABLE_ARTIFACT_MUTATED");
  } else {
    requireFact(input.restored, failures, "RESTORE_NOT_COMPLETED");
    requireFact(input.migrationsCurrent, failures, "MIGRATIONS_OUTDATED");
    requireFact(input.rlsVerified, failures, "RLS_NOT_VERIFIED");
    requireFact(input.integrityVerified, failures, "RESTORE_INTEGRITY_FAILED");
  }
  return { scenario, status: failures.length === 0 ? "passed" : "failed", failures: failures.sort(compareStrings) };
}

function version(value: unknown): string {
  return typeof value === "string" ? value : "missing";
}

function requireFact(value: boolean | undefined, failures: string[], code: string): void {
  if (value !== true) failures.push(code);
}

function rejectFact(value: boolean | undefined, failures: string[], code: string): void {
  if (value === true) failures.push(code);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
