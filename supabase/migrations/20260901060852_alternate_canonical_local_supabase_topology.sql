begin;

-- Retire the occupied 5432x local artifact identity without changing hosted
-- identities. Historical local rows remain local-only; a formerly verified
-- installation is failed and must be observed again through the new endpoint.
alter table public.releases
  drop constraint releases_artifact_identity_check;

alter table public.release_installations
  drop constraint release_installations_artifact_url_check;

update public.release_installations
set status = 'failed',
    verified_at = null,
    authenticated_read_tool_name = null,
    authenticated_read_authenticated = null,
    authenticated_read_succeeded = null,
    confirmed_mutation_tool_name = null,
    confirmed_mutation_confirmation = null,
    confirmed_mutation_reversible = null,
    confirmed_mutation_succeeded = null,
    confirmed_mutation_effect_count = null,
    final_state_mutation_tool_name = null,
    final_state_source = null,
    final_state_verified = null
where local_only is true
  and status = 'verified'
  and artifact_url =
    'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/'
    || artifact_content_hash || '.js';

update public.release_installations
set artifact_url = replace(
      artifact_url,
      'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/',
      'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
    ),
    download_url = case
      when download_url = artifact_url || '?download=page2webmcp-' || artifact_content_hash || '.js'
      then replace(
        download_url,
        'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/',
        'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
      )
      else download_url
    end,
    observed_artifact_url = case
      when observed_artifact_url = artifact_url then replace(
        observed_artifact_url,
        'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/',
        'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
      )
      else observed_artifact_url
    end,
    observed_download_url = case
      when observed_download_url = artifact_url || '?download=page2webmcp-'
        || artifact_content_hash || '.js'
      then replace(
        observed_download_url,
        'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/',
        'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
      )
      else observed_download_url
    end,
    executed_artifact_url = case
      when executed_artifact_url = artifact_url then replace(
        executed_artifact_url,
        'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/',
        'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
      )
      else executed_artifact_url
    end
where local_only is true
  and artifact_url =
    'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/'
    || artifact_content_hash || '.js';

update public.releases
set artifact_url =
      'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
      || content_hash || '.js',
    download_url =
      'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
      || content_hash || '.js?download=page2webmcp-' || content_hash || '.js'
where local_only is true
  and artifact_url =
    'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/'
    || content_hash || '.js';

alter table public.releases
  add constraint releases_artifact_identity_check check (
    (artifact_url is null and download_url is null and local_only is null)
    or (
      artifact_url is not null and download_url is not null and local_only is not null
      and octet_length(artifact_url) between 1 and 2048
      and octet_length(download_url) between 1 and 2048
      and download_url = artifact_url || '?download=page2webmcp-' || content_hash || '.js'
      and (
        (not local_only and artifact_url =
          'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
          || content_hash || '.js')
        or
        (local_only and artifact_url =
          'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
          || content_hash || '.js')
      )
    )
  );

-- Preserve deliberately unvalidated legacy observations while ensuring every
-- new installation uses a hosted identity or the one alternate local prefix.
alter table public.release_installations
  add constraint release_installations_artifact_url_check check (
    artifact_url =
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
      || artifact_content_hash || '.js'
    or artifact_url =
      'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
      || artifact_content_hash || '.js'
  ) not valid;

-- The selected provider projection also binds the artifact identity. Preserve
-- its old definition as an uncallable audit helper and replace the active path.
alter function private.selected_provider_probe_context(text)
  rename to selected_provider_probe_context_legacy_20260901000000;
revoke all on function private.selected_provider_probe_context_legacy_20260901000000(text)
  from public;
revoke all on function private.selected_provider_probe_context_legacy_20260901000000(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker, page2webmcp_maintenance;

create function private.selected_provider_probe_context(selected_hash text)
returns table (
  source_type text,
  source_url text,
  source_configuration jsonb,
  source_identity_hash text,
  github_installation_id bigint,
  github_repository_id bigint,
  github_owner text,
  github_repository text,
  github_ref text,
  github_commit_sha text,
  github_target_origin text
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
  with selected as (
    select distinct
      release.analysis_run_id,
      analysis.provider_mode,
      source.source_type,
      source.source_url,
      source.source_configuration,
      source_snapshot.source_identity_hash
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
    join private.analysis_jobs job
      on job.analysis_run_id = analysis.id
     and job.project_id = analysis.project_id
     and job.organization_id = analysis.organization_id
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
      and job.source_type = source.source_type
      and job.source_url = source.source_url
      and job.source_configuration = source.source_configuration
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
          'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
          || release.content_hash || '.js')
        or (release.local_only = false and release.artifact_url =
          'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/'
          || release.content_hash || '.js')
      )
      and release.download_url = release.artifact_url
        || '?download=page2webmcp-' || release.content_hash || '.js'
  ), github_context as (
    select selected.analysis_run_id, evidence.content::jsonb as content
    from selected
    join public.analysis_evidence evidence
      on evidence.analysis_run_id = selected.analysis_run_id
     and evidence.source = 'github'
    where selected.provider_mode = 'github'
      and evidence.reference = 'urn:sha256:'
        || encode(extensions.digest(evidence.content, 'sha256'), 'hex')
      and evidence.content::jsonb->>'adapter' = 'github-nextjs-source'
      and evidence.content::jsonb->>'adapterVersion' = '1'
  )
  select distinct
    selected.source_type,
    selected.source_url,
    selected.source_configuration,
    selected.source_identity_hash,
    case when selected.provider_mode = 'github'
      then (github_context.content->>'installationId')::bigint else null end,
    case when selected.provider_mode = 'github'
      then (github_context.content->>'repositoryId')::bigint else null end,
    case when selected.provider_mode = 'github'
      then split_part(github_context.content->>'repository', '/', 1) else null end,
    case when selected.provider_mode = 'github'
      then split_part(github_context.content->>'repository', '/', 2) else null end,
    case when selected.provider_mode = 'github'
      then github_context.content->>'requestedRef' else null end,
    case when selected.provider_mode = 'github'
      then github_context.content->>'commitSha' else null end,
    case when selected.provider_mode = 'github'
      then github_context.content->>'targetOrigin' else null end
  from selected
  left join github_context on github_context.analysis_run_id = selected.analysis_run_id;
end;
$$;

revoke all on function private.selected_provider_probe_context(text) from public;
revoke all on function private.selected_provider_probe_context(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_provider_probe_context(text)
  to page2webmcp_maintenance;

-- Advance the exact schema ledger. The prior function remains uncallable and
-- supplies only RLS/hosted facts; local path facts are recomputed against the
-- alternate canonical prefix so no old local identity can satisfy readiness.
alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901040000;
revoke all on function private.selected_release_readiness_topology_legacy_20260901040000(text)
  from public;
revoke all on function private.selected_release_readiness_topology_legacy_20260901040000(text)
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
      ('20260831211329'),
      ('20260901000000'),
      ('20260901010000'),
      ('20260901020000'),
      ('20260901030000'),
      ('20260901040000'),
      ('20260901060852')
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
    from private.selected_release_readiness_topology_legacy_20260901040000(selected_hash)
  ), selected_local_paths as (
    select analysis.provider_mode
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
      and release.local_only is true
      and release.artifact_url =
        'http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases/'
        || release.content_hash || '.js'
      and release.download_url = release.artifact_url
        || '?download=page2webmcp-' || release.content_hash || '.js'
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
  )
  select
    (select current from migration_state),
    legacy.rls_verified,
    exists (select 1 from selected_local_paths path where path.provider_mode = 'openapi'),
    exists (select 1 from selected_local_paths path where path.provider_mode = 'website'),
    exists (select 1 from selected_local_paths path where path.provider_mode = 'github'),
    legacy.hosted_openapi_release,
    legacy.hosted_website_release,
    legacy.hosted_github_release
  from legacy;
end;
$$;

revoke all on function private.selected_release_readiness_topology(text) from public;
revoke all on function private.selected_release_readiness_topology(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_release_readiness_topology(text)
  to page2webmcp_maintenance;

commit;
