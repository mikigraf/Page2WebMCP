-- Recreate the deployed 4eb452a body after the first 18 migrations. Fresh
-- replay contains the later in-place edit, so this explicit replacement is
-- what makes this an old-vulnerable-schema upgrade regression.
create or replace function private.selected_native_installation_proof(selected_hash text)
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

do $$
declare
  organization_id constant uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  actor_id constant uuid := '11111111-1111-1111-1111-111111111111';
  splice_hash constant text := repeat('1', 64);
  duplicate_hash constant text := repeat('2', 64);
  verifier_digest constant text := repeat('b', 64);
  release_integrity constant text := 'sha384-AAAA';
  release_manifest constant jsonb := jsonb_build_object(
    'releaseId', repeat('e', 64),
    'plans', jsonb_build_array(
      jsonb_build_object(
        'tool', jsonb_build_object('name', 'read_widget'),
        'effects', jsonb_build_object('kind', 'read'),
        'annotations', jsonb_build_object('readOnly', true),
        'authentication', jsonb_build_object('mode', 'same_origin_cookie')
      ),
      jsonb_build_object(
        'tool', jsonb_build_object('name', 'mutate_widget'),
        'effects', jsonb_build_object('kind', 'mutation', 'reversible', true, 'confirmation', 'always'),
        'annotations', jsonb_build_object('readOnly', false),
        'authentication', jsonb_build_object('mode', 'same_origin_cookie')
      )
    )
  );
  expected_tools constant jsonb := '["mutate_widget", "read_widget"]'::jsonb;
  passed_checks constant jsonb := '[
    {"name":"authentication","status":"passed"},
    {"name":"cancellation","status":"passed"},
    {"name":"confirmation","status":"passed"},
    {"name":"final_state","status":"passed"},
    {"name":"no_control_plane_or_model_calls","status":"passed"},
    {"name":"origin","status":"passed"},
    {"name":"read","status":"passed"},
    {"name":"replay_idempotency","status":"passed"},
    {"name":"reversible_mutation","status":"passed"},
    {"name":"schema","status":"passed"},
    {"name":"secret_leakage","status":"passed"},
    {"name":"tool_selection","status":"passed"},
    {"name":"trusted_loader","status":"passed"}
  ]'::jsonb;
begin
  insert into public.projects (
    id, organization_id, created_by, name, source_type, source_url, status
  ) values
    ('91000000-0000-4000-8000-000000000001', organization_id, actor_id,
      'Upgrade splice proof', 'website', 'https://splice-upgrade.example', 'analyzed'),
    ('91000000-0000-4000-8000-000000000002', organization_id, actor_id,
      'Upgrade older duplicate proof', 'website', 'https://duplicate-old.example', 'analyzed'),
    ('91000000-0000-4000-8000-000000000003', organization_id, actor_id,
      'Upgrade newer duplicate proof', 'website', 'https://duplicate-new.example', 'analyzed');

  insert into public.project_sources (
    id, organization_id, project_id, source_type, source_url, source_configuration, version, active
  ) values
    ('91000000-0000-4000-8000-000000000011', organization_id,
      '91000000-0000-4000-8000-000000000001', 'website', 'https://splice-upgrade.example',
      '{"kind":"website"}', 1, true),
    ('91000000-0000-4000-8000-000000000012', organization_id,
      '91000000-0000-4000-8000-000000000002', 'website', 'https://duplicate-old.example',
      '{"kind":"website"}', 1, true),
    ('91000000-0000-4000-8000-000000000013', organization_id,
      '91000000-0000-4000-8000-000000000003', 'website', 'https://duplicate-new.example',
      '{"kind":"website"}', 1, true);

  insert into public.source_snapshots (
    id, organization_id, project_id, project_source_id, source_identity_hash, is_fixture
  ) values
    ('91000000-0000-4000-8000-000000000021', organization_id,
      '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000011', repeat('3', 64), false),
    ('91000000-0000-4000-8000-000000000022', organization_id,
      '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000012', repeat('4', 64), false),
    ('91000000-0000-4000-8000-000000000023', organization_id,
      '91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000013', repeat('5', 64), false);

  insert into public.analysis_runs (
    id, organization_id, project_id, requested_by, status, attempts, result,
    provider_mode, provider_adapter, provider_adapter_version, provider_fixture
  ) values
    ('91000000-0000-4000-8000-000000000031', organization_id,
      '91000000-0000-4000-8000-000000000001', actor_id, 'succeeded', 1, '{}',
      'website', 'browser-use-v4', 4, false),
    ('91000000-0000-4000-8000-000000000032', organization_id,
      '91000000-0000-4000-8000-000000000002', actor_id, 'succeeded', 1, '{}',
      'website', 'browser-use-v4', 4, false),
    ('91000000-0000-4000-8000-000000000033', organization_id,
      '91000000-0000-4000-8000-000000000003', actor_id, 'succeeded', 1, '{}',
      'website', 'browser-use-v4', 4, false);

  insert into public.workflow_runs (
    id, organization_id, project_id, source_snapshot_id, analysis_run_id,
    status, current_phase, input_hash
  ) values
    ('91000000-0000-4000-8000-000000000031', organization_id,
      '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000021',
      '91000000-0000-4000-8000-000000000031', 'queued', 'analysis', repeat('6', 64)),
    ('91000000-0000-4000-8000-000000000032', organization_id,
      '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000022',
      '91000000-0000-4000-8000-000000000032', 'queued', 'analysis', repeat('7', 64)),
    ('91000000-0000-4000-8000-000000000033', organization_id,
      '91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000023',
      '91000000-0000-4000-8000-000000000033', 'queued', 'analysis', repeat('8', 64));

  insert into public.verification_runs (
    id, organization_id, project_id, analysis_run_id, capability_state_digest,
    candidate_content_hash, candidate_code, candidate_allowed_origin, candidate_manifest,
    schema_valid, authenticated, replay_passes, no_secret_leakage, browser_execution,
    selection_score, checks, csp_result, verification_mode, eligible, failures,
    verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation,
    observed_content_hash, observed_integrity, observed_release_id, observed_target_origin,
    registered_tools, trusted_loader_enforced, trusted_loader_content_hash,
    control_plane_request_count, model_request_count
  ) values
    ('91000000-0000-4000-8000-000000000041', organization_id,
      '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
      repeat('9', 64), splice_hash, 'splice candidate', 'https://splice-upgrade.example', release_manifest,
      true, true, 3, true, true, 20, passed_checks, '{"hosted":"allowed"}', 'live', true, '{}',
      1, verifier_digest, 'native', splice_hash, release_integrity, repeat('e', 64),
      'https://splice-upgrade.example', expected_tools, true, splice_hash, 0, 0),
    ('91000000-0000-4000-8000-000000000042', organization_id,
      '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000032',
      repeat('a', 64), duplicate_hash, 'older duplicate candidate', 'https://duplicate-old.example', release_manifest,
      true, true, 3, true, true, 20, passed_checks, '{"hosted":"allowed"}', 'live', true, '{}',
      1, verifier_digest, 'native', duplicate_hash, release_integrity, repeat('e', 64),
      'https://duplicate-old.example', expected_tools, true, duplicate_hash, 0, 0),
    ('91000000-0000-4000-8000-000000000043', organization_id,
      '91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000033',
      repeat('c', 64), duplicate_hash, 'newer duplicate candidate', 'https://duplicate-new.example', release_manifest,
      true, true, 3, true, true, 20, passed_checks, '{"hosted":"allowed"}', 'live', true, '{}',
      1, verifier_digest, 'native', duplicate_hash, release_integrity, repeat('e', 64),
      'https://duplicate-new.example', expected_tools, true, duplicate_hash, 0, 0);

  insert into public.releases (
    id, organization_id, project_id, analysis_run_id, capability_state_digest,
    content_hash, sri, code, allowed_origin, manifest, verification_run_id,
    artifact_url, download_url, local_only, status
  ) values
    ('91000000-0000-4000-8000-000000000051', organization_id,
      '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000031',
      repeat('9', 64), splice_hash, release_integrity, 'splice candidate',
      'https://splice-upgrade.example', release_manifest, '91000000-0000-4000-8000-000000000041',
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || splice_hash || '.js',
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || splice_hash ||
        '.js?download=page2webmcp-' || splice_hash || '.js', false, 'published'),
    ('91000000-0000-4000-8000-000000000052', organization_id,
      '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000032',
      repeat('a', 64), duplicate_hash, release_integrity, 'older duplicate candidate',
      'https://duplicate-old.example', release_manifest, '91000000-0000-4000-8000-000000000042',
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || duplicate_hash || '.js',
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || duplicate_hash ||
        '.js?download=page2webmcp-' || duplicate_hash || '.js', false, 'published'),
    ('91000000-0000-4000-8000-000000000053', organization_id,
      '91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000033',
      repeat('c', 64), duplicate_hash, release_integrity, 'newer duplicate candidate',
      'https://duplicate-new.example', release_manifest, '91000000-0000-4000-8000-000000000043',
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || duplicate_hash || '.js',
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || duplicate_hash ||
        '.js?download=page2webmcp-' || duplicate_hash || '.js', false, 'published');

  insert into public.release_installations (
    id, organization_id, project_id, release_id, actor_id, page_url, artifact_url,
    self_hosted_url, target_origin, artifact_content_hash, integrity, expected_tools,
    status, delivery, csp_status, csp_directive, webmcp_implementation, attestation,
    idempotency_key, input_hash, download_url, local_only, verification_mode,
    verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation,
    observed_artifact_url, observed_download_url, observed_local_only, observed_integrity,
    observed_target_origin, registered_tools, executed_artifact_url, served_content_hash,
    executed_content_hash, normal_page_load, route_interception, injected_registration,
    synthetic_harness, duplicate_load_harmless, authenticated_read_tool_name,
    authenticated_read_authenticated, authenticated_read_succeeded, confirmed_mutation_tool_name,
    confirmed_mutation_confirmation, confirmed_mutation_reversible, confirmed_mutation_succeeded,
    confirmed_mutation_effect_count, final_state_mutation_tool_name, final_state_source,
    final_state_verified, verified_at
  )
  select
    fixture.id, organization_id, fixture.project_id, fixture.release_id, actor_id,
    fixture.origin || '/account', artifact.url, null, fixture.origin, fixture.content_hash,
    release_integrity, expected_tools, 'verified', 'hosted', 'allowed', null, 'native', '{}',
    fixture.idempotency_key, fixture.input_hash, artifact.download_url, false, 'live', 1,
    verifier_digest, 'native', artifact.url, artifact.download_url, false, release_integrity,
    fixture.origin, expected_tools, artifact.url, fixture.content_hash, fixture.content_hash,
    true, fixture.route_interception, false, false, true, fixture.read_tool, true, true,
    fixture.mutation_tool, 'explicit', true, true, 1, fixture.mutation_tool, 'target', true,
    fixture.verified_at
  from (values
    ('91000000-0000-4000-8000-000000000061'::uuid,
      '91000000-0000-4000-8000-000000000001'::uuid,
      '91000000-0000-4000-8000-000000000051'::uuid,
      'https://splice-upgrade.example'::text, splice_hash, false, 'unrelated_read'::text,
      'unrelated_mutation'::text, 'upgrade-splice-normal'::text, repeat('d', 64),
      '2026-08-31T20:00:00Z'::timestamptz),
    ('91000000-0000-4000-8000-000000000062'::uuid,
      '91000000-0000-4000-8000-000000000001'::uuid,
      '91000000-0000-4000-8000-000000000051'::uuid,
      'https://splice-upgrade.example'::text, splice_hash, true, 'read_widget'::text,
      'mutate_widget'::text, 'upgrade-splice-execution'::text, repeat('e', 64),
      '2026-08-31T20:01:00Z'::timestamptz),
    ('91000000-0000-4000-8000-000000000063'::uuid,
      '91000000-0000-4000-8000-000000000002'::uuid,
      '91000000-0000-4000-8000-000000000052'::uuid,
      'https://duplicate-old.example'::text, duplicate_hash, false, 'read_widget'::text,
      'mutate_widget'::text, 'upgrade-duplicate-valid-old'::text, repeat('f', 64),
      '2026-08-31T21:00:00Z'::timestamptz),
    ('91000000-0000-4000-8000-000000000064'::uuid,
      '91000000-0000-4000-8000-000000000003'::uuid,
      '91000000-0000-4000-8000-000000000053'::uuid,
      'https://duplicate-new.example'::text, duplicate_hash, false, 'unrelated_read'::text,
      'unrelated_mutation'::text, 'upgrade-duplicate-invalid-new'::text, repeat('0', 64),
      '2026-08-31T21:01:00Z'::timestamptz)
  ) as fixture(
    id, project_id, release_id, origin, content_hash, route_interception, read_tool,
    mutation_tool, idempotency_key, input_hash, verified_at
  )
  cross join lateral (
    select
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' ||
        fixture.content_hash || '.js' as url,
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' ||
        fixture.content_hash || '.js?download=page2webmcp-' || fixture.content_hash || '.js' as download_url
  ) artifact;
end;
$$;

do $$
begin
  if (select count(*) from private.selected_native_installation_proof(repeat('1', 64))) <> 1 then
    raise exception 'deployed vulnerable proof did not splice complementary installation rows';
  end if;
  if (select count(*) from private.selected_native_installation_proof(repeat('2', 64))) <> 0 then
    raise exception 'deployed vulnerable proof did not hide the valid older duplicate-hash release';
  end if;
end;
$$;
