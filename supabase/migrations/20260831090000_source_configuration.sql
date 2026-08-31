-- Persist the bounded verification context with the source and copy it to each
-- analysis job. Existing sources are deliberately marked legacy rather than
-- inferred, because they did not supply the required OpenAPI verification data.
create function private.valid_source_configuration(value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select jsonb_typeof(value) = 'object' and (
    value = '{"kind":"website"}'::jsonb
    or value = '{"kind":"github"}'::jsonb
    or value = '{"kind":"legacy_unconfigured"}'::jsonb
    or (
      value ?& array['kind', 'targetOrigin', 'testPageUrl', 'environment']
      and value - array['kind', 'targetOrigin', 'testPageUrl', 'environment'] = '{}'::jsonb
      and value->>'kind' = 'openapi'
      and value->>'environment' in ('test', 'staging', 'production')
      and value->>'targetOrigin' ~ '^https://[^/?#@]+(?::[0-9]{1,5})?$'
      and value->>'testPageUrl' ~ '^https://[^?#@]+(?:\\?[^#]*)?$'
      and left(value->>'testPageUrl', octet_length(value->>'targetOrigin')) = value->>'targetOrigin'
      and substring(value->>'testPageUrl' from octet_length(value->>'targetOrigin') + 1 for 1) = '/'
    )
  );
$$;

revoke all on function private.valid_source_configuration(jsonb) from public;
grant execute on function private.valid_source_configuration(jsonb) to page2webmcp_app, page2webmcp_worker;

alter table public.project_sources
  add column source_configuration jsonb;

update public.project_sources
set source_configuration = '{"kind":"legacy_unconfigured"}'::jsonb
where source_configuration is null;

alter table public.project_sources
  alter column source_configuration set not null,
  add constraint project_sources_source_configuration_check
    check (private.valid_source_configuration(source_configuration));

alter table private.analysis_jobs
  add column source_configuration jsonb;

update private.analysis_jobs job
set source_configuration = source.source_configuration
from public.analysis_runs run
join public.project_sources source
  on source.project_id = run.project_id
 and source.organization_id = run.organization_id
 and source.active
where job.analysis_run_id = run.id
  and job.organization_id = run.organization_id
  and job.source_configuration is null;

do $$
begin
  if exists (select 1 from private.analysis_jobs where source_configuration is null) then
    raise exception 'every analysis job must resolve to a source configuration before hardening';
  end if;
end
$$;

alter table private.analysis_jobs
  alter column source_configuration set not null,
  add constraint analysis_jobs_source_configuration_check
    check (private.valid_source_configuration(source_configuration));

-- Source snapshots bind the canonical JSON representation as well as type/URL.
update public.source_snapshots snapshot
set source_identity_hash = encode(digest(
  octet_length(source.source_type)::text || ':' || source.source_type || ':' ||
  octet_length(source.source_url)::text || ':' || source.source_url || ':' ||
  octet_length(source.source_configuration::text)::text || ':' || source.source_configuration::text,
  'sha256'
), 'hex')
from public.project_sources source
where source.id = snapshot.project_source_id
  and source.project_id = snapshot.project_id
  and source.organization_id = snapshot.organization_id;

-- Both tables already use forced RLS. Reassert the role boundary after adding
-- the JSON columns: no anon/authenticated role receives table access.
revoke all on public.project_sources from anon, authenticated;
revoke all on private.analysis_jobs from anon, authenticated;
grant select, insert on public.project_sources to page2webmcp_app;
grant select on public.project_sources to page2webmcp_worker;
grant select, insert on private.analysis_jobs to page2webmcp_app;
grant select, update (status, attempts, lease_owner, lease_expires_at, available_at, updated_at)
  on private.analysis_jobs to page2webmcp_worker;
