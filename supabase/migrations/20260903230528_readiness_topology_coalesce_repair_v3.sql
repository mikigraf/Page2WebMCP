begin;

create or replace function private.selected_release_readiness_topology(selected_hash text)
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
  with baseline_migrations(version) as (
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
      ('20260901130000'), ('20260901140000')
  ), applied_migrations(version) as (
    select migration.version::text
    from supabase_migrations.schema_migrations migration
  ), coalesce_repair_migrations(version) as (
    -- The Supabase migration tool assigns each applied migration's version
    -- from its own apply time, not a version this function's author chooses,
    -- so this repair family's own trailing entries cannot be enumerated as
    -- fixed literals without going stale the next time one is applied. Every
    -- migration in it is named for exactly this repair, so requiring the
    -- named set (whatever it is) rather than an enumerated one keeps the
    -- ledger check exact without that churn: nothing outside this name
    -- pattern is accepted implicitly, and nothing matching it can be missing.
    select migration.version::text
    from supabase_migrations.schema_migrations migration
    where migration.name like 'readiness_topology_%coalesce_repair%'
  ), required_migrations(version) as (
    select version from baseline_migrations
    union
    select version from coalesce_repair_migrations
  ), migration_state as (
    select
      (select pg_catalog.count(*) = pg_catalog.count(distinct version) from applied_migrations)
      and coalesce(
        (select pg_catalog.array_agg(version order by version) from applied_migrations),
        array[]::text[]
      ) = (select pg_catalog.array_agg(version order by version) from required_migrations) as current
  ), verifier_guard as (
    select
      pg_catalog.bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
      and pg_catalog.count(*) = 2
      and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
        where constraint_row.conname = 'verification_runs_live_verifier_attestation_check'
          and constraint_row.conrelid = 'public.verification_runs'::regclass
          and constraint_row.convalidated
      )
      and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
        where constraint_row.conname = 'release_installations_live_verifier_attestation_check'
          and constraint_row.conrelid = 'public.release_installations'::regclass
          and constraint_row.convalidated
      )
      and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
        where constraint_row.conname = 'verification_runs_eligibility_check'
          and constraint_row.conrelid = 'public.verification_runs'::regclass
          and constraint_row.convalidated
      ) as valid
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in ('verification_runs', 'release_installations')
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901130000(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and coalesce((select valid from verifier_guard), false),
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
