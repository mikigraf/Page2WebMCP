import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  configuredReleaseVerificationPort,
  type VerifierIdentity,
} from "../apps/control-plane/src/release-verification.ts";
import {
  createProductionProvider,
  inspectProductionProviderConfiguration,
} from "../apps/worker/src/production-runtime.ts";
import {
  createMaintenanceReadinessRepository,
  type MaintenanceReadinessRepository,
} from "../packages/database/src/readiness.ts";
import {
  checkPackageVersionDrift,
  evaluateDeploymentReadiness,
  type NativeInstallationProof,
  type ReadinessMode,
} from "../packages/operations/src/readiness.ts";

const HOSTED_PUBLIC_ORIGIN =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const LOCAL_PUBLIC_ORIGIN =
  "http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases";
const HASH = /^[0-9a-f]{64}$/;
const MAX_ARTIFACT_BYTES = 65_536;
const ARTIFACT_TIMEOUT_MS = 10_000;

type Environment = Readonly<Record<string, string | undefined>>;
type Output = Readonly<{
  status: "passed" | "failed" | "skipped";
  code: string;
  liveSuccess: boolean;
  missingKeys?: readonly string[];
}>;
type CliResult = Readonly<{ output: Output; exitCode: 0 | 1 | 2 }>;

export type ReadinessCliDependencies = Readonly<{
  fetch?: typeof fetch;
  constructProvider?: typeof createProductionProvider;
  handshake?: (environment: Environment, mode: "local_live" | "live", signal: AbortSignal) => Promise<VerifierIdentity>;
  createMaintenanceRepository?: (input: Readonly<{
    connectionString: string;
    mode: "local-live" | "live";
  }>) => MaintenanceReadinessRepository;
}>;

export function parseReadinessMode(args: readonly string[]): ReadinessMode {
  if (args.length !== 1 || !["--hermetic", "--local-live", "--live"].includes(args[0]!)) {
    throw new Error("READINESS_MODE_REQUIRED");
  }
  return args[0]!.slice(2) as ReadinessMode;
}

export async function runReadinessCli(
  args: readonly string[],
  environment: Environment,
  dependencies: ReadinessCliDependencies = {},
): Promise<CliResult> {
  let mode: ReadinessMode;
  try { mode = parseReadinessMode(args); }
  catch { return result("failed", "READINESS_MODE_REQUIRED", 1); }

  const local = await localFacts();
  if (mode === "hermetic") {
    const output = evaluateDeploymentReadiness({ mode, ...local, artifactIntegrityVerified: true });
    return { output, exitCode: output.status === "passed" ? 0 : 1 };
  }

  const controls = inspectControls(environment, mode);
  if (controls.missingKeys.length > 0) {
    return {
      output: { status: "skipped", code: "LIVE_CONTROLS_REQUIRED", liveSuccess: false,
        missingKeys: controls.missingKeys },
      exitCode: 2,
    };
  }
  const selectedHash = environment.PAGE2WEBMCP_READINESS_RELEASE_HASH;
  if (!selectedHash || !HASH.test(selectedHash)) {
    return result("skipped", "LIVE_INSTALLATION_EVIDENCE_REQUIRED", 2);
  }

  const constructProvider = dependencies.constructProvider ?? createProductionProvider;
  let provider: ReturnType<typeof createProductionProvider>;
  try {
    provider = constructProvider(environment, { fetch: dependencies.fetch ?? fetch });
  } catch {
    const inspection = inspectProductionProviderConfiguration(environment);
    if (inspection.code === "PRODUCTION_PROVIDER_CONFIGURATION_READY") {
      return result("failed", "PROVIDER_CONSTRUCTION_FAILED", 1);
    }
    return {
      output: { status: "skipped", code: inspection.code, liveSuccess: false,
        ...(inspection.keys.length > 0 ? { missingKeys: [...new Set(inspection.keys)].sort() } : {}) },
      exitCode: inspection.code === "INVALID_PROVIDER_MODE" || inspection.code === "WORKER_PROVIDER_MODE_REQUIRED" ? 1 : 2,
    };
  }

  let artifact: Readonly<{ contentHash: string; integrity: string; localOnly: boolean; publicOrigin: string }>;
  try {
    artifact = await fetchSelectedArtifact(
      dependencies.fetch ?? fetch,
      controls.publicOrigin,
      selectedHash,
      mode === "local-live",
    );
  } catch {
    return result("failed", "ARTIFACT_INTEGRITY_FAILED", 1);
  }

  let verifier: VerifierIdentity;
  try {
    verifier = await (dependencies.handshake ?? defaultHandshake)(
      environment,
      mode === "live" ? "live" : "local_live",
      new AbortController().signal,
    );
  } catch {
    return result("failed", "RELEASE_VERIFIER_READINESS_FAILED", 1);
  }

  const createRepository = dependencies.createMaintenanceRepository
    ?? ((input) => createMaintenanceReadinessRepository(input));
  let repository: MaintenanceReadinessRepository | undefined;
  let proof: NativeInstallationProof | undefined;
  let topology: Readonly<{ migrationsCurrent: boolean; rlsVerified: boolean; selectedReleasePersisted: boolean }>;
  try {
    repository = createRepository({
      connectionString: environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL!,
      mode: mode === "live" ? "live" : "local-live",
    });
    topology = await repository.inspectSelectedReleaseTopology(
      selectedHash,
      provider.provenance,
      mode === "local-live",
    );
    if (mode === "live") proof = await repository.findSelectedNativeInstallationProof(selectedHash);
  } catch {
    return result("failed", "MAINTENANCE_DATABASE_READINESS_FAILED", 1);
  } finally {
    try { await repository?.close(); } catch { /* diagnostic export must stay redacted */ }
  }

  const output = evaluateDeploymentReadiness({
    mode,
    ...local,
    migrationsCurrent: local.migrationsCurrent && topology.migrationsCurrent,
    rlsVerified: local.rlsVerified && topology.rlsVerified,
    artifactIntegrityVerified: true,
    liveControlsConfigured: true,
    persistedJourneyVerified: topology.selectedReleasePersisted,
    selectedReleaseHash: selectedHash,
    provider: { ...provider.provenance, constructed: true },
    storage: artifact,
    verifier,
    installationProof: proof,
  });
  const exitCode = output.status === "passed" ? 0 : output.status === "skipped" ? 2 : 1;
  return { output, exitCode };
}

async function defaultHandshake(
  environment: Environment,
  mode: "local_live" | "live",
  signal: AbortSignal,
): Promise<VerifierIdentity> {
  const port = configuredReleaseVerificationPort(environment, { mode });
  return port.readiness(signal);
}

async function fetchSelectedArtifact(
  transport: typeof fetch,
  publicOrigin: string,
  selectedHash: string,
  localOnly: boolean,
): Promise<Readonly<{ contentHash: string; integrity: string; localOnly: boolean; publicOrigin: string }>> {
  const url = `${publicOrigin}/${selectedHash}.js`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("ARTIFACT_TIMEOUT")), ARTIFACT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await transport(url, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
    });
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const declared = response.headers.get("content-length");
    if (response.url !== url || response.redirected || response.status !== 200 || response.headers.has("set-cookie")
      || mediaType !== "application/javascript"
      || declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_ARTIFACT_BYTES)) {
      throw new Error("ARTIFACT_INVALID");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("ARTIFACT_INVALID");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new Error("ARTIFACT_INVALID");
      }
      chunks.push(chunk.value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length === 0 || contentHash !== selectedHash) throw new Error("ARTIFACT_INVALID");
    return {
      contentHash,
      integrity: `sha384-${createHash("sha384").update(bytes).digest("base64")}`,
      localOnly,
      publicOrigin,
    };
  } finally { clearTimeout(timer); }
}

function inspectControls(environment: Environment, mode: Exclude<ReadinessMode, "hermetic">): Readonly<{
  missingKeys: string[];
  publicOrigin: string;
}> {
  const invalid = new Set<string>();
  if (environment.PAGE2WEBMCP_STORAGE_MODE !== "postgres") invalid.add("PAGE2WEBMCP_STORAGE_MODE");
  if (!exactDatabaseUrl(environment.DATABASE_URL, mode)) invalid.add("DATABASE_URL");
  if (!exactDatabaseUrl(environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL, mode)) {
    invalid.add("PAGE2WEBMCP_MAINTENANCE_DATABASE_URL");
  }
  if (!boundedSecret(environment.PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN)) {
    invalid.add("PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN");
  }
  const publicOrigin = mode === "live" ? HOSTED_PUBLIC_ORIGIN : LOCAL_PUBLIC_ORIGIN;
  if (environment.PAGE2WEBMCP_PUBLIC_ORIGIN !== publicOrigin) invalid.add("PAGE2WEBMCP_PUBLIC_ORIGIN");
  if (mode === "live") {
    if (!exactHttpsOrigin(environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN)) {
      invalid.add("PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN");
    }
    if (!exactHttpsOrigin(environment.PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN)) {
      invalid.add("PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN");
    }
  } else {
    if (environment.PAGE2WEBMCP_LOCAL_STACK !== "true") invalid.add("PAGE2WEBMCP_LOCAL_STACK");
    if (!exactLocalControlOrigin(environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN)) {
      invalid.add("PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN");
    }
    if (!exactLoopbackOrigin(environment.PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN)) {
      invalid.add("PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN");
    }
  }
  const provider = inspectProductionProviderConfiguration(environment);
  if (provider.code !== "PRODUCTION_PROVIDER_CONFIGURATION_READY") {
    for (const key of provider.keys) invalid.add(key);
  }
  return { missingKeys: [...invalid].sort(), publicOrigin };
}

async function localFacts() {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const migrations = await readdir(new URL("../supabase/migrations/", import.meta.url));
  const task8 = await readFile(new URL(
    "../supabase/migrations/20260831120000_live_readiness_attestation.sql", import.meta.url,
  ), "utf8");
  const task6 = await readFile(new URL(
    "../supabase/migrations/20260830094622_trusted_release_installations.sql", import.meta.url,
  ), "utf8");
  return {
    versionDrift: checkPackageVersionDrift(packageJson),
    migrationsCurrent: migrations.includes("20260831120000_live_readiness_attestation.sql"),
    rlsVerified: /selected_native_installation_proof/i.test(task8)
      && /grant execute[^;]+page2webmcp_maintenance/is.test(task8)
      && /force row level security/i.test(task6),
  };
}

function boundedSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && value.trim() === value && !/[\r\n]/.test(value);
}

function exactHttpsOrigin(value: string | undefined): value is string {
  if (!value || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function exactLoopbackOrigin(value: string | undefined): value is string {
  if (!value || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && parsed.origin === value
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
      && parsed.port !== "" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function exactLocalControlOrigin(value: string | undefined): value is string {
  if (!exactLoopbackOrigin(value)) return false;
  return new URL(value).port === "3100";
}

function exactDatabaseUrl(
  value: string | undefined,
  mode: Exclude<ReadinessMode, "hermetic">,
): value is string {
  if (!value || value.length < 32 || value.length > 4_096 || value.trim() !== value || /[\r\n]/.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    return (parsed.protocol === "postgresql:" || parsed.protocol === "postgres:")
      && parsed.username.length > 0 && parsed.password.length > 0
      && parsed.pathname.length > 1 && !parsed.hash && !parsed.search
      && (mode === "local-live" ? loopback : !loopback);
  } catch { return false; }
}

function result(status: Output["status"], code: string, exitCode: 0 | 1 | 2): CliResult {
  return { output: { status, code, liveSuccess: false }, exitCode };
}

async function main(): Promise<void> {
  const outcome = await runReadinessCli(process.argv.slice(2), process.env);
  process.stdout.write(`${JSON.stringify(outcome.output)}\n`);
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
