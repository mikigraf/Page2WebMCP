begin;

insert into public.projects (
  id, organization_id, created_by, name, source_type, source_url, status
) values
  ('aaaaaaaa-0000-0000-0000-000000000031', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'Retention A', 'website',
   'https://acme.example', 'analyzed'),
  ('bbbbbbbb-0000-0000-0000-000000000031', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222', 'Retention B', 'website',
   'https://acme-b.example', 'analyzed');

insert into public.analysis_runs (
  id, organization_id, project_id, requested_by, status, attempts
) values
  ('aaaaaaaa-0000-0000-0000-000000000032', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-0000-0000-0000-000000000031', '11111111-1111-1111-1111-111111111111',
   'succeeded', 1),
  ('bbbbbbbb-0000-0000-0000-000000000032', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000031', '22222222-2222-2222-2222-222222222222',
   'succeeded', 1);

insert into public.analysis_evidence (
  id, organization_id, project_id, analysis_run_id, source, payload, expires_at
) values
  ('aaaaaaaa-0000-0000-0000-000000000041', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-0000-0000-0000-000000000031', 'aaaaaaaa-0000-0000-0000-000000000032',
   'runtime', '{"state":"expired-a"}', now() - interval '2 days'),
  ('bbbbbbbb-0000-0000-0000-000000000041', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000031', 'bbbbbbbb-0000-0000-0000-000000000032',
   'runtime', '{"state":"expired-b"}', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000000042', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-0000-0000-0000-000000000031', 'aaaaaaaa-0000-0000-0000-000000000032',
   'runtime', '{"state":"active-a"}', now() + interval '1 day'),
  ('bbbbbbbb-0000-0000-0000-000000000042', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000031', 'bbbbbbbb-0000-0000-0000-000000000032',
   'runtime', '{"state":"active-b"}', now() + interval '1 day');

insert into public.audit_events (
  id, organization_id, actor_id, action, target_id, metadata, expires_at
) values
  ('aaaaaaaa-0000-0000-0000-000000000051', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'retention.expired-a',
   'aaaaaaaa-0000-0000-0000-000000000031', '{}', now() - interval '2 days'),
  ('bbbbbbbb-0000-0000-0000-000000000051', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222', 'retention.expired-b',
   'bbbbbbbb-0000-0000-0000-000000000031', '{}', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000000052', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'retention.active-a',
   'aaaaaaaa-0000-0000-0000-000000000031', '{}', now() + interval '1 day'),
  ('bbbbbbbb-0000-0000-0000-000000000052', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222', 'retention.active-b',
   'bbbbbbbb-0000-0000-0000-000000000031', '{}', now() + interval '1 day');

insert into private.idempotency_keys (
  actor_id, organization_id, operation, idempotency_key, input_hash, result_id, expires_at
) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'project', 'retention-expired-a', repeat('a', 64), null, now() - interval '2 days'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'project', 'retention-expired-b', repeat('b', 64), null, now() - interval '1 day'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'project', 'retention-active-a', repeat('c', 64), null, now() + interval '1 day'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'project', 'retention-active-b', repeat('d', 64), null, now() + interval '1 day');

insert into private.app_sessions (
  id, actor_id, organization_id, role, expires_at, revoked_at
) values
  ('aaaaaaaa-0000-0000-0000-000000000061', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', now() - interval '2 days', null),
  ('bbbbbbbb-0000-0000-0000-000000000061', '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', now() - interval '1 day', null),
  ('aaaaaaaa-0000-0000-0000-000000000062', '11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', now() + interval '1 day', null),
  ('bbbbbbbb-0000-0000-0000-000000000062', '22222222-2222-2222-2222-222222222222',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', now() + interval '1 day', now());

do $retention_test$
declare
  evidence_deleted bigint;
  audits_deleted bigint;
  idempotency_deleted bigint;
  sessions_deleted bigint;
  total_deleted bigint;
begin
  if exists (
      select 1
      from pg_roles
      where rolname = 'page2webmcp_maintenance'
        and (rolsuper or rolbypassrls or rolcanlogin or rolinherit)
    ) then
    raise exception 'maintenance role is not a least-privileged NOLOGIN role';
  end if;
  if has_schema_privilege('page2webmcp_maintenance', 'private', 'create')
    or has_schema_privilege('page2webmcp_maintenance', 'public', 'create') then
    raise exception 'maintenance role can create database objects';
  end if;
  if not exists (
      select 1
      from pg_proc as procedure
      join pg_namespace as namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'private'
        and procedure.proname = 'purge_expired_data'
        and procedure.prosecdef
        and 'search_path=pg_catalog, pg_temp' = any (procedure.proconfig)
    ) then
    raise exception 'retention function is not security-definer with a fixed safe search path';
  end if;
  if not exists (
      select 1
      from pg_proc as procedure
      join pg_namespace as namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'private'
        and procedure.proname = 'lock_current_analysis_evidence'
        and procedure.prosecdef
        and 'search_path=pg_catalog, pg_temp' = any (procedure.proconfig)
    ) then
    raise exception 'publication evidence lock is not security-definer with a fixed safe search path';
  end if;
  if not has_function_privilege(
      'page2webmcp_maintenance', 'private.purge_expired_data(integer)', 'execute'
    ) then
    raise exception 'maintenance role cannot execute the retention function';
  end if;
  if has_function_privilege(
      'page2webmcp_app', 'private.purge_expired_data(integer)', 'execute'
    ) or has_function_privilege(
      'page2webmcp_worker', 'private.purge_expired_data(integer)', 'execute'
    ) or has_function_privilege(
      'authenticated', 'private.purge_expired_data(integer)', 'execute'
    ) or has_function_privilege(
      'anon', 'private.purge_expired_data(integer)', 'execute'
    ) then
    raise exception 'a runtime or Data API role can execute privileged retention';
  end if;
  if not has_function_privilege(
      'page2webmcp_app',
      'private.lock_current_analysis_evidence(uuid,uuid,uuid)',
      'execute'
    ) or has_function_privilege(
      'page2webmcp_worker',
      'private.lock_current_analysis_evidence(uuid,uuid,uuid)',
      'execute'
    ) or has_function_privilege(
      'page2webmcp_maintenance',
      'private.lock_current_analysis_evidence(uuid,uuid,uuid)',
      'execute'
    ) or has_function_privilege(
      'authenticated',
      'private.lock_current_analysis_evidence(uuid,uuid,uuid)',
      'execute'
    ) then
    raise exception 'publication evidence locking is not restricted to the application role';
  end if;
  if exists (
      select 1
      from (values
        ('public.analysis_evidence'),
        ('public.audit_events'),
        ('private.idempotency_keys'),
        ('private.app_sessions')
      ) as target(table_name)
      cross join (values ('select'), ('insert'), ('update'), ('delete')) as access(privilege)
      where has_table_privilege(
        'page2webmcp_maintenance', target.table_name, access.privilege
      )
    ) then
    raise exception 'maintenance role has direct retention-table privileges';
  end if;

  perform set_config('page2webmcp.organization_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
  perform set_config('page2webmcp.actor_id', '11111111-1111-1111-1111-111111111111', true);
  execute 'set local role page2webmcp_app';
  begin
    perform private.lock_current_analysis_evidence(
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'bbbbbbbb-0000-0000-0000-000000000031',
      'bbbbbbbb-0000-0000-0000-000000000032'
    );
    raise exception 'application role locked evidence outside its tenant';
  exception
    when insufficient_privilege then null;
  end;
  execute 'reset role';

  begin
    perform * from private.purge_expired_data(1001);
    raise exception 'retention function accepted a batch above its hard cap';
  exception
    when invalid_parameter_value then null;
  end;

  execute 'set local role page2webmcp_maintenance';
  select analysis_evidence_deleted, audit_events_deleted, idempotency_keys_deleted,
         app_sessions_deleted, rows_deleted
  into evidence_deleted, audits_deleted, idempotency_deleted, sessions_deleted, total_deleted
  from private.purge_expired_data(4);
  execute 'reset role';

  if (evidence_deleted, audits_deleted, idempotency_deleted, sessions_deleted, total_deleted)
      <> (1::bigint, 1::bigint, 1::bigint, 1::bigint, 4::bigint) then
    raise exception 'first retention call was not globally bounded and fairly partitioned';
  end if;
  if exists (
      select 1 from public.analysis_evidence
      where id = 'aaaaaaaa-0000-0000-0000-000000000041'
    ) or exists (
      select 1 from public.audit_events
      where id = 'aaaaaaaa-0000-0000-0000-000000000051'
    ) or exists (
      select 1 from private.idempotency_keys
      where idempotency_key = 'retention-expired-a'
    ) or exists (
      select 1 from private.app_sessions
      where id = 'aaaaaaaa-0000-0000-0000-000000000061'
    ) then
    raise exception 'oldest expired tenant rows survived the first retention call';
  end if;
  if not exists (
      select 1 from public.analysis_evidence
      where id = 'bbbbbbbb-0000-0000-0000-000000000041'
    ) or not exists (
      select 1 from public.audit_events
      where id = 'bbbbbbbb-0000-0000-0000-000000000051'
    ) or not exists (
      select 1 from private.idempotency_keys
      where idempotency_key = 'retention-expired-b'
    ) or not exists (
      select 1 from private.app_sessions
      where id = 'bbbbbbbb-0000-0000-0000-000000000061'
    ) then
    raise exception 'the first retention call exceeded its per-class share';
  end if;

  execute 'set local role page2webmcp_maintenance';
  select analysis_evidence_deleted, audit_events_deleted, idempotency_keys_deleted,
         app_sessions_deleted, rows_deleted
  into evidence_deleted, audits_deleted, idempotency_deleted, sessions_deleted, total_deleted
  from private.purge_expired_data(4);
  execute 'reset role';

  if (evidence_deleted, audits_deleted, idempotency_deleted, sessions_deleted, total_deleted)
      <> (1::bigint, 1::bigint, 1::bigint, 1::bigint, 4::bigint) then
    raise exception 'second retention call did not remove the remaining expired tenant rows';
  end if;
  if exists (select 1 from public.analysis_evidence where expires_at <= now())
    or exists (select 1 from public.audit_events where expires_at <= now())
    or exists (select 1 from private.idempotency_keys where expires_at <= now())
    or exists (select 1 from private.app_sessions where expires_at <= now()) then
    raise exception 'expired retention fixtures survived cleanup';
  end if;
  if (select count(*) from public.analysis_evidence where id in (
      'aaaaaaaa-0000-0000-0000-000000000042',
      'bbbbbbbb-0000-0000-0000-000000000042'
    )) <> 2
    or (select count(*) from public.audit_events where id in (
      'aaaaaaaa-0000-0000-0000-000000000052',
      'bbbbbbbb-0000-0000-0000-000000000052'
    )) <> 2
    or (select count(*) from private.idempotency_keys where idempotency_key in (
      'retention-active-a', 'retention-active-b'
    )) <> 2
    or (select count(*) from private.app_sessions where id in (
      'aaaaaaaa-0000-0000-0000-000000000062',
      'bbbbbbbb-0000-0000-0000-000000000062'
    )) <> 2 then
    raise exception 'retention removed unexpired tenant state';
  end if;
  if not exists (
      select 1 from private.app_sessions
      where id = 'bbbbbbbb-0000-0000-0000-000000000062'
        and revoked_at is not null
    ) then
    raise exception 'retention removed a revoked session before its expiry boundary';
  end if;
  if (select count(*) from public.projects where id in (
      'aaaaaaaa-0000-0000-0000-000000000031',
      'bbbbbbbb-0000-0000-0000-000000000031'
    )) <> 2
    or (select count(*) from public.analysis_runs where id in (
      'aaaaaaaa-0000-0000-0000-000000000032',
      'bbbbbbbb-0000-0000-0000-000000000032'
    )) <> 2 then
    raise exception 'retention mutated parent workflow state';
  end if;
end
$retention_test$;

rollback;
