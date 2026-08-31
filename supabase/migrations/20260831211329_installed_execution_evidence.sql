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
    legacy.release_content_hash,
    legacy.release_integrity,
    legacy.candidate_observed_integrity,
    legacy.installation_observed_integrity,
    legacy.served_content_hash,
    legacy.executed_content_hash,
    legacy.trusted_loader_content_hash,
    legacy.release_verification_run_id,
    legacy.candidate_verification_run_id,
    legacy.candidate_mode,
    legacy.installation_mode,
    legacy.candidate_protocol_version,
    legacy.installation_protocol_version,
    legacy.candidate_verifier_origin_digest,
    legacy.installation_verifier_origin_digest,
    legacy.candidate_webmcp_implementation,
    legacy.installation_webmcp_implementation,
    legacy.provider_mode,
    legacy.provider_adapter,
    legacy.provider_adapter_version,
    legacy.source_type,
    legacy.provider_fixture,
    legacy.source_fixture,
    legacy.local_only,
    legacy.target_identity_matches,
    legacy.artifact_identity_matches,
    legacy.capability_digest_matches,
    legacy.expected_tools_digest,
    legacy.registered_tools_digest,
    legacy.expected_tool_count,
    legacy.registered_tool_count,
    legacy.normal_page_load,
    legacy.route_interception,
    legacy.injected_registration,
    legacy.synthetic_harness,
    legacy.duplicate_load_harmless,
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
    legacy.zero_control_plane_calls,
    legacy.zero_model_calls,
    legacy.trusted_loader_enforced,
    legacy.candidate_checks_passed
  from private.selected_native_installation_proof_legacy_20260831120000(selected_hash) legacy
  join public.releases release
    on release.content_hash = legacy.release_content_hash
   and release.verification_run_id = legacy.release_verification_run_id
  join public.release_installations installation
    on installation.release_id = release.id
   and installation.artifact_content_hash = legacy.release_content_hash
   and installation.observed_integrity = legacy.installation_observed_integrity
   and installation.served_content_hash = legacy.served_content_hash
   and installation.executed_content_hash = legacy.executed_content_hash
   and installation.verification_mode = legacy.installation_mode
   and installation.verifier_protocol_version = legacy.installation_protocol_version
   and installation.verifier_origin_digest = legacy.installation_verifier_origin_digest
  where installation.status = 'verified'
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
