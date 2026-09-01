begin;

alter table private.website_authentication_checkpoints
  add column cleanup_status text
    check (cleanup_status is null or cleanup_status in ('pending', 'running', 'succeeded')),
  add column cleanup_idempotency_key text generated always as
    ('website-auth-cleanup:' || substr(checkpoint_reference, 12)) stored,
  add column cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  add column cleanup_available_at timestamptz,
  add column cleanup_lease_owner text
    check (cleanup_lease_owner is null or cleanup_lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  add column cleanup_lease_expires_at timestamptz,
  add column cleanup_lease_generation bigint not null default 0 check (cleanup_lease_generation >= 0),
  add column cleanup_completed_at timestamptz,
  add column cleanup_last_error_code text
    check (cleanup_last_error_code is null or cleanup_last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$');

update private.website_authentication_checkpoints
set cleanup_status = case state
      when 'completed' then 'succeeded'
      when 'failed' then 'pending'
      when 'cancelled' then 'pending'
      when 'expired' then 'pending'
    end,
    cleanup_available_at = case when state in ('failed', 'cancelled', 'expired')
      then coalesce(terminal_at, updated_at) end,
    cleanup_completed_at = case when state = 'completed'
      then coalesce(terminal_at, updated_at) end
where state in ('completed', 'failed', 'cancelled', 'expired');

alter table private.website_authentication_checkpoints
  add constraint website_authentication_cleanup_state_check check (
    state in ('waiting', 'consumed') and cleanup_status is null
      and cleanup_available_at is null and cleanup_completed_at is null
    or state = 'completed' and cleanup_status = 'succeeded'
      and cleanup_completed_at is not null
    or state in ('failed', 'cancelled', 'expired')
      and cleanup_status in ('pending', 'running', 'succeeded')
  ),
  add constraint website_authentication_cleanup_lease_check check (
    (cleanup_lease_owner is null) = (cleanup_lease_expires_at is null)
    and (cleanup_status = 'running') = (cleanup_lease_owner is not null)
  ),
  add constraint website_authentication_cleanup_completion_check check (
    (cleanup_status = 'succeeded') = (cleanup_completed_at is not null)
  );

create index website_authentication_cleanup_claim_idx
  on private.website_authentication_checkpoints(cleanup_available_at, analysis_run_id)
  where cleanup_status in ('pending', 'running');

create function private.queue_website_authentication_checkpoint_cleanup()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.state <> new.state and new.state = 'completed' then
    new.cleanup_status := 'succeeded';
    new.cleanup_available_at := null;
    new.cleanup_lease_owner := null;
    new.cleanup_lease_expires_at := null;
    new.cleanup_completed_at := coalesce(new.terminal_at, now());
    new.cleanup_last_error_code := null;
  elsif old.state <> new.state and new.state in ('failed', 'cancelled', 'expired') then
    new.cleanup_status := 'pending';
    new.cleanup_available_at := coalesce(new.terminal_at, now());
    new.cleanup_lease_owner := null;
    new.cleanup_lease_expires_at := null;
    new.cleanup_completed_at := null;
    new.cleanup_last_error_code := null;
  end if;
  return new;
end
$$;

revoke all on function private.queue_website_authentication_checkpoint_cleanup()
  from public, anon, authenticated, service_role, page2webmcp_maintenance;
grant execute on function private.queue_website_authentication_checkpoint_cleanup()
  to page2webmcp_app, page2webmcp_worker;

create trigger queue_website_authentication_checkpoint_cleanup
before update on private.website_authentication_checkpoints
for each row execute function private.queue_website_authentication_checkpoint_cleanup();

grant update (
  cleanup_status, cleanup_attempts, cleanup_available_at, cleanup_lease_owner,
  cleanup_lease_expires_at, cleanup_lease_generation, cleanup_completed_at,
  cleanup_last_error_code, updated_at
) on private.website_authentication_checkpoints to page2webmcp_worker;

alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901071658;
revoke all on function private.selected_release_readiness_topology_legacy_20260901071658(text)
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
      ('20260901090842')
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
  ), cleanup_schema as (
    select count(*) = 9 as verified
    from information_schema.columns column_row
    where column_row.table_schema = 'private'
      and column_row.table_name = 'website_authentication_checkpoints'
      and column_row.column_name in (
        'cleanup_status', 'cleanup_idempotency_key', 'cleanup_attempts', 'cleanup_available_at',
        'cleanup_lease_owner', 'cleanup_lease_expires_at', 'cleanup_lease_generation',
        'cleanup_completed_at', 'cleanup_last_error_code'
      )
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901071658(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and coalesce((select verified from cleanup_schema), false),
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
