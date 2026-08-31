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

export type ReadinessMode = "hermetic" | "local-live" | "live";

export type ReadinessVerifierIdentity = Readonly<{
  protocolVersion: number;
  mode: "hermetic" | "local_live" | "live";
  webMcpImplementation: "native";
  verifierOriginDigest: string;
}>;

export type ProductionProviderProvenance =
  | Readonly<{ mode: "openapi"; adapter: "bounded-openapi"; adapterVersion: 1; fixture: false }>
  | Readonly<{ mode: "website"; adapter: "browser-use-v4"; adapterVersion: 4; fixture: false }>
  | Readonly<{ mode: "github"; adapter: "github-app"; adapterVersion: 20260310; fixture: false }>;

type SelectedSourceIdentity = Readonly<{
  sourceUrl: string;
  sourceIdentityHash: string;
}>;

export type SelectedProviderProbeContext =
  | SelectedSourceIdentity & Readonly<{
    sourceType: "openapi";
    sourceConfiguration: Readonly<{
      kind: "openapi";
      targetOrigin: string;
      testPageUrl: string;
      environment: "test" | "staging" | "production";
    }>;
  }>
  | SelectedSourceIdentity & Readonly<{
    sourceType: "website";
    sourceConfiguration: Readonly<{ kind: "website" }>;
  }>
  | SelectedSourceIdentity & Readonly<{
    sourceType: "github";
    sourceConfiguration: Readonly<{ kind: "github" }>;
    binding: Readonly<{
      installationId: number;
      repositoryId: number;
      owner: string;
      repository: string;
      ref: string;
      commitSha: string;
      targetOrigin: string;
    }>;
  }>;

export type NativeInstallationProof = Readonly<{
  selectedReleaseHash: string;
  releaseContentHash: string;
  releaseIntegrity: string;
  candidateObservedIntegrity: string;
  installationObservedIntegrity: string;
  servedContentHash: string;
  executedContentHash: string;
  trustedLoaderContentHash: string;
  releaseVerificationRunId: string;
  candidateVerificationRunId: string;
  candidateMode: "hermetic" | "local_live" | "live";
  installationMode: "hermetic" | "local_live" | "live";
  candidateProtocolVersion: number;
  installationProtocolVersion: number;
  candidateVerifierOriginDigest: string;
  installationVerifierOriginDigest: string;
  candidateWebMcpImplementation: "native";
  installationWebMcpImplementation: "native";
  providerMode: "openapi" | "website" | "github" | "local";
  providerAdapter: string;
  providerAdapterVersion: number;
  sourceType: "openapi" | "website" | "github";
  providerFixture: boolean;
  sourceFixture: boolean;
  localOnly: boolean;
  targetIdentityMatches: boolean;
  artifactIdentityMatches: boolean;
  capabilityDigestMatches: boolean;
  expectedToolsDigest: string;
  registeredToolsDigest: string;
  expectedToolCount: number;
  registeredToolCount: number;
  normalPageLoad: boolean;
  routeInterception: boolean;
  injectedRegistration: boolean;
  syntheticHarness: boolean;
  duplicateLoadHarmless: boolean;
  authenticatedReadExecuted: boolean;
  confirmedReversibleMutationExecuted: boolean;
  confirmedMutationEffectCount: number;
  authoritativeFinalStateVerified: boolean;
  executionToolsMatchCapabilities: boolean;
  zeroControlPlaneCalls: boolean;
  zeroModelCalls: boolean;
  trustedLoaderEnforced: boolean;
  candidateChecksPassed: boolean;
}>;

export type DeploymentReadinessInput = Readonly<{
  mode: ReadinessMode;
  versionDrift: readonly VersionDrift[];
  migrationsCurrent: boolean;
  rlsVerified: boolean;
  artifactIntegrityVerified: boolean;
  persistedJourneyVerified?: boolean;
  liveControlsConfigured?: boolean;
  selectedReleaseHash?: string;
  provider?: ProductionProviderProvenance & Readonly<{ constructed: boolean }>;
  storage?: Readonly<{
    contentHash: string;
    integrity: string;
    localOnly: boolean;
    publicOrigin: string;
  }>;
  verifier?: ReadinessVerifierIdentity;
  installationProof?: NativeInstallationProof;
}>;

export type DeploymentReadiness = Readonly<{
  status: "passed" | "failed" | "skipped";
  code: string;
  liveSuccess: boolean;
}>;

export function evaluateDeploymentReadiness(input: DeploymentReadinessInput): DeploymentReadiness {
  if (input.mode !== "hermetic" && input.mode !== "local-live" && input.mode !== "live") {
    return { status: "failed", code: "INVALID_READINESS_MODE", liveSuccess: false };
  }
  if (input.versionDrift.length > 0) return { status: "failed", code: "VERSION_DRIFT", liveSuccess: false };
  if (!input.migrationsCurrent) return { status: "failed", code: "MIGRATIONS_OUTDATED", liveSuccess: false };
  if (!input.rlsVerified) return { status: "failed", code: "RLS_NOT_VERIFIED", liveSuccess: false };
  if (!input.artifactIntegrityVerified) return { status: "failed", code: "ARTIFACT_INTEGRITY_FAILED", liveSuccess: false };
  if (input.mode === "hermetic") return { status: "passed", code: "HERMETIC_READINESS_PASSED", liveSuccess: false };
  if (input.mode === "local-live") {
    if (input.persistedJourneyVerified !== true) {
      return { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false };
    }
    return { status: "passed", code: "LOCAL_LIVE_READINESS_PASSED", liveSuccess: false };
  }
  if (input.liveControlsConfigured !== true) {
    return { status: "skipped", code: "LIVE_CONTROLS_REQUIRED", liveSuccess: false };
  }
  if (!exactNativeInstallationProof(input)) {
    return { status: "skipped", code: "LIVE_INSTALLATION_EVIDENCE_REQUIRED", liveSuccess: false };
  }
  return { status: "passed", code: "LIVE_READINESS_PASSED", liveSuccess: true };
}

const SHA256 = /^[0-9a-f]{64}$/;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HOSTED_PUBLIC_ORIGIN =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";

function exactNativeInstallationProof(input: DeploymentReadinessInput): boolean {
  const selected = input.selectedReleaseHash;
  const provider = input.provider;
  const storage = input.storage;
  const verifier = input.verifier;
  const proof = input.installationProof;
  if (input.persistedJourneyVerified !== true
    || !selected || !SHA256.test(selected) || !provider || provider.constructed !== true
    || !storage || !verifier || !proof) return false;
  return exactProductionProvider(provider)
    && storage.publicOrigin === HOSTED_PUBLIC_ORIGIN
    && storage.localOnly === false
    && storage.contentHash === selected
    && SRI.test(storage.integrity)
    && verifier.protocolVersion === 1
    && verifier.mode === "live"
    && verifier.webMcpImplementation === "native"
    && SHA256.test(verifier.verifierOriginDigest)
    && proof.selectedReleaseHash === selected
    && proof.releaseContentHash === selected
    && proof.servedContentHash === selected
    && proof.executedContentHash === selected
    && proof.trustedLoaderContentHash === selected
    && proof.releaseIntegrity === storage.integrity
    && proof.candidateObservedIntegrity === storage.integrity
    && proof.installationObservedIntegrity === storage.integrity
    && SRI.test(proof.releaseIntegrity)
    && UUID.test(proof.releaseVerificationRunId)
    && proof.candidateVerificationRunId === proof.releaseVerificationRunId
    && proof.candidateMode === "live"
    && proof.installationMode === "live"
    && proof.candidateProtocolVersion === verifier.protocolVersion
    && proof.installationProtocolVersion === verifier.protocolVersion
    && proof.candidateVerifierOriginDigest === verifier.verifierOriginDigest
    && proof.installationVerifierOriginDigest === verifier.verifierOriginDigest
    && proof.candidateWebMcpImplementation === "native"
    && proof.installationWebMcpImplementation === "native"
    && proof.providerMode === provider.mode
    && proof.providerAdapter === provider.adapter
    && proof.providerAdapterVersion === provider.adapterVersion
    && proof.sourceType === provider.mode
    && proof.providerFixture === false
    && proof.sourceFixture === false
    && proof.localOnly === false
    && proof.targetIdentityMatches === true
    && proof.artifactIdentityMatches === true
    && proof.capabilityDigestMatches === true
    && SHA256.test(proof.expectedToolsDigest)
    && proof.registeredToolsDigest === proof.expectedToolsDigest
    && Number.isInteger(proof.expectedToolCount)
    && proof.expectedToolCount >= 1
    && proof.expectedToolCount <= 100
    && proof.registeredToolCount === proof.expectedToolCount
    && proof.normalPageLoad === true
    && proof.routeInterception === false
    && proof.injectedRegistration === false
    && proof.syntheticHarness === false
    && proof.duplicateLoadHarmless === true
    && proof.authenticatedReadExecuted === true
    && proof.confirmedReversibleMutationExecuted === true
    && proof.confirmedMutationEffectCount === 1
    && proof.authoritativeFinalStateVerified === true
    && proof.executionToolsMatchCapabilities === true
    && proof.zeroControlPlaneCalls === true
    && proof.zeroModelCalls === true
    && proof.trustedLoaderEnforced === true
    && proof.candidateChecksPassed === true;
}

function exactProductionProvider(provider: ProductionProviderProvenance): boolean {
  if (provider.fixture !== false) return false;
  if (provider.mode === "openapi") {
    return provider.adapter === "bounded-openapi" && provider.adapterVersion === 1;
  }
  if (provider.mode === "website") {
    return provider.adapter === "browser-use-v4" && provider.adapterVersion === 4;
  }
  return provider.mode === "github"
    && provider.adapter === "github-app"
    && provider.adapterVersion === 20260310;
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
