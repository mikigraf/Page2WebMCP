begin;

alter table private.website_authentication_checkpoints
  drop constraint website_authentication_checkpoints_cleanup_status_check,
  drop constraint website_authentication_cleanup_state_check,
  add constraint website_authentication_cleanup_status_check
    check (cleanup_status is null or cleanup_status in ('pending', 'running', 'succeeded', 'failed')),
  add constraint website_authentication_cleanup_state_check check (
    state in ('waiting', 'consumed') and cleanup_status is null
      and cleanup_available_at is null and cleanup_completed_at is null
    or state = 'completed' and cleanup_status = 'succeeded'
      and cleanup_completed_at is not null
    or state in ('failed', 'cancelled', 'expired')
      and cleanup_status in ('pending', 'running', 'succeeded', 'failed')
  ),
  add constraint website_authentication_cleanup_attempt_budget_check
    check (cleanup_attempts <= 3);

alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901090842;
revoke all on function private.selected_release_readiness_topology_legacy_20260901090842(text)
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
      ('20260901060852'),
      ('20260901071658'),
      ('20260901090842'),
      ('20260901092107')
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
  ), cleanup_budget as (
    select exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'private'
        and relation.relname = 'website_authentication_checkpoints'
        and constraint_row.conname = 'website_authentication_cleanup_attempt_budget_check'
    ) as verified
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901090842(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and coalesce((select verified from cleanup_budget), false),
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
