begin;

-- Return only immutable, secret-free identity facts for the exact selected
-- hosted release. The v2 native-proof projection remains the authoritative
-- eligibility gate; this function adds the identities required to serialize a
-- production receipt without granting maintenance direct table access.
create function private.selected_production_live_receipt_evidence(selected_hash text)
returns table (
  selected_release_hash text,
  release_id_digest text,
  organization_identity_digest text,
  project_identity_digest text,
  analysis_run_identity_digest text,
  source_type text,
  source_identity_digest text,
  source_document_identity_digest text,
  source_identity_hash text,
  target_origin text,
  environment text,
  test_page_identity_digest text,
  install_page_identity_digest text,
  artifact_url text,
  download_url text,
  artifact_size_bytes bigint,
  artifact_integrity text,
  hosted_object_identity_digest text,
  named_download_identity_digest text,
  installation_identity_digest text,
  provider_mode text,
  provider_adapter text,
  provider_adapter_version integer,
  migration_from text,
  migration_to text,
  migration_digest text,
  openapi_cleanup_digest text,
  candidate_verifier_origin_digest text,
  installation_verifier_origin_digest text,
  candidate_attestation_id uuid,
  candidate_attestation_request_id uuid,
  candidate_attestation_nonce_digest text,
  candidate_attestation_scope_digest text,
  candidate_attestation_payload_digest text,
  candidate_attestation_issued_at timestamptz,
  candidate_attestation_expires_at timestamptz,
  candidate_attestation_attested_at timestamptz,
  installation_attestation_id uuid,
  installation_attestation_request_id uuid,
  installation_attestation_nonce_digest text,
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
  with proof as (
    select * from private.selected_native_installation_proof(selected_hash)
  ), ledger as (
    select migration.version::text as version
    from supabase_migrations.schema_migrations migration
  ), ledger_identity as (
    select
      min(version) as migration_from,
      max(version) as migration_to,
      pg_catalog.encode(extensions.digest(
        pg_catalog.string_agg(version, E'\n' order by version), 'sha256'
      ), 'hex') as migration_digest
    from ledger
  )
  select
    selected_hash,
    pg_catalog.encode(extensions.digest('release:' || release.id::text, 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest('organization:' || release.organization_id::text, 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest('project:' || release.project_id::text, 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest('analysis:' || release.analysis_run_id::text, 'sha256'), 'hex'),
    source.source_type,
    pg_catalog.encode(extensions.digest('source:' || source.id::text, 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(
      'snapshot:' || snapshot.id::text || ':' || snapshot.source_identity_hash || ':'
        || pg_catalog.coalesce(snapshot.content_hash, ''), 'sha256'
    ), 'hex'),
    snapshot.source_identity_hash,
    release.allowed_origin,
    proof.environment,
    pg_catalog.encode(extensions.digest(
      case when source.source_type = 'openapi'
        then source.source_configuration->>'testPageUrl'
        else source.source_url
      end, 'sha256'
    ), 'hex'),
    pg_catalog.encode(extensions.digest(installation.page_url, 'sha256'), 'hex'),
    release.artifact_url,
    release.download_url,
    pg_catalog.octet_length(release.code)::bigint,
    release.sri,
    pg_catalog.encode(extensions.digest(
      pg_catalog.jsonb_build_object(
        'contentHash', release.content_hash,
        'size', pg_catalog.octet_length(release.code),
        'url', release.artifact_url
      )::text, 'sha256'
    ), 'hex'),
    pg_catalog.encode(extensions.digest(
      pg_catalog.jsonb_build_object(
        'contentHash', release.content_hash,
        'size', pg_catalog.octet_length(release.code),
        'url', release.download_url
      )::text, 'sha256'
    ), 'hex'),
    pg_catalog.encode(extensions.digest('installation:' || installation.id::text, 'sha256'), 'hex'),
    analysis.provider_mode,
    analysis.provider_adapter,
    analysis.provider_adapter_version,
    ledger_identity.migration_from,
    ledger_identity.migration_to,
    ledger_identity.migration_digest,
    case when source.source_type = 'openapi' then
      pg_catalog.encode(extensions.digest(
        'openapi-stateless:v1:' || snapshot.id::text || ':' || release.content_hash, 'sha256'
      ), 'hex')
    else null end,
    proof.candidate_verifier_origin_digest,
    proof.installation_verifier_origin_digest,
    proof.candidate_attestation_id,
    proof.candidate_attestation_request_id,
    proof.candidate_attestation_nonce_digest,
    proof.candidate_attestation_scope_digest,
    proof.candidate_attestation_payload_digest,
    proof.candidate_attestation_issued_at,
    proof.candidate_attestation_expires_at,
    proof.candidate_attestation_attested_at,
    proof.installation_attestation_id,
    proof.installation_attestation_request_id,
    proof.installation_attestation_nonce_digest,
    proof.installation_attestation_scope_digest,
    proof.installation_attestation_payload_digest,
    proof.installation_attestation_issued_at,
    proof.installation_attestation_expires_at,
    proof.installation_attestation_attested_at,
    proof.installation_verified_at
  from proof
  join public.releases release
    on release.id = proof.release_id
   and release.project_id = proof.project_id
   and release.analysis_run_id = proof.analysis_run_id
   and release.content_hash = selected_hash
   and release.status = 'published'
   and release.local_only = false
  join public.analysis_runs analysis
    on analysis.id = release.analysis_run_id
   and analysis.project_id = release.project_id
   and analysis.organization_id = release.organization_id
  join public.workflow_runs workflow
    on workflow.analysis_run_id = analysis.id
   and workflow.project_id = analysis.project_id
   and workflow.organization_id = analysis.organization_id
  join public.source_snapshots snapshot
    on snapshot.id = workflow.source_snapshot_id
   and snapshot.project_id = workflow.project_id
   and snapshot.organization_id = workflow.organization_id
  join public.project_sources source
    on source.id = snapshot.project_source_id
   and source.project_id = snapshot.project_id
   and source.organization_id = snapshot.organization_id
  join public.release_installations installation
    on installation.release_id = release.id
   and installation.project_id = release.project_id
   and installation.organization_id = release.organization_id
   and installation.verifier_attestation_id = proof.installation_attestation_id
  cross join ledger_identity
  where source.source_type in ('openapi', 'website')
    and analysis.provider_mode = source.source_type
    and proof.selected_release_hash = selected_hash
    and proof.candidate_protocol_version = 2
    and proof.installation_protocol_version = 2
    and proof.candidate_attestation_id <> proof.installation_attestation_id
    and proof.candidate_attestation_request_id <> proof.installation_attestation_request_id
    and proof.candidate_verifier_origin_digest = proof.installation_verifier_origin_digest
    and proof.target_origin = release.allowed_origin
    and proof.source_identity_hash = snapshot.source_identity_hash
    and proof.installation_page_url = installation.page_url
    and release.artifact_url =
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
      || release.content_hash || '.js'
    and release.download_url = release.artifact_url
      || '?download=page2webmcp-' || release.content_hash || '.js'
    and pg_catalog.octet_length(release.code) between 1 and 65536
    and ledger_identity.migration_from is not null
    and ledger_identity.migration_to is not null
    and ledger_identity.migration_digest ~ '^[0-9a-f]{64}$';
end;
$$;

revoke all on function private.selected_production_live_receipt_evidence(text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.selected_production_live_receipt_evidence(text)
  to page2webmcp_maintenance;

-- Adding a migration must never make the exact-ledger readiness check stale.
-- Replace the current wrapper and include this receipt boundary in both the
-- ledger and the RLS/privilege proof.
alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901120000;
revoke all on function private.selected_release_readiness_topology_legacy_20260901120000(text)
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
      ('20260826000000'), ('20260829074144'), ('20260829090000'),
      ('20260829092023'), ('20260829094207'), ('20260829100000'),
      ('20260830094622'), ('20260830120000'), ('20260830160000'),
      ('20260830180000'), ('20260830190000'), ('20260831090000'),
      ('20260831100000'), ('20260831110000'), ('20260831111000'),
      ('20260831120000'), ('20260831211329'), ('20260901000000'),
      ('20260901010000'), ('20260901020000'), ('20260901030000'),
      ('20260901040000'), ('20260901060852'), ('20260901071658'),
      ('20260901090842'), ('20260901092107'), ('20260901094032'),
      ('20260901100000'), ('20260901110000'), ('20260901120000'),
      ('20260901130000')
  ), applied_migrations(version) as (
    select migration.version::text
    from supabase_migrations.schema_migrations migration
  ), migration_state as (
    select
      (select pg_catalog.count(*) = pg_catalog.count(distinct version) from applied_migrations)
      and pg_catalog.coalesce(
        (select pg_catalog.array_agg(version order by version) from applied_migrations),
        array[]::text[]
      ) = (select pg_catalog.array_agg(version order by version) from required_migrations) as current
  ), privilege_state as (
    select
      pg_catalog.has_function_privilege(
        'page2webmcp_maintenance',
        'private.selected_production_live_receipt_evidence(text)', 'execute'
      )
      and not pg_catalog.has_function_privilege(
        'service_role', 'private.selected_production_live_receipt_evidence(text)', 'execute'
      )
      and not pg_catalog.has_function_privilege(
        'page2webmcp_app', 'private.selected_production_live_receipt_evidence(text)', 'execute'
      )
      and not pg_catalog.has_function_privilege(
        'page2webmcp_worker', 'private.selected_production_live_receipt_evidence(text)', 'execute'
      ) as valid
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901120000(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and (select valid from privilege_state),
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
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.selected_release_readiness_topology(text)
  to page2webmcp_maintenance;

commit;
