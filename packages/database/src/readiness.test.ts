import assert from "node:assert/strict";
import test from "node:test";
import {
  createApplicationReadinessRepository,
  createMaintenanceReadinessRepository,
  type MaintenanceReadinessPool,
} from "./readiness.ts";

const selectedHash = "a".repeat(64);

function proofRow() {
  return {
    selected_release_hash: selectedHash,
    release_content_hash: selectedHash,
    release_integrity: "sha384-AAAA",
    candidate_observed_integrity: "sha384-AAAA",
    installation_observed_integrity: "sha384-AAAA",
    served_content_hash: selectedHash,
    executed_content_hash: selectedHash,
    trusted_loader_content_hash: selectedHash,
    release_verification_run_id: "11111111-1111-4111-8111-111111111111",
    candidate_verification_run_id: "11111111-1111-4111-8111-111111111111",
    candidate_mode: "live",
    installation_mode: "live",
    candidate_protocol_version: 1,
    installation_protocol_version: 1,
    candidate_verifier_origin_digest: "b".repeat(64),
    installation_verifier_origin_digest: "b".repeat(64),
    candidate_webmcp_implementation: "native",
    installation_webmcp_implementation: "native",
    provider_mode: "openapi",
    provider_adapter: "bounded-openapi",
    provider_adapter_version: 1,
    source_type: "openapi",
    provider_fixture: false,
    source_fixture: false,
    local_only: false,
    target_identity_matches: true,
    artifact_identity_matches: true,
    capability_digest_matches: true,
    expected_tools_digest: "c".repeat(64),
    registered_tools_digest: "c".repeat(64),
    expected_tool_count: 1,
    registered_tool_count: 1,
    normal_page_load: true,
    route_interception: false,
    injected_registration: false,
    synthetic_harness: false,
    duplicate_load_harmless: true,
    authenticated_read_executed: true,
    confirmed_reversible_mutation_executed: true,
    confirmed_mutation_effect_count: 1,
    authoritative_final_state_verified: true,
    execution_tools_match_capabilities: true,
    zero_control_plane_calls: true,
    zero_model_calls: true,
    trusted_loader_enforced: true,
    candidate_checks_passed: true,
  };
}

function topologyRow() {
  return {
    migrations_current: true,
    rls_verified: true,
    local_openapi_release: true,
    local_website_release: false,
    local_github_release: false,
    hosted_openapi_release: false,
    hosted_website_release: false,
    hosted_github_release: false,
  };
}

function probeContextRow() {
  return {
    source_type: "openapi",
    source_url: "https://specs.widgets.example/openapi.json",
    source_configuration: {
      kind: "openapi",
      targetOrigin: "https://widgets.example",
      testPageUrl: "https://widgets.example/webmcp-test",
      environment: "production",
    },
    source_identity_hash: "d".repeat(64),
    github_installation_id: null,
    github_repository_id: null,
    github_owner: null,
    github_repository: null,
    github_ref: null,
    github_commit_sha: null,
    github_target_origin: null,
  };
}

function fakePool(
  roleOverrides: Record<string, unknown> = {},
  rows = [proofRow()],
  expectedRole: "page2webmcp_app" | "page2webmcp_maintenance" = "page2webmcp_maintenance",
  contextRows: readonly Record<string, unknown>[] = [probeContextRow()],
) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  let released = 0;
  let ended = 0;
  const pool: MaintenanceReadinessPool = {
    connect: async () => ({
      query: async (text, values) => {
        queries.push({ text, values });
        if (text.includes("session_role")) {
          for (const field of ["session_createdb", "session_createrole", "session_replication",
            "session_assumable_roles", "session_owns_current_database", "session_owns_scoped_schema",
            "session_owns_scoped_relation", "session_owns_scoped_routine"]) {
            assert.match(text, new RegExp(`\\b${field}\\b`));
          }
          assert.match(text, /array\(select role\.rolname::text/);
          assert.match(text, /role\.oid <> login\.oid/);
          assert.match(text, /database\.datdba in \(login\.oid, current_user::regrole::oid\)/);
          assert.doesNotMatch(text, /role\.rolname in \('page2webmcp_app'/i);
          return { rows: [{
            current_role: expectedRole,
            session_role: expectedRole === "page2webmcp_app"
              ? "page2webmcp_app_login" : "page2webmcp_readiness_login",
            session_superuser: false,
            session_bypass_rls: false,
            session_can_login: true,
            session_createdb: false,
            session_createrole: false,
            session_replication: false,
            session_assumable_roles: [expectedRole],
            session_owns_current_database: false,
            session_owns_scoped_schema: false,
            session_owns_scoped_relation: false,
            session_owns_scoped_routine: false,
            ...roleOverrides,
          }] };
        }
        if (text.includes("private.selected_release_readiness_topology")) return { rows: [topologyRow()] };
        if (text.includes("private.selected_provider_probe_context")) return { rows: contextRows };
        if (text.includes("private.selected_native_installation_proof")) return { rows };
        return { rows: [] };
      },
      release: () => { released += 1; },
    }),
    end: async () => { ended += 1; },
  };
  return { pool, queries, released: () => released, ended: () => ended };
}

test("application readiness actively proves its distinct non-owner app login", async () => {
  const fake = fakePool({}, [], "page2webmcp_app");
  const repository = createApplicationReadinessRepository({
    connectionString: "postgresql://redacted.invalid/db",
    mode: "live",
    pool: fake.pool,
  });
  assert.deepEqual(await repository.inspectApplicationRole(), {
    sessionIdentityDigest: "bdda2dd07b6d83336e3cf190c1aac07a8f37fc54a22f48e2c61db4095769a951",
  });
  assert.ok(fake.queries.some(({ text }) => text === "set local role page2webmcp_app"));
  assert.ok(fake.queries.some(({ text }) => text === "set transaction read only"));
  assert.equal(fake.queries.some(({ text }) => /private\.selected_|public\.releases/i.test(text)), false);
  assert.equal(fake.released(), 1);
  await repository.close();
  assert.equal(fake.ended(), 1);
});

test("application readiness rejects privileged, owning, or broadly assumable logins", async () => {
  for (const override of [
    { session_superuser: true },
    { session_bypass_rls: true },
    { session_createdb: true },
    { session_createrole: true },
    { session_replication: true },
    { session_assumable_roles: ["page2webmcp_app", "pg_read_all_data"] },
    { session_owns_current_database: true },
    { session_owns_scoped_schema: true },
    { session_owns_scoped_relation: true },
    { session_owns_scoped_routine: true },
  ]) {
    const fake = fakePool(override, [], "page2webmcp_app");
    const repository = createApplicationReadinessRepository({
      connectionString: "postgresql://redacted.invalid/db", mode: "live", pool: fake.pool,
    });
    await assert.rejects(repository.inspectApplicationRole(), /^Error: APPLICATION_DATABASE_ROLE_REQUIRED$/);
  }
});

test("maintenance readiness actively checks the selected provider, migration ledger, and forced RLS", async () => {
  const fake = fakePool();
  const repository = createMaintenanceReadinessRepository({
    connectionString: "postgresql://redacted.invalid/db",
    mode: "local-live",
    pool: fake.pool,
  });
  assert.deepEqual(await repository.inspectSelectedReleaseTopology(selectedHash, {
    mode: "openapi", adapter: "bounded-openapi", adapterVersion: 1, fixture: false,
  }, true), {
    migrationsCurrent: true,
    rlsVerified: true,
    selectedReleasePersisted: true,
    sessionIdentityDigest: "b3aa06a51f209ab981a749d3dbb2aaf3922315a0eaa0a7e694f042caa3537bf1",
  });
  assert.deepEqual(fake.queries.filter(({ text }) => text.includes("selected_release_readiness_topology")), [{
    text: "select * from private.selected_release_readiness_topology($1)", values: [selectedHash],
  }]);
  assert.equal(fake.queries.some(({ text }) => /public\.releases|supabase_migrations/i.test(text)), false);
});

test("maintenance readiness reads only the exact selected hash through the bounded function", async () => {
  const fake = fakePool();
  const repository = createMaintenanceReadinessRepository({
    connectionString: "postgresql://redacted.invalid/db",
    mode: "live",
    pool: fake.pool,
  });
  assert.deepEqual(await repository.findSelectedNativeInstallationProof(selectedHash), {
    selectedReleaseHash: selectedHash,
    releaseContentHash: selectedHash,
    releaseIntegrity: "sha384-AAAA",
    candidateObservedIntegrity: "sha384-AAAA",
    installationObservedIntegrity: "sha384-AAAA",
    servedContentHash: selectedHash,
    executedContentHash: selectedHash,
    trustedLoaderContentHash: selectedHash,
    releaseVerificationRunId: "11111111-1111-4111-8111-111111111111",
    candidateVerificationRunId: "11111111-1111-4111-8111-111111111111",
    candidateMode: "live",
    installationMode: "live",
    candidateProtocolVersion: 1,
    installationProtocolVersion: 1,
    candidateVerifierOriginDigest: "b".repeat(64),
    installationVerifierOriginDigest: "b".repeat(64),
    candidateWebMcpImplementation: "native",
    installationWebMcpImplementation: "native",
    providerMode: "openapi",
    providerAdapter: "bounded-openapi",
    providerAdapterVersion: 1,
    sourceType: "openapi",
    providerFixture: false,
    sourceFixture: false,
    localOnly: false,
    targetIdentityMatches: true,
    artifactIdentityMatches: true,
    capabilityDigestMatches: true,
    expectedToolsDigest: "c".repeat(64),
    registeredToolsDigest: "c".repeat(64),
    expectedToolCount: 1,
    registeredToolCount: 1,
    normalPageLoad: true,
    routeInterception: false,
    injectedRegistration: false,
    syntheticHarness: false,
    duplicateLoadHarmless: true,
    authenticatedReadExecuted: true,
    confirmedReversibleMutationExecuted: true,
    confirmedMutationEffectCount: 1,
    authoritativeFinalStateVerified: true,
    executionToolsMatchCapabilities: true,
    zeroControlPlaneCalls: true,
    zeroModelCalls: true,
    trustedLoaderEnforced: true,
    candidateChecksPassed: true,
  });
  assert.deepEqual(fake.queries.filter(({ text }) => text.includes("selected_native_installation_proof")), [{
    text: "select * from private.selected_native_installation_proof($1)", values: [selectedHash],
  }]);
  assert.equal(fake.queries.some(({ text }) => /\blatest\b|public\.releases|private\.analysis_jobs/i.test(text)), false);
  assert.ok(fake.queries.some(({ text }) => text === "set local role page2webmcp_maintenance"));
  assert.ok(fake.queries.some(({ text }) => text === "set transaction read only"));
  assert.ok(fake.queries.some(({ text }) => text.includes("statement_timeout")));
  assert.equal(fake.released(), 1);
  await repository.close();
  assert.equal(fake.ended(), 1);
});

test("maintenance readiness loads a typed source descriptor only from the exact selected release", async () => {
  const fake = fakePool();
  const repository = createMaintenanceReadinessRepository({
    connectionString: "postgresql://redacted.invalid/db", mode: "live", pool: fake.pool,
  });
  assert.deepEqual(await repository.loadSelectedProviderProbeContext(selectedHash), {
    sourceType: "openapi",
    sourceUrl: "https://specs.widgets.example/openapi.json",
    sourceIdentityHash: "d".repeat(64),
    sourceConfiguration: {
      kind: "openapi", targetOrigin: "https://widgets.example",
      testPageUrl: "https://widgets.example/webmcp-test", environment: "production",
    },
  });
  assert.deepEqual(fake.queries.filter(({ text }) => text.includes("selected_provider_probe_context")), [{
    text: "select * from private.selected_provider_probe_context($1)", values: [selectedHash],
  }]);
});

test("maintenance readiness distinguishes an absent selected context from malformed or duplicate contexts", async () => {
  const absent = fakePool({}, [], "page2webmcp_maintenance", []);
  const absentRepository = createMaintenanceReadinessRepository({
    connectionString: "postgresql://redacted.invalid/db", mode: "live", pool: absent.pool,
  });
  assert.equal(await absentRepository.loadSelectedProviderProbeContext(selectedHash), undefined);

  const duplicate = fakePool({}, [], "page2webmcp_maintenance", [probeContextRow(), probeContextRow()]);
  const duplicateRepository = createMaintenanceReadinessRepository({
    connectionString: "postgresql://redacted.invalid/db", mode: "live", pool: duplicate.pool,
  });
  await assert.rejects(duplicateRepository.loadSelectedProviderProbeContext(selectedHash),
    /^Error: READINESS_PROVIDER_CONTEXT_INVALID$/);
});

test("maintenance readiness rejects every privilege, ownership, and assumable-role escape", async () => {
  for (const override of [
    { current_role: "page2webmcp_app" },
    { session_superuser: true },
    { session_bypass_rls: true },
    { session_can_login: false },
    { session_createdb: true },
    { session_createrole: true },
    { session_replication: true },
    { session_assumable_roles: ["page2webmcp_maintenance", "pg_read_all_data"] },
    { session_owns_current_database: true },
    { session_owns_scoped_schema: true },
    { session_owns_scoped_relation: true },
    { session_owns_scoped_routine: true },
  ]) {
    const fake = fakePool(override);
    const repository = createMaintenanceReadinessRepository({
      connectionString: "postgresql://redacted.invalid/db", mode: "live", pool: fake.pool,
    });
    await assert.rejects(repository.findSelectedNativeInstallationProof(selectedHash),
      /^Error: MAINTENANCE_DATABASE_ROLE_REQUIRED$/);
    assert.equal(fake.queries.some(({ text }) => text.includes("selected_native_installation_proof")), false);
  }
});

test("maintenance readiness validates the selected hash before opening a connection", async () => {
  const fake = fakePool();
  let connections = 0;
  const repository = createMaintenanceReadinessRepository({
    connectionString: "postgresql://redacted.invalid/db",
    mode: "live",
    pool: { ...fake.pool, connect: async () => { connections += 1; return fake.pool.connect(); } },
  });
  await assert.rejects(repository.findSelectedNativeInstallationProof("A".repeat(64)),
    /^Error: READINESS_RELEASE_HASH_INVALID$/);
  assert.equal(connections, 0);
});

test("maintenance pool bounds every query before server-local timeouts exist", async () => {
  const fake = fakePool();
  let configuration: Record<string, unknown> | undefined;
  const repository = createMaintenanceReadinessRepository({
    connectionString: "postgresql://readiness:secret@database.example/page2webmcp",
    mode: "live",
    statementTimeoutMs: 1_250,
    poolFactory: (value) => {
      configuration = value as Record<string, unknown>;
      return fake.pool;
    },
  });
  assert.equal(configuration?.query_timeout, 1_250);
  assert.equal(configuration?.statement_timeout, 1_250);
  assert.equal(configuration?.connectionTimeoutMillis, 5_000);
  assert.deepEqual(configuration?.ssl, { rejectUnauthorized: true });
  await repository.close();
});
