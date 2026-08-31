begin;

-- Source and provider provenance are immutable facts on the exact analysis
-- path. Existing snapshots and analyses remain conservatively ineligible.
alter table public.source_snapshots add column is_fixture boolean;
alter table public.source_snapshots alter column is_fixture set default false;

alter table public.analysis_runs
  add column provider_mode text,
  add column provider_adapter text,
  add column provider_adapter_version integer,
  add column provider_fixture boolean,
  add constraint analysis_runs_provider_provenance_check check (
    (provider_mode is null and provider_adapter is null
      and provider_adapter_version is null and provider_fixture is null)
    or (provider_mode = 'local' and provider_adapter = 'local-fixture'
      and provider_adapter_version = 1 and provider_fixture)
    or (provider_mode = 'openapi' and provider_adapter = 'bounded-openapi'
      and provider_adapter_version = 1 and not provider_fixture)
    or (provider_mode = 'website' and provider_adapter = 'browser-use-v4'
      and provider_adapter_version = 4 and not provider_fixture)
    or (provider_mode = 'github' and provider_adapter = 'github-app'
      and provider_adapter_version = 20260310 and not provider_fixture)
  );

grant update (provider_mode, provider_adapter, provider_adapter_version, provider_fixture)
  on public.analysis_runs to page2webmcp_worker;

create or replace function private.valid_registered_tools(value jsonb)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_typeof(value) = 'array'
    and jsonb_array_length(value) between 1 and 100
    and octet_length(value::text) <= 8192
    and not exists (
      select 1
      from jsonb_array_elements(value) as item(value)
      where jsonb_typeof(item.value) <> 'string'
        or item.value #>> '{}' !~ '^[a-z][a-z0-9_]{0,63}$'
    )
    and jsonb_array_length(value) = (
      select count(distinct item.value)
      from jsonb_array_elements(value) as item(value)
    );
$$;

revoke all on function private.valid_registered_tools(jsonb) from public, anon, authenticated,
  page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.valid_registered_tools(jsonb) to page2webmcp_app;

-- Candidate observations are stored as typed columns. The all-null branch is
-- retained solely so legacy rows stay readable; such rows are never eligible.
alter table public.verification_runs
  drop constraint verification_runs_verification_mode_check,
  add column verifier_protocol_version integer,
  add column verifier_origin_digest text,
  add column verifier_webmcp_implementation text,
  add column observed_content_hash text,
  add column observed_integrity text,
  add column observed_release_id text,
  add column observed_target_origin text,
  add column registered_tools jsonb,
  add column trusted_loader_enforced boolean,
  add column trusted_loader_content_hash text,
  add column control_plane_request_count integer,
  add column model_request_count integer,
  add constraint verification_runs_verification_mode_check
    check (verification_mode in ('live', 'local_live', 'hermetic')),
  add constraint verification_runs_native_observation_check check (
    (
      verifier_protocol_version is null and verifier_origin_digest is null
      and verifier_webmcp_implementation is null and observed_content_hash is null
      and observed_integrity is null and observed_release_id is null
      and observed_target_origin is null and registered_tools is null
      and trusted_loader_enforced is null and trusted_loader_content_hash is null
      and control_plane_request_count is null and model_request_count is null
    ) or (
      verifier_protocol_version between 1 and 32767
      and verifier_origin_digest ~ '^[0-9a-f]{64}$'
      and verifier_webmcp_implementation = 'native'
      and observed_content_hash ~ '^[0-9a-f]{64}$'
      and observed_integrity ~ '^sha384-[A-Za-z0-9+/]+={0,2}$'
      and observed_release_id ~ '^[0-9a-f]{64}$'
      and octet_length(observed_target_origin) between 9 and 2048
      and observed_target_origin ~ '^https://[^/?#]+$'
      and private.valid_registered_tools(registered_tools)
      and trusted_loader_enforced is not null
      and trusted_loader_content_hash ~ '^[0-9a-f]{64}$'
      and control_plane_request_count between 0 and 1000000
      and model_request_count between 0 and 1000000
    )
  );

alter table public.verification_runs drop constraint verification_runs_eligibility_check;

update public.verification_runs
set eligible = false,
    failures = case when 'MIGRATION_NATIVE_REVERIFY_REQUIRED' = any(failures)
      then failures else array_append(failures, 'MIGRATION_NATIVE_REVERIFY_REQUIRED') end
where verifier_protocol_version is null;

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
  ));

alter table public.verification_runs
  add constraint verification_runs_exact_release_key unique
    (id, project_id, organization_id, analysis_run_id, capability_state_digest, candidate_content_hash);

-- A release is permanently bound to the candidate verification that admitted
-- it. Existing releases are intentionally left null and cannot become live.
alter table public.releases add column verification_run_id uuid;
alter table public.releases
  add constraint releases_exact_verification_fk foreign key
    (verification_run_id, project_id, organization_id, analysis_run_id, capability_state_digest, content_hash)
    references public.verification_runs
    (id, project_id, organization_id, analysis_run_id, capability_state_digest, candidate_content_hash)
    on delete restrict;

drop policy "owners create releases" on public.releases;
create policy "owners create releases"
on public.releases for insert to page2webmcp_app
with check (
  private.context_member(organization_id, array['owner'])
  and verification_run_id is not null
  and artifact_url is not null
  and download_url is not null
  and local_only is not null
  and exists (
    select 1 from public.verification_runs candidate
    where candidate.id = releases.verification_run_id
      and candidate.analysis_run_id = releases.analysis_run_id
      and candidate.project_id = releases.project_id
      and candidate.organization_id = releases.organization_id
      and candidate.capability_state_digest = releases.capability_state_digest
      and candidate.candidate_content_hash = releases.content_hash
      and candidate.eligible
  )
);

-- Installation attempts stay append-only. Typed observations, not the legacy
-- JSON diagnostic, are authoritative for readiness.
alter table public.release_installations
  add column download_url text,
  add column local_only boolean,
  add column verification_mode text,
  add column verifier_protocol_version integer,
  add column verifier_origin_digest text,
  add column verifier_webmcp_implementation text,
  add column observed_artifact_url text,
  add column observed_download_url text,
  add column observed_local_only boolean,
  add column observed_integrity text,
  add column observed_target_origin text,
  add column registered_tools jsonb,
  add column executed_artifact_url text,
  add column served_content_hash text,
  add column executed_content_hash text,
  add column normal_page_load boolean,
  add column route_interception boolean,
  add column injected_registration boolean,
  add column synthetic_harness boolean,
  add column duplicate_load_harmless boolean,
  add constraint release_installations_native_observation_check check (
    (
      download_url is null and local_only is null and verification_mode is null
      and verifier_protocol_version is null and verifier_origin_digest is null
      and verifier_webmcp_implementation is null and observed_artifact_url is null
      and observed_download_url is null and observed_local_only is null and observed_integrity is null
      and observed_target_origin is null and registered_tools is null
      and executed_artifact_url is null and served_content_hash is null
      and executed_content_hash is null and normal_page_load is null
      and route_interception is null and injected_registration is null
      and synthetic_harness is null and duplicate_load_harmless is null
    ) or (
      octet_length(download_url) between 9 and 4096
      and local_only is not null
      and verification_mode in ('live', 'local_live', 'hermetic')
      and verifier_protocol_version between 1 and 32767
      and verifier_origin_digest ~ '^[0-9a-f]{64}$'
      and verifier_webmcp_implementation = 'native'
      and octet_length(observed_artifact_url) between 9 and 4096
      and octet_length(observed_download_url) between 9 and 4096
      and observed_local_only is not null
      and observed_integrity ~ '^sha384-[A-Za-z0-9+/]+={0,2}$'
      and octet_length(observed_target_origin) between 9 and 2048
      and served_content_hash ~ '^[0-9a-f]{64}$'
      and normal_page_load is not null
      and route_interception is not null
      and injected_registration is not null
      and synthetic_harness is not null
      and (
        (status = 'pending_self_host' and registered_tools = '[]'::jsonb
          and executed_artifact_url is null
          and executed_content_hash is null and duplicate_load_harmless is null)
        or
        (status <> 'pending_self_host' and private.valid_registered_tools(registered_tools)
          and octet_length(executed_artifact_url) between 9 and 4096
          and executed_content_hash ~ '^[0-9a-f]{64}$' and duplicate_load_harmless is not null)
      )
    )
  );

drop policy "owners create release installations" on public.release_installations;
create policy "owners create release installations"
on public.release_installations for insert to page2webmcp_app
with check (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
  and private.context_member(organization_id, array['owner'])
  and verifier_protocol_version is not null
  and exists (
    select 1 from public.releases release
    where release.id = release_installations.release_id
      and release.project_id = release_installations.project_id
      and release.organization_id = release_installations.organization_id
      and release.content_hash = release_installations.artifact_content_hash
      and release.sri = release_installations.integrity
      and release.allowed_origin = release_installations.target_origin
      and release.artifact_url = release_installations.artifact_url
      and release.download_url = release_installations.download_url
      and release.local_only = release_installations.local_only
      and release.status = 'published'
      and release_installations.expected_tools = (
        select jsonb_agg(to_jsonb(plan->'tool'->>'name') order by (plan->'tool'->>'name') collate "C")
        from jsonb_array_elements(release.manifest->'plans') as plans(plan)
      )
  )
);

create index release_installations_selected_native_idx
  on public.release_installations (release_id, verified_at desc, id desc)
  where status = 'verified' and verification_mode = 'live';

-- Local-live and live readiness both prove the active database topology and
-- the exact selected persisted release path. This projection deliberately
-- exposes only booleans and never tenant identity, URLs, source, or code.
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
      ('20260826000000'),
      ('20260829074144'),
      ('20260829090000'),
      ('20260829092023'),
      ('20260829094207'),
      ('20260829100000'),
      ('20260830094622'),
      ('20260830120000'),
      ('20260830160000'),
      ('20260830180000'),
      ('20260830190000'),
      ('20260831090000'),
      ('20260831100000'),
      ('20260831110000'),
      ('20260831111000'),
      ('20260831120000')
  ), applied_migrations(version) as (
    select migration.version::text
    from supabase_migrations.schema_migrations migration
  ), migration_state as (
    select
      (select count(*) = count(distinct version) from applied_migrations)
      and coalesce(
        (select array_agg(version order by version) from applied_migrations),
        array[]::text[]
      ) = (select array_agg(version order by version) from required_migrations) as current
  ), required_rls(schema_name, table_name) as (
    values
      ('private', 'analysis_jobs'),
      ('private', 'app_sessions'),
      ('private', 'idempotency_keys'),
      ('private', 'workflow_commands'),
      ('private', 'workflow_tasks'),
      ('public', 'analysis_evidence'),
      ('public', 'analysis_runs'),
      ('public', 'audit_events'),
      ('public', 'capabilities'),
      ('public', 'capability_plans'),
      ('public', 'capability_reviews'),
      ('public', 'installations'),
      ('public', 'memberships'),
      ('public', 'organizations'),
      ('public', 'project_sources'),
      ('public', 'projects'),
      ('public', 'release_installations'),
      ('public', 'releases'),
      ('public', 'source_snapshots'),
      ('public', 'verification_checks'),
      ('public', 'verification_runs'),
      ('public', 'workflow_events'),
      ('public', 'workflow_evidence'),
      ('public', 'workflow_runs')
  ), rls_state as (
    select not exists (
      select 1
      from required_rls required
      left join pg_catalog.pg_namespace namespace on namespace.nspname = required.schema_name
      left join pg_catalog.pg_class relation
        on relation.relnamespace = namespace.oid and relation.relname = required.table_name
      where relation.oid is null or relation.relkind not in ('r', 'p')
        or not relation.relrowsecurity or not relation.relforcerowsecurity
    ) as verified
  ), selected_paths as (
    select release.local_only, analysis.provider_mode
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
    where release.content_hash = selected_hash
      and release.status = 'published'
      and release.verification_run_id is not null
      and candidate.eligible
      and analysis.provider_mode = source.source_type
      and analysis.provider_fixture = false
      and source_snapshot.is_fixture = false
      and (
        (analysis.provider_mode = 'openapi' and analysis.provider_adapter = 'bounded-openapi'
          and analysis.provider_adapter_version = 1)
        or (analysis.provider_mode = 'website' and analysis.provider_adapter = 'browser-use-v4'
          and analysis.provider_adapter_version = 4)
        or (analysis.provider_mode = 'github' and analysis.provider_adapter = 'github-app'
          and analysis.provider_adapter_version = 20260310)
      )
      and (
        (release.local_only = true and release.artifact_url =
          'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/'
          || release.content_hash || '.js')
        or (release.local_only = false and release.artifact_url =
          'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
          || release.content_hash || '.js')
      )
      and release.download_url = release.artifact_url
        || '?download=page2webmcp-' || release.content_hash || '.js'
  )
  select
    (select migration_state.current from migration_state),
    (select rls_state.verified from rls_state),
    exists (select 1 from selected_paths path where path.local_only and path.provider_mode = 'openapi'),
    exists (select 1 from selected_paths path where path.local_only and path.provider_mode = 'website'),
    exists (select 1 from selected_paths path where path.local_only and path.provider_mode = 'github'),
    exists (select 1 from selected_paths path where not path.local_only and path.provider_mode = 'openapi'),
    exists (select 1 from selected_paths path where not path.local_only and path.provider_mode = 'website'),
    exists (select 1 from selected_paths path where not path.local_only and path.provider_mode = 'github');
end;
$$;

revoke all on function private.selected_release_readiness_topology(text) from public;
revoke all on function private.selected_release_readiness_topology(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_release_readiness_topology(text) to page2webmcp_maintenance;

-- This projection is the sole database input capable of promoting liveSuccess.
-- It returns no candidate bytes, URLs, target origins, tenant IDs, or source.
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
  zero_control_plane_calls boolean,
  zero_model_calls boolean,
  trusted_loader_enforced boolean,
  candidate_checks_passed boolean
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
    encode(extensions.digest(installation.expected_tools::text, 'sha256'), 'hex'),
    encode(extensions.digest(installation.registered_tools::text, 'sha256'), 'hex'),
    jsonb_array_length(installation.expected_tools),
    jsonb_array_length(installation.registered_tools),
    installation.normal_page_load,
    installation.route_interception,
    installation.injected_registration,
    installation.synthetic_harness,
    installation.duplicate_load_harmless,
    candidate.control_plane_request_count = 0,
    candidate.model_request_count = 0,
    candidate.trusted_loader_enforced,
    not candidate.checks @? '$[*] ? (@.status == "failed")'
  from public.releases release
  join public.verification_runs candidate
    on release.verification_run_id = candidate.id
   and release.project_id = candidate.project_id
   and release.organization_id = candidate.organization_id
   and release.analysis_run_id = candidate.analysis_run_id
   and release.capability_state_digest = candidate.capability_state_digest
   and release.content_hash = candidate.candidate_content_hash
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
    and release.verification_run_id = candidate.id
    and release.local_only = false
    and release.artifact_url =
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
      || release.content_hash || '.js'
    and release.download_url = release.artifact_url || '?download=page2webmcp-' || release.content_hash || '.js'
    and candidate.eligible
    and candidate.verification_mode = 'live'
    and candidate.verifier_protocol_version is not null
    and candidate.verifier_origin_digest is not null
    and candidate.verifier_webmcp_implementation = 'native'
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
    and installation.verifier_protocol_version = candidate.verifier_protocol_version
    and installation.verifier_webmcp_implementation = 'native'
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
  order by installation.verified_at desc, installation.id desc
  limit 1;
end;
$$;

revoke all on function private.selected_native_installation_proof(text) from public;
revoke all on function private.selected_native_installation_proof(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_native_installation_proof(text) to page2webmcp_maintenance;

commit;
