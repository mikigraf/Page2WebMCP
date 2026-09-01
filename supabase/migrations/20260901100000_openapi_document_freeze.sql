begin;

alter table public.source_snapshots
  add column source_artifact_metadata jsonb;

alter table public.source_snapshots
  add constraint source_snapshots_openapi_artifact_identity_check check (
    (content_hash is null and artifact_reference is null and source_artifact_metadata is null)
    or (
      content_hash ~ '^[0-9a-f]{64}$'
      and artifact_reference = 'urn:sha256:' || content_hash
      and jsonb_typeof(source_artifact_metadata) = 'object'
      and octet_length(source_artifact_metadata::text) between 1 and 8192
      and source_artifact_metadata ?& array['finalUrl', 'mimeType', 'sizeBytes']::text[]
      and source_artifact_metadata = jsonb_build_object(
        'finalUrl', source_artifact_metadata->'finalUrl',
        'mimeType', source_artifact_metadata->'mimeType',
        'sizeBytes', source_artifact_metadata->'sizeBytes'
      )
      and jsonb_typeof(source_artifact_metadata->'finalUrl') = 'string'
      and octet_length(source_artifact_metadata->>'finalUrl') between 1 and 4096
      and position('?' in source_artifact_metadata->>'finalUrl') = 0
      and position('#' in source_artifact_metadata->>'finalUrl') = 0
      and source_artifact_metadata->>'finalUrl'
        ~ '^https://[^/?#@[:space:][:cntrl:]]+(?:/[^?#[:space:][:cntrl:]]*)?$'
      and jsonb_typeof(source_artifact_metadata->'mimeType') = 'string'
      and source_artifact_metadata->>'mimeType' in (
        'application/json', 'application/openapi+json', 'application/vnd.oai.openapi+json',
        'application/yaml', 'application/x-yaml', 'text/yaml', 'application/vnd.oai.openapi',
        'application/vnd.oai.openapi+yaml'
      )
      and jsonb_typeof(source_artifact_metadata->'sizeBytes') = 'number'
      and source_artifact_metadata->>'sizeBytes' ~ '^[1-9][0-9]{0,6}$'
      and (source_artifact_metadata->>'sizeBytes')::bigint between 1 and 1000000
    )
  ) not valid;

alter table public.source_snapshots
  validate constraint source_snapshots_openapi_artifact_identity_check;

create function private.enforce_source_snapshot_artifact_immutability()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.content_hash is not null
    or old.artifact_reference is not null
    or old.source_artifact_metadata is not null then
    if new.content_hash is distinct from old.content_hash
      or new.artifact_reference is distinct from old.artifact_reference
      or new.source_artifact_metadata is distinct from old.source_artifact_metadata then
      raise exception 'source snapshot artifact identity is immutable' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_source_snapshot_artifact_immutability()
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;

create trigger enforce_source_snapshot_artifact_immutability
before update of content_hash, artifact_reference, source_artifact_metadata
on public.source_snapshots
for each row execute function private.enforce_source_snapshot_artifact_immutability();

drop policy if exists "worker freezes active workflow source snapshot" on public.source_snapshots;
create policy "worker freezes active workflow source snapshot"
on public.source_snapshots for update to page2webmcp_worker
using (exists (
  select 1 from public.workflow_runs workflow
  where workflow.source_snapshot_id = source_snapshots.id
    and workflow.current_phase = 'analysis'
    and private.worker_has_active_workflow_lease(workflow.id)
))
with check (exists (
  select 1 from public.workflow_runs workflow
  where workflow.source_snapshot_id = source_snapshots.id
    and workflow.current_phase = 'analysis'
    and private.worker_has_active_workflow_lease(workflow.id)
));

revoke insert on public.source_snapshots from page2webmcp_app;
grant insert (organization_id, project_id, project_source_id, source_identity_hash, is_fixture)
  on public.source_snapshots to page2webmcp_app;
revoke update (content_hash, artifact_reference, source_artifact_metadata)
  on public.source_snapshots from public, anon, authenticated, service_role, page2webmcp_app;
grant update (content_hash, artifact_reference, source_artifact_metadata)
  on public.source_snapshots to page2webmcp_worker;
alter table public.source_snapshots enable row level security;
alter table public.source_snapshots force row level security;

alter function private.selected_provider_probe_context(text)
  rename to selected_provider_probe_context_legacy_20260901060852;
revoke all on function private.selected_provider_probe_context_legacy_20260901060852(text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;

create function private.selected_provider_probe_context(selected_hash text)
returns table (
  source_type text,
  source_url text,
  source_configuration jsonb,
  source_identity_hash text,
  source_content_hash text,
  source_artifact_reference text,
  source_final_url text,
  source_mime_type text,
  source_size_bytes bigint,
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
  with legacy as (
    select * from private.selected_provider_probe_context_legacy_20260901060852(selected_hash)
  ), selected_snapshot as (
    select
      source_snapshot.source_identity_hash,
      source_snapshot.content_hash,
      source_snapshot.artifact_reference,
      source_snapshot.source_artifact_metadata
    from public.releases release
    join public.analysis_runs analysis
      on analysis.id = release.analysis_run_id
     and analysis.project_id = release.project_id
     and analysis.organization_id = release.organization_id
    join public.workflow_runs workflow
      on workflow.analysis_run_id = analysis.id
     and workflow.project_id = analysis.project_id
     and workflow.organization_id = analysis.organization_id
    join public.source_snapshots source_snapshot
      on workflow.source_snapshot_id = source_snapshot.id
     and source_snapshot.project_id = workflow.project_id
     and source_snapshot.organization_id = workflow.organization_id
    where release.content_hash = selected_hash
      and release.status = 'published'
  )
  select distinct
    legacy.source_type,
    legacy.source_url,
    legacy.source_configuration,
    legacy.source_identity_hash,
    case when legacy.source_type = 'openapi' then selected_snapshot.content_hash else null end,
    case when legacy.source_type = 'openapi' then selected_snapshot.artifact_reference else null end,
    case when legacy.source_type = 'openapi'
      then selected_snapshot.source_artifact_metadata->>'finalUrl' else null end,
    case when legacy.source_type = 'openapi'
      then selected_snapshot.source_artifact_metadata->>'mimeType' else null end,
    case when legacy.source_type = 'openapi'
      then (selected_snapshot.source_artifact_metadata->>'sizeBytes')::bigint else null end,
    legacy.github_installation_id,
    legacy.github_repository_id,
    legacy.github_owner,
    legacy.github_repository,
    legacy.github_ref,
    legacy.github_commit_sha,
    legacy.github_target_origin
  from legacy
  join selected_snapshot
    on selected_snapshot.source_identity_hash = legacy.source_identity_hash
  where legacy.source_type <> 'openapi'
    or (selected_snapshot.content_hash is not null
      and selected_snapshot.artifact_reference = 'urn:sha256:' || selected_snapshot.content_hash
      and selected_snapshot.source_artifact_metadata is not null);
end;
$$;

revoke all on function private.selected_provider_probe_context(text)
  from public, anon, authenticated, service_role, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_provider_probe_context(text) to page2webmcp_maintenance;

alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901094032;
revoke all on function private.selected_release_readiness_topology_legacy_20260901094032(text)
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
      ('20260901090842'), ('20260901092107'), ('20260901094032'), ('20260901100000')
  ), applied_migrations(version) as (
    select migration.version::text from supabase_migrations.schema_migrations migration
  ), migration_state as (
    select (select count(*) = count(distinct version) from applied_migrations)
      and coalesce((select array_agg(version order by version) from applied_migrations), array[]::text[])
        = (select array_agg(version order by version) from required_migrations) as current
  ), source_identity_guard as (
    select relation.relrowsecurity and relation.relforcerowsecurity
      and has_column_privilege('page2webmcp_worker', 'public.source_snapshots', 'content_hash', 'update')
      and has_column_privilege('page2webmcp_worker', 'public.source_snapshots', 'artifact_reference', 'update')
      and has_column_privilege('page2webmcp_worker', 'public.source_snapshots', 'source_artifact_metadata', 'update')
      and not has_column_privilege('page2webmcp_app', 'public.source_snapshots', 'content_hash', 'update')
      and not has_column_privilege('page2webmcp_app', 'public.source_snapshots', 'artifact_reference', 'update')
      and not has_column_privilege('page2webmcp_app', 'public.source_snapshots', 'source_artifact_metadata', 'update')
      and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid = relation.oid
          and constraint_row.conname = 'source_snapshots_openapi_artifact_identity_check'
          and constraint_row.contype = 'c' and constraint_row.convalidated
      )
      and exists (
        select 1 from pg_catalog.pg_policy policy_row
        where policy_row.polrelid = relation.oid
          and policy_row.polname = 'worker freezes active workflow source snapshot'
          and pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid) ~ 'current_phase'
          and pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid) ~ 'analysis'
          and pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) ~ 'current_phase'
          and pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid) ~ 'analysis'
      )
      and exists (
        select 1 from pg_catalog.pg_trigger trigger_row
        where trigger_row.tgrelid = relation.oid
          and trigger_row.tgname = 'enforce_source_snapshot_artifact_immutability'
          and trigger_row.tgenabled = 'O' and not trigger_row.tgisinternal
      ) as verified
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public' and relation.relname = 'source_snapshots'
  ), legacy as (
    select * from private.selected_release_readiness_topology_legacy_20260901094032(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and coalesce((select verified from source_identity_guard), false),
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
