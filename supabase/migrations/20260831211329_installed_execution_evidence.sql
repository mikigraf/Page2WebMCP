begin;

-- Installed verification must prove execution through the normally installed
-- native bundle. Existing registration-only rows are preserved for audit, but
-- are explicitly invalidated and must be reverified; no execution fact is
-- inferred or backfilled.
alter table public.release_installations
  add column authenticated_read_tool_name text,
  add column authenticated_read_authenticated boolean,
  add column authenticated_read_succeeded boolean,
  add column confirmed_mutation_tool_name text,
  add column confirmed_mutation_confirmation text,
  add column confirmed_mutation_reversible boolean,
  add column confirmed_mutation_succeeded boolean,
  add column confirmed_mutation_effect_count integer,
  add column final_state_mutation_tool_name text,
  add column final_state_source text,
  add column final_state_verified boolean;

update public.release_installations
set status = 'failed', verified_at = null
where status = 'verified';

alter table public.release_installations
  add constraint release_installations_execution_evidence_check check (
    (
      status in ('pending_self_host', 'failed')
      and authenticated_read_tool_name is null
      and authenticated_read_authenticated is null
      and authenticated_read_succeeded is null
      and confirmed_mutation_tool_name is null
      and confirmed_mutation_confirmation is null
      and confirmed_mutation_reversible is null
      and confirmed_mutation_succeeded is null
      and confirmed_mutation_effect_count is null
      and final_state_mutation_tool_name is null
      and final_state_source is null
      and final_state_verified is null
    ) or ((
      status = 'verified'
      and authenticated_read_tool_name ~ '^[a-z][a-z0-9_]{0,63}$'
      and authenticated_read_authenticated
      and authenticated_read_succeeded
      and confirmed_mutation_tool_name ~ '^[a-z][a-z0-9_]{0,63}$'
      and confirmed_mutation_tool_name <> authenticated_read_tool_name
      and confirmed_mutation_confirmation = 'explicit'
      and confirmed_mutation_reversible
      and confirmed_mutation_succeeded
      and confirmed_mutation_effect_count = 1
      and final_state_mutation_tool_name = confirmed_mutation_tool_name
      and final_state_source = 'target'
      and final_state_verified
    ) is true)
  );

-- Preserve the Task 8 topology implementation as an uncallable historical
-- helper, then layer the new exact 17-migration ledger over its RLS and source
-- provenance checks.
alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260831120000;
revoke all on function private.selected_release_readiness_topology_legacy_20260831120000(text) from public;
revoke all on function private.selected_release_readiness_topology_legacy_20260831120000(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker, page2webmcp_maintenance;

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
      ('20260831120000'),
      ('20260831211329')
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
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260831120000(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified,
    legacy.local_openapi_release,
    legacy.local_website_release,
    legacy.local_github_release,
    legacy.hosted_openapi_release,
    legacy.hosted_website_release,
    legacy.hosted_github_release
  from legacy;
end;
$$;

revoke all on function private.selected_release_readiness_topology(text) from public;
revoke all on function private.selected_release_readiness_topology(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_release_readiness_topology(text) to page2webmcp_maintenance;

-- Extend the maintenance-only proof without exposing tool names, arguments,
-- outputs, URLs, or tenant identity. Every returned execution fact is derived
-- from typed columns and the reviewed manifest; registration alone yields no
-- row and can never promote liveSuccess.
alter function private.selected_native_installation_proof(text)
  rename to selected_native_installation_proof_legacy_20260831120000;
revoke all on function private.selected_native_installation_proof_legacy_20260831120000(text) from public;
revoke all on function private.selected_native_installation_proof_legacy_20260831120000(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker, page2webmcp_maintenance;

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
  candidate_checks_passed boolean
)
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    legacy.selected_release_hash,
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
    legacy.provider_mode,
    legacy.provider_adapter,
    legacy.provider_adapter_version,
    legacy.source_type,
    legacy.provider_fixture,
    legacy.source_fixture,
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
      from jsonb_array_elements(release.manifest->'plans') as read_plans(plan)
      where plan->'tool'->>'name' = installation.authenticated_read_tool_name
        and plan->'effects'->>'kind' = 'read'
        and (plan->'annotations'->>'readOnly')::boolean
        and plan->'authentication'->>'mode' in ('same_origin_cookie', 'browser_oauth')
    ) and exists (
      select 1
      from jsonb_array_elements(release.manifest->'plans') as mutation_plans(plan)
      where plan->'tool'->>'name' = installation.confirmed_mutation_tool_name
        and plan->'effects'->>'kind' = 'mutation'
        and not (plan->'annotations'->>'readOnly')::boolean
        and (plan->'effects'->>'reversible')::boolean
        and plan->'effects'->>'confirmation' = 'always'
    ),
    candidate.control_plane_request_count = 0,
    candidate.model_request_count = 0,
    candidate.trusted_loader_enforced,
    not candidate.checks @? '$[*] ? (@.status == "failed")'
  from private.selected_native_installation_proof_legacy_20260831120000(selected_hash) legacy
  join public.releases release
    on release.content_hash = legacy.release_content_hash
   and release.verification_run_id = legacy.release_verification_run_id
  join public.verification_runs candidate
    on candidate.id = legacy.candidate_verification_run_id
   and candidate.id = release.verification_run_id
   and candidate.project_id = release.project_id
   and candidate.organization_id = release.organization_id
   and candidate.analysis_run_id = release.analysis_run_id
   and candidate.capability_state_digest = release.capability_state_digest
   and candidate.candidate_content_hash = release.content_hash
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
      from jsonb_array_elements(release.manifest->'plans') as read_plans(plan)
      where plan->'tool'->>'name' = installation.authenticated_read_tool_name
        and plan->'effects'->>'kind' = 'read'
        and (plan->'annotations'->>'readOnly')::boolean
        and plan->'authentication'->>'mode' in ('same_origin_cookie', 'browser_oauth')
    )
    and exists (
      select 1
      from jsonb_array_elements(release.manifest->'plans') as mutation_plans(plan)
      where plan->'tool'->>'name' = installation.confirmed_mutation_tool_name
        and plan->'effects'->>'kind' = 'mutation'
        and not (plan->'annotations'->>'readOnly')::boolean
        and (plan->'effects'->>'reversible')::boolean
        and plan->'effects'->>'confirmation' = 'always'
    )
  order by installation.verified_at desc, installation.id desc
  limit 1;
$$;

revoke all on function private.selected_native_installation_proof(text) from public;
revoke all on function private.selected_native_installation_proof(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_native_installation_proof(text) to page2webmcp_maintenance;

commit;
