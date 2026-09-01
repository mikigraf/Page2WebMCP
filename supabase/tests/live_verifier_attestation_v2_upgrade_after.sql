do $$
declare
  selected_installation_page text;
  selected_attestation_id uuid;
begin
  if not exists (
    select 1 from public.verification_runs
    where id = '92000000-0000-4000-8000-000000000041'
      and not eligible
      and 'MIGRATION_VERIFIER_V2_REVERIFY_REQUIRED' = any(failures)
  ) then
    raise exception 'eligible v1 verification was not invalidated for v2 reverification';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname in (
      'verification_runs_live_verifier_attestation_check',
      'release_installations_live_verifier_attestation_check',
      'verification_runs_eligibility_check'
    )
      and not constraint_row.convalidated
  ) or (
    select count(*)
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname in (
      'verification_runs_live_verifier_attestation_check',
      'release_installations_live_verifier_attestation_check',
      'verification_runs_eligibility_check'
    )
      and constraint_row.convalidated
  ) <> 3 then
    raise exception 'v2 verifier constraints are absent or unvalidated';
  end if;

  update public.verification_runs
  set verifier_protocol_version = 2,
      verifier_attestation_id = '92000000-1000-4000-8000-000000000041',
      verifier_attestation_request_id = '92000000-1000-4000-8000-000000000042',
      verifier_attestation_nonce_digest = repeat('b', 64),
      verifier_attestation_operation = 'candidate',
      verifier_attestation_scope_digest = repeat('c', 64),
      verifier_attestation_payload_digest = repeat('d', 64),
      verifier_attestation_issued_at = '2026-08-31T20:03:00Z',
      verifier_attestation_expires_at = '2026-08-31T20:05:00Z',
      verifier_attestation_attested_at = '2026-08-31T20:04:00Z',
      eligible = true,
      failures = '{}'
  where id = '92000000-0000-4000-8000-000000000041';

  update public.release_installations
  set verifier_protocol_version = 2,
      verifier_attestation_id = case id
        when '92000000-0000-4000-8000-000000000061'::uuid
          then '92000000-1000-4000-8000-000000000041'::uuid
        else '92000000-2000-4000-8000-000000000061'::uuid
      end,
      verifier_attestation_request_id = case id
        when '92000000-0000-4000-8000-000000000061'::uuid
          then '92000000-1000-4000-8000-000000000042'::uuid
        else '92000000-2000-4000-8000-000000000062'::uuid
      end,
      verifier_attestation_nonce_digest = repeat('e', 64),
      verifier_attestation_operation = 'installation',
      verifier_attestation_scope_digest = repeat('f', 64),
      verifier_attestation_payload_digest = repeat('a', 64),
      verifier_attestation_issued_at = '2026-08-31T20:03:00Z',
      verifier_attestation_expires_at = '2026-08-31T20:05:00Z',
      verifier_attestation_attested_at = '2026-08-31T20:04:00Z'
  where id in (
    '92000000-0000-4000-8000-000000000061',
    '92000000-0000-4000-8000-000000000062'
  );

  -- The newest row has valid behavior but reuses the candidate attestation;
  -- the older row has a distinct attestation but used route interception.
  -- Selecting the two halves independently would incorrectly return one row.
  if (select count(*) from private.selected_native_installation_proof(repeat('6', 64))) <> 0 then
    raise exception 'v2 proof cross-bound behavior and attestation from different installations';
  end if;

  update public.release_installations
  set verifier_attestation_id = '92000000-2000-4000-8000-000000000071',
      verifier_attestation_request_id = '92000000-2000-4000-8000-000000000072'
  where id = '92000000-0000-4000-8000-000000000061';

  select installation_page_url, installation_attestation_id
  into selected_installation_page, selected_attestation_id
  from private.selected_native_installation_proof(repeat('6', 64));

  if selected_installation_page is distinct from 'https://verifier-v2-upgrade.example/behavior'
    or selected_attestation_id is distinct from '92000000-2000-4000-8000-000000000071'::uuid then
    raise exception 'v2 proof did not bind behavior and attestation to the same deterministic installation';
  end if;

  delete from public.release_installations
  where project_id = '92000000-0000-4000-8000-000000000001';
  delete from public.releases
  where project_id = '92000000-0000-4000-8000-000000000001';
  delete from public.projects
  where id = '92000000-0000-4000-8000-000000000001';
end;
$$;
