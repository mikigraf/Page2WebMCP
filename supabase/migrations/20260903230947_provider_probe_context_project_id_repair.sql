begin;

-- private.analysis_jobs has no project_id column (analysis_run_id and
-- organization_id already uniquely scope it); the join here required one
-- unconditionally, so every call failed with "column job.project_id does
-- not exist" the moment this ran. Confirmed live: never exercised before
-- now. The row is already uniquely identified by analysis_run_id +
-- organization_id, so the condition is dropped rather than replaced.
create or replace function private.selected_provider_probe_context_legacy_20260901060852(selected_hash text)
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

commit;
