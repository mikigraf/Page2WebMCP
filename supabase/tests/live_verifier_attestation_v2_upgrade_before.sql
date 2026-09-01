-- A genuinely eligible live-v1 row proves the migration can invalidate an
-- already-validated equality constraint without aborting the upgrade. Two
-- installations are retained for the post-migration cross-binding check.
do $$
declare
  organization_id constant uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  actor_id constant uuid := '11111111-1111-1111-1111-111111111111';
  content_hash constant text := repeat('6', 64);
  verifier_digest constant text := repeat('9', 64);
  release_integrity constant text := 'sha384-AAAA';
  release_manifest constant jsonb := jsonb_build_object(
    'releaseId', repeat('a', 64),
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
  artifact_url constant text :=
    'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
    || repeat('6', 64) || '.js';
  download_url constant text := artifact_url || '?download=page2webmcp-' || repeat('6', 64) || '.js';
begin
  insert into public.projects (
    id, organization_id, created_by, name, source_type, source_url, status
  ) values (
    '92000000-0000-4000-8000-000000000001', organization_id, actor_id,
    'Verifier v2 upgrade fixture', 'website', 'https://verifier-v2-upgrade.example', 'analyzed'
  );

  insert into public.project_sources (
    id, organization_id, project_id, source_type, source_url, source_configuration, version, active
  ) values (
    '92000000-0000-4000-8000-000000000011', organization_id,
    '92000000-0000-4000-8000-000000000001', 'website',
    'https://verifier-v2-upgrade.example', '{"kind":"website"}', 1, true
  );

  insert into public.source_snapshots (
    id, organization_id, project_id, project_source_id, source_identity_hash, is_fixture
  ) values (
    '92000000-0000-4000-8000-000000000021', organization_id,
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000011', repeat('7', 64), false
  );

  insert into public.analysis_runs (
    id, organization_id, project_id, requested_by, status, attempts, result,
    provider_mode, provider_adapter, provider_adapter_version, provider_fixture
  ) values (
    '92000000-0000-4000-8000-000000000031', organization_id,
    '92000000-0000-4000-8000-000000000001', actor_id, 'succeeded', 1, '{}',
    'website', 'browser-use-v4', 4, false
  );

  insert into public.workflow_runs (
    id, organization_id, project_id, source_snapshot_id, analysis_run_id,
    status, current_phase, input_hash
  ) values (
    '92000000-0000-4000-8000-000000000031', organization_id,
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000021',
    '92000000-0000-4000-8000-000000000031', 'queued', 'analysis', repeat('8', 64)
  );

  insert into public.verification_runs (
    id, organization_id, project_id, analysis_run_id, capability_state_digest,
    candidate_content_hash, candidate_code, candidate_allowed_origin, candidate_manifest,
    schema_valid, authenticated, replay_passes, no_secret_leakage, browser_execution,
    selection_score, checks, csp_result, verification_mode, eligible, failures,
    verifier_protocol_version, verifier_origin_digest, verifier_webmcp_implementation,
    observed_content_hash, observed_integrity, observed_release_id, observed_target_origin,
    registered_tools, trusted_loader_enforced, trusted_loader_content_hash,
    control_plane_request_count, model_request_count
  ) values (
    '92000000-0000-4000-8000-000000000041', organization_id,
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000031', repeat('8', 64), content_hash,
    'verifier v2 upgrade candidate', 'https://verifier-v2-upgrade.example', release_manifest,
    true, true, 3, true, true, 20, passed_checks, '{"hosted":"allowed"}', 'live', true, '{}',
    1, verifier_digest, 'native', content_hash, release_integrity, repeat('a', 64),
    'https://verifier-v2-upgrade.example', expected_tools, true, content_hash, 0, 0
  );

  insert into public.releases (
    id, organization_id, project_id, analysis_run_id, capability_state_digest,
    content_hash, sri, code, allowed_origin, manifest, verification_run_id,
    artifact_url, download_url, local_only, status
  ) values (
    '92000000-0000-4000-8000-000000000051', organization_id,
    '92000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000031', repeat('8', 64), content_hash,
    release_integrity, 'verifier v2 upgrade candidate', 'https://verifier-v2-upgrade.example',
    release_manifest, '92000000-0000-4000-8000-000000000041', artifact_url,
    download_url, false, 'published'
  );

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
  ) values
    (
      '92000000-0000-4000-8000-000000000061', organization_id,
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000051', actor_id,
      'https://verifier-v2-upgrade.example/behavior', artifact_url, null,
      'https://verifier-v2-upgrade.example', content_hash, release_integrity, expected_tools,
      'verified', 'hosted', 'allowed', null, 'native', '{}', 'v2-upgrade-behavior',
      repeat('b', 64), download_url, false, 'live', 1, verifier_digest, 'native', artifact_url,
      download_url, false, release_integrity, 'https://verifier-v2-upgrade.example', expected_tools,
      artifact_url, content_hash, content_hash, true, false, false, false, true,
      'read_widget', true, true, 'mutate_widget', 'explicit', true, true, 1,
      'mutate_widget', 'target', true, '2026-08-31T20:02:00Z'
    ),
    (
      '92000000-0000-4000-8000-000000000062', organization_id,
      '92000000-0000-4000-8000-000000000001',
      '92000000-0000-4000-8000-000000000051', actor_id,
      'https://verifier-v2-upgrade.example/attestation', artifact_url, null,
      'https://verifier-v2-upgrade.example', content_hash, release_integrity, expected_tools,
      'verified', 'hosted', 'allowed', null, 'native', '{}', 'v2-upgrade-attestation',
      repeat('c', 64), download_url, false, 'live', 1, verifier_digest, 'native', artifact_url,
      download_url, false, release_integrity, 'https://verifier-v2-upgrade.example', expected_tools,
      artifact_url, content_hash, content_hash, true, true, false, false, true,
      'read_widget', true, true, 'mutate_widget', 'explicit', true, true, 1,
      'mutate_widget', 'target', true, '2026-08-31T20:01:00Z'
    );

  if not (select eligible from public.verification_runs
    where id = '92000000-0000-4000-8000-000000000041') then
    raise exception 'v1 upgrade fixture is not eligible under the validated equality constraint';
  end if;
end;
$$;
