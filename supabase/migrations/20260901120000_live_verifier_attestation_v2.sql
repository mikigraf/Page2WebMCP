begin;

-- A production verifier result is useful only together with its signed v2
-- response identity. Keep the signed body and bearer token outside Postgres;
-- these columns are the bounded, secret-free replay and scope projection.
alter table public.verification_runs
  add column verifier_attestation_id uuid,
  add column verifier_attestation_request_id uuid,
  add column verifier_attestation_nonce_digest text,
  add column verifier_attestation_operation text,
  add column verifier_attestation_scope_digest text,
  add column verifier_attestation_payload_digest text,
  add column verifier_attestation_issued_at timestamptz,
  add column verifier_attestation_expires_at timestamptz,
  add column verifier_attestation_attested_at timestamptz,
  add constraint verification_runs_live_verifier_attestation_check check (
    (
      verifier_attestation_id is null
      and verifier_attestation_request_id is null
      and verifier_attestation_nonce_digest is null
      and verifier_attestation_operation is null
      and verifier_attestation_scope_digest is null
      and verifier_attestation_payload_digest is null
      and verifier_attestation_issued_at is null
      and verifier_attestation_expires_at is null
      and verifier_attestation_attested_at is null
      and not (verification_mode = 'live' and verifier_protocol_version = 2)
    ) or (
      verification_mode = 'live'
      and verifier_protocol_version = 2
      and verifier_attestation_id::text ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and verifier_attestation_request_id::text ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and verifier_attestation_nonce_digest ~ '^[0-9a-f]{64}$'
      and verifier_attestation_operation = 'candidate'
      and verifier_attestation_scope_digest ~ '^[0-9a-f]{64}$'
      and verifier_attestation_payload_digest ~ '^[0-9a-f]{64}$'
      and verifier_attestation_issued_at <= verifier_attestation_attested_at
      and verifier_attestation_expires_at > verifier_attestation_attested_at
      and verifier_attestation_expires_at <=
        verifier_attestation_issued_at + interval '120 seconds'
    )
  ) not valid;

alter table public.release_installations
  add column verifier_attestation_id uuid,
  add column verifier_attestation_request_id uuid,
  add column verifier_attestation_nonce_digest text,
  add column verifier_attestation_operation text,
  add column verifier_attestation_scope_digest text,
  add column verifier_attestation_payload_digest text,
  add column verifier_attestation_issued_at timestamptz,
  add column verifier_attestation_expires_at timestamptz,
  add column verifier_attestation_attested_at timestamptz,
  add constraint release_installations_live_verifier_attestation_check check (
    (
      verifier_attestation_id is null
      and verifier_attestation_request_id is null
      and verifier_attestation_nonce_digest is null
      and verifier_attestation_operation is null
      and verifier_attestation_scope_digest is null
      and verifier_attestation_payload_digest is null
      and verifier_attestation_issued_at is null
      and verifier_attestation_expires_at is null
      and verifier_attestation_attested_at is null
      and not (verification_mode = 'live' and verifier_protocol_version = 2)
    ) or (
      verification_mode = 'live'
      and verifier_protocol_version = 2
      and verifier_attestation_id::text ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and verifier_attestation_request_id::text ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and verifier_attestation_nonce_digest ~ '^[0-9a-f]{64}$'
      and verifier_attestation_operation = 'installation'
      and verifier_attestation_scope_digest ~ '^[0-9a-f]{64}$'
      and verifier_attestation_payload_digest ~ '^[0-9a-f]{64}$'
      and verifier_attestation_issued_at <= verifier_attestation_attested_at
      and verifier_attestation_expires_at > verifier_attestation_attested_at
      and verifier_attestation_expires_at <=
        verifier_attestation_issued_at + interval '120 seconds'
    )
  ) not valid;

create unique index verification_runs_candidate_attestation_id_uidx
  on public.verification_runs (verifier_attestation_id)
  where verifier_attestation_operation = 'candidate';
create unique index verification_runs_candidate_request_id_uidx
  on public.verification_runs (verifier_attestation_request_id)
  where verifier_attestation_operation = 'candidate';
create unique index release_installations_installation_attestation_id_uidx
  on public.release_installations (verifier_attestation_id)
  where verifier_attestation_operation = 'installation';
create unique index release_installations_installation_request_id_uidx
  on public.release_installations (verifier_attestation_request_id)
  where verifier_attestation_operation = 'installation';

alter table public.verification_runs
  drop constraint verification_runs_eligibility_check;

-- No pre-v2 production observation is promoted. Preserve it for audit but
-- require an exact new verification before it can be selected again. The old
-- equality constraint must be gone first: an otherwise-valid v1 row has
-- eligible=true and would reject this conservative eligible=false backfill.
update public.verification_runs
set eligible = false,
    failures = case when 'MIGRATION_VERIFIER_V2_REVERIFY_REQUIRED' = any(failures)
      then failures else array_append(failures, 'MIGRATION_VERIFIER_V2_REVERIFY_REQUIRED') end
where verification_mode = 'live'
  and verifier_protocol_version is distinct from 2;

alter table public.verification_runs
  add constraint verification_runs_eligibility_check check (eligible = (
    schema_valid
    and authenticated
    and replay_passes >= 3
    and no_secret_leakage
    and browser_execution
    and selection_score >= 18
    and capability_state_digest <> repeat('0', 64)
    and candidate_content_hash <> repeat('0', 64)
    and not checks @? '$[*] ? (@.status == "failed")'
    and verifier_protocol_version is not null
    and verifier_origin_digest is not null
    and verifier_webmcp_implementation = 'native'
    and observed_content_hash = candidate_content_hash
    and observed_release_id = candidate_manifest->>'releaseId'
    and observed_target_origin = candidate_allowed_origin
    and trusted_loader_enforced
    and trusted_loader_content_hash = candidate_content_hash
    and control_plane_request_count = 0
    and model_request_count = 0
    and (
      verification_mode <> 'live'
      or (
        verifier_protocol_version = 2
        and verifier_attestation_operation = 'candidate'
        and verifier_attestation_id is not null
        and verifier_attestation_request_id is not null
        and verifier_attestation_nonce_digest ~ '^[0-9a-f]{64}$'
        and verifier_attestation_scope_digest ~ '^[0-9a-f]{64}$'
        and verifier_attestation_payload_digest ~ '^[0-9a-f]{64}$'
        and verifier_attestation_expires_at > verifier_attestation_attested_at
      )
    )
  )) not valid;

alter table public.verification_runs
  validate constraint verification_runs_live_verifier_attestation_check;
alter table public.release_installations
  validate constraint release_installations_live_verifier_attestation_check;
alter table public.verification_runs
  validate constraint verification_runs_eligibility_check;

-- Select the behavior proof, native observation, exact scope, and both v2
-- attestations from one release_installations row. A separately selected
-- legacy proof can otherwise be cross-bound to another installation's scope.
alter function private.selected_native_installation_proof(text)
  rename to selected_native_installation_proof_legacy_20260901010000;
revoke all on function private.selected_native_installation_proof_legacy_20260901010000(text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;

create function private.selected_native_installation_proof(selected_hash text)
returns table (
  selected_release_hash text,
  release_content_hash text,
  release_integrity text,
  candidate_observed_integrity text,
  installation_observed_integrity text,
  served_content_hash text,
  executed_content_hash text,
  trusted_loader_content_hash text,
  release_verification_run_id uuid,
  candidate_verification_run_id uuid,
  candidate_mode text,
  installation_mode text,
  candidate_protocol_version integer,
  installation_protocol_version integer,
  candidate_verifier_origin_digest text,
  installation_verifier_origin_digest text,
  candidate_webmcp_implementation text,
  installation_webmcp_implementation text,
  provider_mode text,
  provider_adapter text,
  provider_adapter_version integer,
  source_type text,
  provider_fixture boolean,
  source_fixture boolean,
  local_only boolean,
  target_identity_matches boolean,
  artifact_identity_matches boolean,
  capability_digest_matches boolean,
  expected_tools_digest text,
  registered_tools_digest text,
  expected_tool_count integer,
  registered_tool_count integer,
  normal_page_load boolean,
  route_interception boolean,
  injected_registration boolean,
  synthetic_harness boolean,
  duplicate_load_harmless boolean,
  authenticated_read_executed boolean,
  confirmed_reversible_mutation_executed boolean,
  confirmed_mutation_effect_count integer,
  authoritative_final_state_verified boolean,
  execution_tools_match_capabilities boolean,
  zero_control_plane_calls boolean,
  zero_model_calls boolean,
  trusted_loader_enforced boolean,
  candidate_checks_passed boolean,
  project_id uuid,
  analysis_run_id uuid,
  release_id uuid,
  source_identity_hash text,
  target_origin text,
  environment text,
  installation_page_url text,
  installation_operation_id text,
  candidate_attestation_id uuid,
  candidate_attestation_request_id uuid,
  candidate_attestation_nonce_digest text,
  candidate_attestation_operation text,
  candidate_attestation_scope_digest text,
  candidate_attestation_payload_digest text,
  candidate_attestation_issued_at timestamptz,
  candidate_attestation_expires_at timestamptz,
  candidate_attestation_attested_at timestamptz,
  installation_attestation_id uuid,
  installation_attestation_request_id uuid,
  installation_attestation_nonce_digest text,
  installation_attestation_operation text,
  installation_attestation_scope_digest text,
  installation_attestation_payload_digest text,
  installation_attestation_issued_at timestamptz,
  installation_attestation_expires_at timestamptz,
  installation_attestation_attested_at timestamptz,
  installation_verified_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if selected_hash is null or not (selected_hash ~ '^[0-9a-f]{64}$') then
    raise exception 'selected release hash is invalid' using errcode = '22023';
  end if;

  return query
  select
    selected_hash,
    release.content_hash,
    release.sri,
    candidate.observed_integrity,
    installation.observed_integrity,
    installation.served_content_hash,
    installation.executed_content_hash,
    candidate.trusted_loader_content_hash,
    release.verification_run_id,
    candidate.id,
    candidate.verification_mode,
    installation.verification_mode,
    candidate.verifier_protocol_version,
    installation.verifier_protocol_version,
    candidate.verifier_origin_digest,
    installation.verifier_origin_digest,
    candidate.verifier_webmcp_implementation,
    installation.verifier_webmcp_implementation,
    analysis.provider_mode,
    analysis.provider_adapter,
    analysis.provider_adapter_version,
    source.source_type,
    analysis.provider_fixture,
    source_snapshot.is_fixture,
    release.local_only,
    candidate.observed_target_origin = release.allowed_origin
      and installation.observed_target_origin = release.allowed_origin
      and candidate.observed_target_origin = installation.observed_target_origin,
    installation.observed_artifact_url = release.artifact_url
      and installation.observed_download_url = release.download_url
      and installation.observed_local_only = release.local_only
      and installation.artifact_url = release.artifact_url
      and installation.download_url = release.download_url
      and installation.local_only = release.local_only
      and installation.artifact_content_hash = release.content_hash
      and installation.integrity = release.sri,
    candidate.capability_state_digest = release.capability_state_digest
      and candidate.registered_tools = installation.expected_tools
      and installation.registered_tools = installation.expected_tools,
    pg_catalog.encode(extensions.digest(installation.expected_tools::text, 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(installation.registered_tools::text, 'sha256'), 'hex'),
    pg_catalog.jsonb_array_length(installation.expected_tools),
    pg_catalog.jsonb_array_length(installation.registered_tools),
    installation.normal_page_load,
    installation.route_interception,
    installation.injected_registration,
    installation.synthetic_harness,
    installation.duplicate_load_harmless,
    installation.authenticated_read_authenticated and installation.authenticated_read_succeeded,
    installation.confirmed_mutation_confirmation = 'explicit'
      and installation.confirmed_mutation_reversible
      and installation.confirmed_mutation_succeeded
      and installation.confirmed_mutation_effect_count = 1,
    installation.confirmed_mutation_effect_count,
    installation.final_state_source = 'target'
      and installation.final_state_verified
      and installation.final_state_mutation_tool_name = installation.confirmed_mutation_tool_name,
    exists (
      select 1
      from pg_catalog.jsonb_array_elements(release.manifest->'plans') as read_plans(plan)
      where plan->'tool'->>'name' = installation.authenticated_read_tool_name
        and plan->'effects'->>'kind' = 'read'
        and (plan->'annotations'->>'readOnly')::boolean
        and plan->'authentication'->>'mode' in ('same_origin_cookie', 'browser_oauth')
    ) and exists (
      select 1
      from pg_catalog.jsonb_array_elements(release.manifest->'plans') as mutation_plans(plan)
      where plan->'tool'->>'name' = installation.confirmed_mutation_tool_name
        and plan->'effects'->>'kind' = 'mutation'
        and not (plan->'annotations'->>'readOnly')::boolean
        and (plan->'effects'->>'reversible')::boolean
        and plan->'effects'->>'confirmation' = 'always'
    ),
    candidate.control_plane_request_count = 0,
    candidate.model_request_count = 0,
    candidate.trusted_loader_enforced,
    not candidate.checks @? '$[*] ? (@.status == "failed")',
    release.project_id,
    release.analysis_run_id,
    release.id,
    source_snapshot.source_identity_hash,
    release.allowed_origin,
    case when source.source_type = 'openapi'
      then source.source_configuration->>'environment'
      else 'production'
    end,
    installation.page_url,
    pg_catalog.encode(extensions.digest(
      '{"inputHash":' || pg_catalog.to_jsonb(installation.input_hash)::text
      || ',"idempotencyKey":' || pg_catalog.to_jsonb(installation.idempotency_key)::text
      || ',"projectId":' || pg_catalog.to_jsonb(release.project_id::text)::text
      || ',"releaseId":' || pg_catalog.to_jsonb(release.id::text)::text || '}',
      'sha256'
    ), 'hex'),
    candidate.verifier_attestation_id,
    candidate.verifier_attestation_request_id,
    candidate.verifier_attestation_nonce_digest,
    candidate.verifier_attestation_operation,
    candidate.verifier_attestation_scope_digest,
    candidate.verifier_attestation_payload_digest,
    candidate.verifier_attestation_issued_at,
    candidate.verifier_attestation_expires_at,
    candidate.verifier_attestation_attested_at,
    installation.verifier_attestation_id,
    installation.verifier_attestation_request_id,
    installation.verifier_attestation_nonce_digest,
    installation.verifier_attestation_operation,
    installation.verifier_attestation_scope_digest,
    installation.verifier_attestation_payload_digest,
    installation.verifier_attestation_issued_at,
    installation.verifier_attestation_expires_at,
    installation.verifier_attestation_attested_at,
    installation.verified_at
  from public.releases release
  join public.verification_runs candidate
    on candidate.id = release.verification_run_id
   and candidate.project_id = release.project_id
   and candidate.organization_id = release.organization_id
   and candidate.analysis_run_id = release.analysis_run_id
   and candidate.capability_state_digest = release.capability_state_digest
   and candidate.candidate_content_hash = release.content_hash
  join public.analysis_runs analysis
    on analysis.id = release.analysis_run_id
   and analysis.project_id = release.project_id
   and analysis.organization_id = release.organization_id
  join public.workflow_runs workflow
    on workflow.analysis_run_id = analysis.id
   and workflow.project_id = analysis.project_id
   and workflow.organization_id = analysis.organization_id
  join public.source_snapshots source_snapshot
    on source_snapshot.id = workflow.source_snapshot_id
   and source_snapshot.project_id = workflow.project_id
   and source_snapshot.organization_id = workflow.organization_id
  join public.project_sources source
    on source.id = source_snapshot.project_source_id
   and source.project_id = source_snapshot.project_id
   and source.organization_id = source_snapshot.organization_id
  join public.release_installations installation
    on installation.release_id = release.id
   and installation.project_id = release.project_id
   and installation.organization_id = release.organization_id
  where release.content_hash = selected_hash
    and release.status = 'published'
    and release.local_only = false
    and release.artifact_url =
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
      || release.content_hash || '.js'
    and release.download_url = release.artifact_url || '?download=page2webmcp-' || release.content_hash || '.js'
    and candidate.eligible
    and candidate.verification_mode = 'live'
    and candidate.verifier_protocol_version = 2
    and candidate.verifier_origin_digest is not null
    and candidate.verifier_webmcp_implementation = 'native'
    and candidate.verifier_attestation_operation = 'candidate'
    and candidate.observed_content_hash = release.content_hash
    and candidate.observed_integrity = release.sri
    and candidate.observed_release_id = release.manifest->>'releaseId'
    and candidate.observed_target_origin = release.allowed_origin
    and candidate.registered_tools = installation.expected_tools
    and candidate.trusted_loader_enforced
    and candidate.trusted_loader_content_hash = release.content_hash
    and candidate.control_plane_request_count = 0
    and candidate.model_request_count = 0
    and not candidate.checks @? '$[*] ? (@.status == "failed")'
    and analysis.provider_mode in ('openapi', 'website', 'github')
    and analysis.provider_mode = source.source_type
    and analysis.provider_fixture = false
    and (
      (analysis.provider_mode = 'openapi' and analysis.provider_adapter = 'bounded-openapi'
        and analysis.provider_adapter_version = 1)
      or (analysis.provider_mode = 'website' and analysis.provider_adapter = 'browser-use-v4'
        and analysis.provider_adapter_version = 4)
      or (analysis.provider_mode = 'github' and analysis.provider_adapter = 'github-app'
        and analysis.provider_adapter_version = 20260310)
    )
    and source_snapshot.is_fixture = false
    and installation.status = 'verified'
    and installation.verified_at is not null
    and installation.verification_mode = 'live'
    and installation.verifier_origin_digest = candidate.verifier_origin_digest
    and installation.verifier_protocol_version = 2
    and installation.verifier_webmcp_implementation = 'native'
    and installation.verifier_attestation_operation = 'installation'
    and candidate.verifier_attestation_id <> installation.verifier_attestation_id
    and candidate.verifier_attestation_request_id <> installation.verifier_attestation_request_id
    and installation.webmcp_implementation = 'native'
    and installation.artifact_url = release.artifact_url
    and installation.download_url = release.download_url
    and installation.local_only = false
    and installation.observed_artifact_url = release.artifact_url
    and installation.observed_download_url = release.download_url
    and installation.observed_local_only = release.local_only
    and installation.artifact_content_hash = release.content_hash
    and installation.served_content_hash = release.content_hash
    and installation.executed_content_hash = release.content_hash
    and installation.observed_integrity = release.sri
    and installation.integrity = release.sri
    and installation.observed_target_origin = release.allowed_origin
    and installation.target_origin = release.allowed_origin
    and installation.registered_tools = installation.expected_tools
    and installation.normal_page_load
    and not installation.route_interception
    and not installation.injected_registration
    and not installation.synthetic_harness
    and installation.duplicate_load_harmless
    and (
      (installation.delivery = 'hosted' and installation.executed_artifact_url = release.artifact_url)
      or
      (installation.delivery = 'self_hosted'
        and installation.self_hosted_url is not null
        and installation.executed_artifact_url = installation.self_hosted_url)
    )
    and installation.authenticated_read_authenticated
    and installation.authenticated_read_succeeded
    and installation.confirmed_mutation_confirmation = 'explicit'
    and installation.confirmed_mutation_reversible
    and installation.confirmed_mutation_succeeded
    and installation.confirmed_mutation_effect_count = 1
    and installation.final_state_source = 'target'
    and installation.final_state_verified
    and installation.final_state_mutation_tool_name = installation.confirmed_mutation_tool_name
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(release.manifest->'plans') as read_plans(plan)
      where plan->'tool'->>'name' = installation.authenticated_read_tool_name
        and plan->'effects'->>'kind' = 'read'
        and (plan->'annotations'->>'readOnly')::boolean
        and plan->'authentication'->>'mode' in ('same_origin_cookie', 'browser_oauth')
    )
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(release.manifest->'plans') as mutation_plans(plan)
      where plan->'tool'->>'name' = installation.confirmed_mutation_tool_name
        and plan->'effects'->>'kind' = 'mutation'
        and not (plan->'annotations'->>'readOnly')::boolean
        and (plan->'effects'->>'reversible')::boolean
        and plan->'effects'->>'confirmation' = 'always'
    )
    and (case when source.source_type = 'openapi'
      then source.source_configuration->>'environment'
      else 'production'
    end) in ('test', 'staging', 'production')
  order by installation.verified_at desc, installation.id desc
  limit 1;
end;
$$;

revoke all on function private.selected_native_installation_proof(text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.selected_native_installation_proof(text)
  to page2webmcp_maintenance;

-- Carry the authoritative exact-migration ledger forward and make the v2
-- checks/indexes part of the topology readiness fact. The historical wrapper
-- remains uncallable.
alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901100000;
revoke all on function private.selected_release_readiness_topology_legacy_20260901100000(text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;

create function private.selected_release_readiness_topology(selected_hash text)
returns table (
  migrations_current boolean,
  rls_verified boolean,
  local_openapi_release boolean,
  local_website_release boolean,
  local_github_release boolean,
  hosted_openapi_release boolean,
  hosted_website_release boolean,
  hosted_github_release boolean
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if selected_hash is null or not (selected_hash ~ '^[0-9a-f]{64}$') then
    raise exception 'selected release hash is invalid' using errcode = '22023';
  end if;

  return query
  with required_migrations(version) as (
    values
      ('20260826000000'), ('20260829074144'), ('20260829090000'), ('20260829092023'),
      ('20260829094207'), ('20260829100000'), ('20260830094622'), ('20260830120000'),
      ('20260830160000'), ('20260830180000'), ('20260830190000'), ('20260831090000'),
      ('20260831100000'), ('20260831110000'), ('20260831111000'), ('20260831120000'),
      ('20260831211329'), ('20260901000000'), ('20260901010000'), ('20260901020000'),
      ('20260901030000'), ('20260901040000'), ('20260901060852'), ('20260901071658'),
      ('20260901090842'), ('20260901092107'), ('20260901094032'), ('20260901100000'),
      ('20260901110000'), ('20260901120000')
  ), applied_migrations(version) as (
    select migration.version::text from supabase_migrations.schema_migrations migration
  ), migration_state as (
    select (select count(*) = count(distinct version) from applied_migrations)
      and coalesce((select array_agg(version order by version) from applied_migrations), array[]::text[])
        = (select array_agg(version order by version) from required_migrations) as current
  ), verifier_guard as (
    select
      bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
      and count(*) = 2
      and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
        where constraint_row.conname = 'verification_runs_live_verifier_attestation_check'
          and constraint_row.conrelid = 'public.verification_runs'::regclass
          and constraint_row.convalidated
      )
      and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
        where constraint_row.conname = 'release_installations_live_verifier_attestation_check'
          and constraint_row.conrelid = 'public.release_installations'::regclass
          and constraint_row.convalidated
      )
      and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
        where constraint_row.conname = 'verification_runs_eligibility_check'
          and constraint_row.conrelid = 'public.verification_runs'::regclass
          and constraint_row.convalidated
      )
      and exists (
        select 1 from pg_catalog.pg_indexes index_row
        where index_row.schemaname = 'public'
          and index_row.indexname = 'verification_runs_candidate_attestation_id_uidx'
          and index_row.indexdef ~ '^CREATE UNIQUE INDEX'
      )
      and exists (
        select 1 from pg_catalog.pg_indexes index_row
        where index_row.schemaname = 'public'
          and index_row.indexname = 'verification_runs_candidate_request_id_uidx'
          and index_row.indexdef ~ '^CREATE UNIQUE INDEX'
      )
      and exists (
        select 1 from pg_catalog.pg_indexes index_row
        where index_row.schemaname = 'public'
          and index_row.indexname = 'release_installations_installation_attestation_id_uidx'
          and index_row.indexdef ~ '^CREATE UNIQUE INDEX'
      )
      and exists (
        select 1 from pg_catalog.pg_indexes index_row
        where index_row.schemaname = 'public'
          and index_row.indexname = 'release_installations_installation_request_id_uidx'
          and index_row.indexdef ~ '^CREATE UNIQUE INDEX'
      ) as verified
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in ('verification_runs', 'release_installations')
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901100000(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and coalesce((select verified from verifier_guard), false),
    legacy.local_openapi_release,
    legacy.local_website_release,
    legacy.local_github_release,
    legacy.hosted_openapi_release,
    legacy.hosted_website_release,
    legacy.hosted_github_release
  from legacy;
end;
$$;

revoke all on function private.selected_release_readiness_topology(text)
  from public, anon, authenticated, service_role, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_release_readiness_topology(text)
  to page2webmcp_maintenance;

commit;
