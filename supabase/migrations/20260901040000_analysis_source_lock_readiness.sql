begin;

-- The source-lock control is part of the production topology. Advance the
-- exact migration ledger and prove that only the application role can invoke
-- the definer before readiness can succeed.
alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901020000;
revoke all on function private.selected_release_readiness_topology_legacy_20260901020000(text)
  from public;
revoke all on function private.selected_release_readiness_topology_legacy_20260901020000(text)
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
      ('20260901040000')
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
  ), source_lock_state as (
    select
      pg_catalog.has_function_privilege(
        'page2webmcp_app',
        'private.lock_active_analysis_source(uuid,uuid,uuid,uuid,text)',
        'execute'
      )
      and not pg_catalog.has_function_privilege(
        'anon',
        'private.lock_active_analysis_source(uuid,uuid,uuid,uuid,text)',
        'execute'
      )
      and not pg_catalog.has_function_privilege(
        'authenticated',
        'private.lock_active_analysis_source(uuid,uuid,uuid,uuid,text)',
        'execute'
      )
      and not pg_catalog.has_function_privilege(
        'page2webmcp_worker',
        'private.lock_active_analysis_source(uuid,uuid,uuid,uuid,text)',
        'execute'
      )
      and not pg_catalog.has_function_privilege(
        'page2webmcp_maintenance',
        'private.lock_active_analysis_source(uuid,uuid,uuid,uuid,text)',
        'execute'
      ) as current
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901020000(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and (select current from source_lock_state),
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
grant execute on function private.selected_release_readiness_topology(text)
  to page2webmcp_maintenance;

commit;
