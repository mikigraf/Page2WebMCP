import pg from "pg";
import { createHash } from "node:crypto";
import type {
  NativeInstallationProof,
  ProductionProviderProvenance,
  SelectedProviderProbeContext,
} from "../../operations/src/readiness.ts";
import { parsePersistedSourceConfiguration } from "./control-plane.ts";

type MaintenanceQueryResult = Readonly<{ rows: readonly Record<string, unknown>[] }>;
type MaintenanceReadinessClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<MaintenanceQueryResult>;
  release(): void;
}>;

export type MaintenanceReadinessPool = Readonly<{
  connect(): Promise<MaintenanceReadinessClient>;
  end(): Promise<void>;
}>;

export type MaintenanceReadinessRepository = Readonly<{
  inspectSelectedReleaseTopology(
    hash: string,
    provider: ProductionProviderProvenance,
    localOnly: boolean,
  ): Promise<Readonly<{
    migrationsCurrent: boolean;
    rlsVerified: boolean;
    selectedReleasePersisted: boolean;
    sessionIdentityDigest: string;
  }>>;
  loadSelectedProviderProbeContext(hash: string): Promise<SelectedProviderProbeContext | undefined>;
  findSelectedNativeInstallationProof(hash: string): Promise<NativeInstallationProof | undefined>;
  close(): Promise<void>;
}>;

export type ApplicationReadinessRepository = Readonly<{
  inspectApplicationRole(): Promise<Readonly<{ sessionIdentityDigest: string }>>;
  close(): Promise<void>;
}>;

type MaintenanceReadinessOptions = Readonly<{
  connectionString: string;
  mode: "local-live" | "live";
  pool?: MaintenanceReadinessPool;
  poolFactory?: (configuration: pg.PoolConfig) => MaintenanceReadinessPool;
  statementTimeoutMs?: number;
}>;

const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const PROOF_COLUMNS = Object.freeze({
  selected_release_hash: "selectedReleaseHash",
  release_content_hash: "releaseContentHash",
  release_integrity: "releaseIntegrity",
  candidate_observed_integrity: "candidateObservedIntegrity",
  installation_observed_integrity: "installationObservedIntegrity",
  served_content_hash: "servedContentHash",
  executed_content_hash: "executedContentHash",
  trusted_loader_content_hash: "trustedLoaderContentHash",
  release_verification_run_id: "releaseVerificationRunId",
  candidate_verification_run_id: "candidateVerificationRunId",
  candidate_mode: "candidateMode",
  installation_mode: "installationMode",
  candidate_protocol_version: "candidateProtocolVersion",
  installation_protocol_version: "installationProtocolVersion",
  candidate_verifier_origin_digest: "candidateVerifierOriginDigest",
  installation_verifier_origin_digest: "installationVerifierOriginDigest",
  candidate_webmcp_implementation: "candidateWebMcpImplementation",
  installation_webmcp_implementation: "installationWebMcpImplementation",
  provider_mode: "providerMode",
  provider_adapter: "providerAdapter",
  provider_adapter_version: "providerAdapterVersion",
  source_type: "sourceType",
  provider_fixture: "providerFixture",
  source_fixture: "sourceFixture",
  local_only: "localOnly",
  target_identity_matches: "targetIdentityMatches",
  artifact_identity_matches: "artifactIdentityMatches",
  capability_digest_matches: "capabilityDigestMatches",
  expected_tools_digest: "expectedToolsDigest",
  registered_tools_digest: "registeredToolsDigest",
  expected_tool_count: "expectedToolCount",
  registered_tool_count: "registeredToolCount",
  normal_page_load: "normalPageLoad",
  route_interception: "routeInterception",
  injected_registration: "injectedRegistration",
  synthetic_harness: "syntheticHarness",
  duplicate_load_harmless: "duplicateLoadHarmless",
  authenticated_read_executed: "authenticatedReadExecuted",
  confirmed_reversible_mutation_executed: "confirmedReversibleMutationExecuted",
  confirmed_mutation_effect_count: "confirmedMutationEffectCount",
  authoritative_final_state_verified: "authoritativeFinalStateVerified",
  execution_tools_match_capabilities: "executionToolsMatchCapabilities",
  zero_control_plane_calls: "zeroControlPlaneCalls",
  zero_model_calls: "zeroModelCalls",
  trusted_loader_enforced: "trustedLoaderEnforced",
  candidate_checks_passed: "candidateChecksPassed",
} as const);

export function createApplicationReadinessRepository(
  options: MaintenanceReadinessOptions,
): ApplicationReadinessRepository {
  const { pool, timeout } = readinessPool(options);
  return {
    async inspectApplicationRole() {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction read only");
        await client.query("set local role page2webmcp_app");
        await configureTransactionBounds(client, timeout);
        const role = await client.query(ROLE_AUDIT_QUERY);
        const sessionIdentityDigest = validatedRoleIdentity(role.rows[0], "page2webmcp_app");
        await client.query("commit");
        return { sessionIdentityDigest };
      } catch (error) {
        try { await client.query("rollback"); } catch { /* preserve the original bounded error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function createMaintenanceReadinessRepository(
  options: MaintenanceReadinessOptions,
): MaintenanceReadinessRepository {
  const { pool, timeout } = readinessPool(options);
  return {
    async inspectSelectedReleaseTopology(hash, provider, localOnly) {
      if (!HASH.test(hash)) throw new Error("READINESS_RELEASE_HASH_INVALID");
      const providerMode = exactProviderMode(provider);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction read only");
        await client.query("set local role page2webmcp_maintenance");
        await configureTransactionBounds(client, timeout);
        const role = await client.query(ROLE_AUDIT_QUERY);
        const sessionIdentityDigest = validatedRoleIdentity(role.rows[0], "page2webmcp_maintenance");
        const result = await client.query(
          "select * from private.selected_release_readiness_topology($1)",
          [hash],
        );
        if (result.rows.length !== 1) throw new Error("READINESS_TOPOLOGY_INVALID");
        const topology = mapTopology(result.rows[0]!, providerMode, localOnly);
        await client.query("commit");
        return { ...topology, sessionIdentityDigest };
      } catch (error) {
        try { await client.query("rollback"); } catch { /* preserve the original bounded error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async findSelectedNativeInstallationProof(hash) {
      if (!HASH.test(hash)) throw new Error("READINESS_RELEASE_HASH_INVALID");
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction read only");
        await client.query("set local role page2webmcp_maintenance");
        await configureTransactionBounds(client, timeout);
        const role = await client.query(ROLE_AUDIT_QUERY);
        validatedRoleIdentity(role.rows[0], "page2webmcp_maintenance");
        const result = await client.query(
          "select * from private.selected_native_installation_proof($1)",
          [hash],
        );
        if (result.rows.length > 1) throw new Error("LIVE_INSTALLATION_EVIDENCE_INVALID");
        const proof = result.rows[0] ? mapProof(result.rows[0]) : undefined;
        await client.query("commit");
        return proof;
      } catch (error) {
        try { await client.query("rollback"); } catch { /* preserve the original bounded error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async loadSelectedProviderProbeContext(hash) {
      if (!HASH.test(hash)) throw new Error("READINESS_RELEASE_HASH_INVALID");
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set transaction read only");
        await client.query("set local role page2webmcp_maintenance");
        await configureTransactionBounds(client, timeout);
        const role = await client.query(ROLE_AUDIT_QUERY);
        validatedRoleIdentity(role.rows[0], "page2webmcp_maintenance");
        const result = await client.query(
          "select * from private.selected_provider_probe_context($1)",
          [hash],
        );
        if (result.rows.length > 1) throw new Error("READINESS_PROVIDER_CONTEXT_INVALID");
        const context = result.rows[0] ? mapProviderProbeContext(result.rows[0]) : undefined;
        await client.query("commit");
        return context;
      } catch (error) {
        try { await client.query("rollback"); } catch { /* preserve the original bounded error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function readinessPool(options: MaintenanceReadinessOptions): Readonly<{
  pool: MaintenanceReadinessPool;
  timeout: number;
}> {
  if (!options?.connectionString || options.connectionString.length > 4_096
    || !["local-live", "live"].includes(options.mode)) throw new Error("DATABASE_READINESS_CONFIGURATION_REQUIRED");
  const timeout = Math.max(250, Math.min(options.statementTimeoutMs ?? 5_000, 15_000));
  const pool: MaintenanceReadinessPool = options.pool ?? (options.poolFactory ?? ((configuration) => new pg.Pool(
    configuration,
  )))({
    connectionString: options.connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    // Bound every query on the client before BEGIN/SET ROLE can rely on server-local settings.
    query_timeout: timeout,
    statement_timeout: timeout,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    ssl: options.mode === "live" ? { rejectUnauthorized: true } : false,
  });
  return { pool, timeout };
}

async function configureTransactionBounds(client: MaintenanceReadinessClient, timeout: number): Promise<void> {
  await client.query(
    "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), " +
    "set_config('idle_in_transaction_session_timeout', $3, true)",
    [String(timeout), String(Math.min(timeout, 2_000)), String(timeout * 2)],
  );
}

const TOPOLOGY_COLUMNS = [
  "hosted_github_release",
  "hosted_openapi_release",
  "hosted_website_release",
  "local_github_release",
  "local_openapi_release",
  "local_website_release",
  "migrations_current",
  "rls_verified",
] as const;

const PROVIDER_CONTEXT_COLUMNS = [
  "source_type",
  "source_url",
  "source_configuration",
  "source_identity_hash",
  "github_installation_id",
  "github_repository_id",
  "github_owner",
  "github_repository",
  "github_ref",
  "github_commit_sha",
  "github_target_origin",
] as const;

function exactHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

function positiveSafeInteger(value: unknown): number | undefined {
  const normalized = typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(normalized) && Number(normalized) > 0 ? Number(normalized) : undefined;
}

function mapProviderProbeContext(row: Record<string, unknown>): SelectedProviderProbeContext {
  if (Object.keys(row).sort().join(",") !== [...PROVIDER_CONTEXT_COLUMNS].sort().join(",")
    || !HASH.test(String(row.source_identity_hash ?? "")) || !exactHttpsUrl(row.source_url)) {
    throw new Error("READINESS_PROVIDER_CONTEXT_INVALID");
  }
  const sourceType = row.source_type;
  if (sourceType !== "openapi" && sourceType !== "website" && sourceType !== "github") {
    throw new Error("READINESS_PROVIDER_CONTEXT_INVALID");
  }
  if ((sourceType === "website" || sourceType === "github")
    && (!row.source_configuration || typeof row.source_configuration !== "object"
      || Array.isArray(row.source_configuration)
      || Object.keys(row.source_configuration).length !== 1
      || (row.source_configuration as Record<string, unknown>).kind !== sourceType)) {
    throw new Error("READINESS_PROVIDER_CONTEXT_INVALID");
  }
  let sourceConfiguration: ReturnType<typeof parsePersistedSourceConfiguration>;
  try { sourceConfiguration = parsePersistedSourceConfiguration(sourceType, row.source_configuration); }
  catch { throw new Error("READINESS_PROVIDER_CONTEXT_INVALID"); }
  const common = {
    sourceType,
    sourceUrl: row.source_url,
    sourceIdentityHash: row.source_identity_hash as string,
    sourceConfiguration,
  } as const;
  const githubValues = PROVIDER_CONTEXT_COLUMNS.slice(4).map((column) => row[column]);
  if (sourceType !== "github") {
    if (githubValues.some((value) => value !== null)) throw new Error("READINESS_PROVIDER_CONTEXT_INVALID");
    return common as SelectedProviderProbeContext;
  }
  const installationId = positiveSafeInteger(row.github_installation_id);
  const repositoryId = positiveSafeInteger(row.github_repository_id);
  const owner = row.github_owner;
  const repository = row.github_repository;
  const ref = row.github_ref;
  const commitSha = row.github_commit_sha;
  const targetOrigin = row.github_target_origin;
  if (!installationId || !repositoryId || typeof owner !== "string"
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)
    || typeof repository !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(repository)
    || typeof ref !== "string" || !/^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,252})$/.test(ref)
    || ref.split("/").some((part) => part === "" || part === "." || part === "..")
    || typeof commitSha !== "string" || !/^[0-9a-f]{40}$/.test(commitSha)
    || !exactHttpsUrl(targetOrigin) || new URL(targetOrigin).origin !== targetOrigin
    || common.sourceUrl !== `https://github.com/${owner}/${repository}`) {
    throw new Error("READINESS_PROVIDER_CONTEXT_INVALID");
  }
  return {
    ...common,
    sourceType: "github",
    sourceConfiguration: { kind: "github" },
    binding: { installationId, repositoryId, owner, repository, ref, commitSha, targetOrigin },
  };
}

function exactProviderMode(provider: ProductionProviderProvenance): ProductionProviderProvenance["mode"] {
  const exact = provider.mode === "openapi"
    ? provider.adapter === "bounded-openapi" && provider.adapterVersion === 1 && provider.fixture === false
    : provider.mode === "website"
      ? provider.adapter === "browser-use-v4" && provider.adapterVersion === 4 && provider.fixture === false
      : provider.mode === "github" && provider.adapter === "github-app"
        && provider.adapterVersion === 20260310 && provider.fixture === false;
  if (!exact) throw new Error("PROVIDER_PROVENANCE_INVALID");
  return provider.mode;
}

function mapTopology(
  row: Record<string, unknown>,
  providerMode: ProductionProviderProvenance["mode"],
  localOnly: boolean,
): Readonly<{ migrationsCurrent: boolean; rlsVerified: boolean; selectedReleasePersisted: boolean }> {
  if (Object.keys(row).sort().join(",") !== [...TOPOLOGY_COLUMNS].sort().join(",")
    || TOPOLOGY_COLUMNS.some((column) => typeof row[column] !== "boolean")) {
    throw new Error("READINESS_TOPOLOGY_INVALID");
  }
  return {
    migrationsCurrent: row.migrations_current as boolean,
    rlsVerified: row.rls_verified as boolean,
    selectedReleasePersisted: row[`${localOnly ? "local" : "hosted"}_${providerMode}_release`] as boolean,
  };
}

const ROLE_AUDIT_QUERY =
  "select current_user as current_role, session_user as session_role, login.rolsuper as session_superuser, " +
  "login.rolbypassrls as session_bypass_rls, login.rolcanlogin as session_can_login, " +
  "login.rolcreatedb as session_createdb, login.rolcreaterole as session_createrole, " +
  "login.rolreplication as session_replication, " +
  "coalesce(array(select role.rolname::text from pg_catalog.pg_roles role " +
  "where role.oid <> login.oid and pg_catalog.pg_has_role(session_user, role.oid, 'member') " +
  "order by role.rolname), array[]::text[]) as session_assumable_roles, " +
  "exists(select 1 from pg_catalog.pg_database database " +
  "where database.datname = pg_catalog.current_database() " +
  "and database.datdba in (login.oid, current_user::regrole::oid)) " +
  "as session_owns_current_database, " +
  "exists(select 1 from pg_catalog.pg_namespace namespace " +
  "where namespace.nspname in ('private','public') and namespace.nspowner in (login.oid, current_user::regrole::oid)) " +
  "as session_owns_scoped_schema, " +
  "exists(select 1 from pg_catalog.pg_class relation join pg_catalog.pg_namespace namespace " +
  "on namespace.oid = relation.relnamespace where namespace.nspname in ('private','public') " +
  "and relation.relowner in (login.oid, current_user::regrole::oid)) as session_owns_scoped_relation, " +
  "exists(select 1 from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace " +
  "on namespace.oid = routine.pronamespace where namespace.nspname in ('private','public') " +
  "and routine.proowner in (login.oid, current_user::regrole::oid)) as session_owns_scoped_routine " +
  "from pg_catalog.pg_roles login where login.rolname = session_user";

function validatedRoleIdentity(
  row: Record<string, unknown> | undefined,
  expectedRole: "page2webmcp_app" | "page2webmcp_maintenance",
): string {
  const sessionRole = row?.session_role;
  if (row?.current_role !== expectedRole
    || typeof sessionRole !== "string" || sessionRole.length === 0 || sessionRole.length > 128
    || row.session_superuser !== false || row.session_bypass_rls !== false || row.session_can_login !== true
    || row.session_createdb !== false || row.session_createrole !== false || row.session_replication !== false
    || !Array.isArray(row.session_assumable_roles) || row.session_assumable_roles.length !== 1
    || row.session_assumable_roles[0] !== expectedRole
    || row.session_owns_current_database !== false || row.session_owns_scoped_schema !== false
    || row.session_owns_scoped_relation !== false || row.session_owns_scoped_routine !== false) {
    throw new Error(expectedRole === "page2webmcp_app"
      ? "APPLICATION_DATABASE_ROLE_REQUIRED" : "MAINTENANCE_DATABASE_ROLE_REQUIRED");
  }
  return createHash("sha256").update(sessionRole, "utf8").digest("hex");
}

function mapProof(row: Record<string, unknown>): NativeInstallationProof {
  if (Object.keys(row).sort().join(",") !== Object.keys(PROOF_COLUMNS).sort().join(",")) {
    throw new Error("LIVE_INSTALLATION_EVIDENCE_INVALID");
  }
  const mapped: Record<string, unknown> = {};
  for (const [column, property] of Object.entries(PROOF_COLUMNS)) mapped[property] = row[column];
  const strings = Object.entries(mapped).filter(([, value]) => typeof value === "string") as Array<[string, string]>;
  if (strings.some(([, value]) => value.length === 0 || value.length > 4_096)
    || !["hermetic", "local_live", "live"].includes(String(mapped.candidateMode))
    || !["hermetic", "local_live", "live"].includes(String(mapped.installationMode))
    || mapped.candidateWebMcpImplementation !== "native"
    || mapped.installationWebMcpImplementation !== "native"
    || !["local", "openapi", "website", "github"].includes(String(mapped.providerMode))
    || !["openapi", "website", "github"].includes(String(mapped.sourceType))
    || !UUID.test(String(mapped.releaseVerificationRunId))
    || !UUID.test(String(mapped.candidateVerificationRunId))
    || !SRI.test(String(mapped.releaseIntegrity))
    || !SRI.test(String(mapped.candidateObservedIntegrity))
    || !SRI.test(String(mapped.installationObservedIntegrity))) {
    throw new Error("LIVE_INSTALLATION_EVIDENCE_INVALID");
  }
  for (const key of ["selectedReleaseHash", "releaseContentHash", "servedContentHash", "executedContentHash",
    "trustedLoaderContentHash", "candidateVerifierOriginDigest", "installationVerifierOriginDigest",
    "expectedToolsDigest", "registeredToolsDigest"] as const) {
    if (!HASH.test(String(mapped[key]))) throw new Error("LIVE_INSTALLATION_EVIDENCE_INVALID");
  }
  for (const key of ["candidateProtocolVersion", "installationProtocolVersion", "providerAdapterVersion",
    "expectedToolCount", "registeredToolCount", "confirmedMutationEffectCount"] as const) {
    if (!Number.isSafeInteger(mapped[key]) || Number(mapped[key]) < 0 || Number(mapped[key]) > 100_000_000) {
      throw new Error("LIVE_INSTALLATION_EVIDENCE_INVALID");
    }
  }
  for (const key of ["providerFixture", "sourceFixture", "localOnly", "targetIdentityMatches",
    "artifactIdentityMatches", "capabilityDigestMatches", "normalPageLoad", "routeInterception",
    "injectedRegistration", "syntheticHarness", "duplicateLoadHarmless", "authenticatedReadExecuted",
    "confirmedReversibleMutationExecuted", "authoritativeFinalStateVerified", "executionToolsMatchCapabilities",
    "zeroControlPlaneCalls",
    "zeroModelCalls", "trustedLoaderEnforced", "candidateChecksPassed"] as const) {
    if (typeof mapped[key] !== "boolean") throw new Error("LIVE_INSTALLATION_EVIDENCE_INVALID");
  }
  return mapped as NativeInstallationProof;
}
