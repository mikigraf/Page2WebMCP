begin;

create or replace function private.selected_release_readiness_topology_legacy_20260901130000(selected_hash text)
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
      and coalesce(
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

commit;
