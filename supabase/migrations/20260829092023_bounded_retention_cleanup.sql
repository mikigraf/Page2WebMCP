begin;

-- Retention is an operational concern, not an application or queue-worker
-- capability. Deployments grant this NOLOGIN role to one scheduler login.
do $$
begin
  create role page2webmcp_maintenance
    nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception
  when duplicate_object then null;
end
$$;

alter role page2webmcp_maintenance
  nologin noinherit nocreatedb nocreaterole;

-- A tenant migration role cannot safely rewrite SUPERUSER, REPLICATION, or
-- BYPASSRLS on an existing role. Prove their safe catalog state instead, and
-- also fail if any expected application role is missing.
do $$
begin
  if exists (
    select 1
    from (values
      ('page2webmcp_app'),
      ('page2webmcp_worker'),
      ('page2webmcp_maintenance')
    ) as expected_role(rolname)
    left join pg_catalog.pg_roles as role_state
      on role_state.rolname = expected_role.rolname
    where role_state.oid is null
      or role_state.rolcanlogin
      or role_state.rolinherit
      or role_state.rolsuper
      or role_state.rolcreatedb
      or role_state.rolcreaterole
      or role_state.rolreplication
      or role_state.rolbypassrls
  ) then
    raise exception 'page2webmcp application role posture is unsafe'
      using errcode = '42501';
  end if;
end
$$;

-- One call can delete at most max_rows rows in total. The budget is split
-- across the four retention classes so a continuously busy class cannot
-- starve the others. SKIP LOCKED makes overlapping scheduler calls safe.
create function private.purge_expired_data(max_rows integer default 1000)
returns table (
  analysis_evidence_deleted bigint,
  audit_events_deleted bigint,
  idempotency_keys_deleted bigint,
  app_sessions_deleted bigint,
  rows_deleted bigint
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  cutoff_at timestamptz := pg_catalog.statement_timestamp();
  rows_per_class integer;
  remaining_rows integer;
  evidence_limit integer;
  audit_limit integer;
  idempotency_limit integer;
  session_limit integer;
begin
  if max_rows is null or max_rows < 4 or max_rows > 1000 then
    raise exception 'max_rows must be between 4 and 1000'
      using errcode = '22023';
  end if;

  rows_per_class := max_rows / 4;
  remaining_rows := max_rows % 4;
  evidence_limit := rows_per_class + case when remaining_rows >= 1 then 1 else 0 end;
  audit_limit := rows_per_class + case when remaining_rows >= 2 then 1 else 0 end;
  idempotency_limit := rows_per_class + case when remaining_rows >= 3 then 1 else 0 end;
  session_limit := rows_per_class;

  with expired as (
    select evidence.id
    from public.analysis_evidence as evidence
    where evidence.expires_at <= cutoff_at
    order by evidence.expires_at, evidence.id
    for update skip locked
    limit evidence_limit
  )
  delete from public.analysis_evidence as evidence
  using expired
  where evidence.id = expired.id;
  get diagnostics analysis_evidence_deleted = row_count;

  with expired as (
    select event.id
    from public.audit_events as event
    where event.expires_at <= cutoff_at
    order by event.expires_at, event.id
    for update skip locked
    limit audit_limit
  )
  delete from public.audit_events as event
  using expired
  where event.id = expired.id;
  get diagnostics audit_events_deleted = row_count;

  with expired as (
    select key.organization_id, key.actor_id, key.operation, key.idempotency_key
    from private.idempotency_keys as key
    where key.expires_at <= cutoff_at
    order by key.expires_at, key.organization_id, key.actor_id, key.operation, key.idempotency_key
    for update skip locked
    limit idempotency_limit
  )
  delete from private.idempotency_keys as key
  using expired
  where key.organization_id = expired.organization_id
    and key.actor_id = expired.actor_id
    and key.operation = expired.operation
    and key.idempotency_key = expired.idempotency_key;
  get diagnostics idempotency_keys_deleted = row_count;

  with expired as (
    select session.id
    from private.app_sessions as session
    where session.expires_at <= cutoff_at
    order by session.expires_at, session.id
    for update skip locked
    limit session_limit
  )
  delete from private.app_sessions as session
  using expired
  where session.id = expired.id;
  get diagnostics app_sessions_deleted = row_count;

  rows_deleted := analysis_evidence_deleted + audit_events_deleted
    + idempotency_keys_deleted + app_sessions_deleted;
  return next;
end
$$;

-- Publication calls this inside its existing application transaction. The row
-- lock is held until release insertion commits and conflicts with retention's
-- FOR UPDATE, so cleanup either happens before the gate or skips the evidence.
create function private.lock_current_analysis_evidence(
  target_organization_id uuid,
  target_project_id uuid,
  target_analysis_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  evidence_found boolean := false;
begin
  if target_organization_id is distinct from private.context_organization_id()
    or not private.context_member(target_organization_id, array['owner']) then
    raise exception 'current actor cannot lock analysis evidence'
      using errcode = '42501';
  end if;

  select true
  into evidence_found
  from public.analysis_evidence as evidence
  where evidence.organization_id = target_organization_id
    and evidence.project_id = target_project_id
    and evidence.analysis_run_id = target_analysis_run_id
    and evidence.expires_at > pg_catalog.statement_timestamp()
  order by evidence.expires_at, evidence.id
  for key share
  limit 1;

  return coalesce(evidence_found, false);
end
$$;

revoke all on function private.purge_expired_data(integer) from public;
revoke all on function private.purge_expired_data(integer)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
revoke all on function private.lock_current_analysis_evidence(uuid, uuid, uuid) from public;
revoke all on function private.lock_current_analysis_evidence(uuid, uuid, uuid)
  from anon, authenticated, page2webmcp_worker, page2webmcp_maintenance;
revoke all on schema private from page2webmcp_maintenance;
revoke all on public.analysis_evidence, public.audit_events,
  private.idempotency_keys, private.app_sessions from page2webmcp_maintenance;
grant usage on schema private to page2webmcp_maintenance;
grant execute on function private.purge_expired_data(integer) to page2webmcp_maintenance;
grant execute on function private.lock_current_analysis_evidence(uuid, uuid, uuid)
  to page2webmcp_app;

commit;
