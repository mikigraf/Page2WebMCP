begin;

insert into public.projects (id, organization_id, created_by, name, source_type, source_url, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   '11111111-1111-1111-1111-111111111111', 'Project A', 'website', 'https://acme.example', 'created'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   '22222222-2222-2222-2222-222222222222', 'Project B', 'website', 'https://acme-b.example', 'created');

insert into public.analysis_runs (id, organization_id, project_id, requested_by, status, attempts) values
  ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'succeeded', 1),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'succeeded', 1);

insert into public.capabilities (
  id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, version
) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004',
   'read-project-a', 'R0', 'verified', 1),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000004',
   'read-project-b', 'R0', 'verified', 1);

-- Equal artifact bytes may be attributed to distinct tenant/run releases.
insert into public.releases (
  id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash, code,
  allowed_origin, manifest, sri, status
) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', repeat('1', 64),
   repeat('a', 64), 'export {};', 'https://acme.example', '{}', 'sha256-shared', 'published'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000004', repeat('1', 64),
   repeat('a', 64), 'export {};', 'https://acme-b.example', '{}', 'sha256-shared', 'published');

do $schema_test$
begin
  if not (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in (
    'public.organizations'::regclass,
    'public.memberships'::regclass,
    'public.projects'::regclass,
    'public.analysis_runs'::regclass,
    'public.analysis_evidence'::regclass,
    'public.capabilities'::regclass,
    'public.capability_reviews'::regclass,
    'public.verification_runs'::regclass,
    'public.releases'::regclass,
    'public.audit_events'::regclass,
    'private.analysis_jobs'::regclass,
    'private.idempotency_keys'::regclass,
    'private.app_sessions'::regclass
  )) then
    raise exception 'RLS and FORCE RLS are required on every lifecycle table';
  end if;

  if exists (
    select 1 from pg_roles
    where rolname in ('page2webmcp_app', 'page2webmcp_worker')
      and (rolsuper or rolbypassrls or rolcanlogin or rolinherit)
  ) then
    raise exception 'internal runtime roles must be NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS';
  end if;

  if has_schema_privilege('page2webmcp_app', 'public', 'create')
    or has_schema_privilege('page2webmcp_worker', 'public', 'create') then
    raise exception 'internal runtime roles can create objects in the public schema';
  end if;

  if has_table_privilege('page2webmcp_worker', 'public.projects', 'select')
    or has_table_privilege('page2webmcp_worker', 'public.projects', 'update')
    or has_table_privilege('page2webmcp_worker', 'public.analysis_evidence', 'select')
    or has_table_privilege('page2webmcp_worker', 'public.capabilities', 'select') then
    raise exception 'worker role has unused public-table privileges';
  end if;

  if has_column_privilege('page2webmcp_worker', 'private.analysis_jobs', 'source_type', 'update')
    or has_column_privilege('page2webmcp_worker', 'private.analysis_jobs', 'source_url', 'update') then
    raise exception 'worker role can mutate immutable queue source snapshots';
  end if;

  if has_column_privilege('page2webmcp_app', 'public.analysis_runs', 'release_code', 'update')
    or has_column_privilege('page2webmcp_app', 'public.analysis_runs', 'release_hash', 'update')
    or has_column_privilege('page2webmcp_app', 'public.analysis_runs', 'allowed_origin', 'update')
    or has_column_privilege('page2webmcp_app', 'public.analysis_runs', 'release_manifest', 'update') then
    raise exception 'application role can mutate immutable worker source artifacts';
  end if;

  if not exists (
      select 1
      from pg_proc as procedure
      join pg_namespace as namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'private'
        and procedure.proname = 'lock_release_analysis_run'
        and procedure.prosecdef
        and 'search_path=pg_catalog, pg_temp' = any (procedure.proconfig)
    ) then
    raise exception 'release analysis lock is not security-definer with a fixed safe search path';
  end if;
  if not has_function_privilege(
      'page2webmcp_app', 'private.lock_release_analysis_run(uuid,uuid,uuid)', 'execute'
    ) or has_function_privilege(
      'page2webmcp_worker', 'private.lock_release_analysis_run(uuid,uuid,uuid)', 'execute'
    ) or has_function_privilege(
      'page2webmcp_maintenance', 'private.lock_release_analysis_run(uuid,uuid,uuid)', 'execute'
    ) or has_function_privilege(
      'authenticated', 'private.lock_release_analysis_run(uuid,uuid,uuid)', 'execute'
    ) then
    raise exception 'release analysis locking is not restricted to the application role';
  end if;

  if has_table_privilege('authenticated', 'public.projects', 'insert')
    or has_table_privilege('authenticated', 'public.projects', 'update')
    or has_table_privilege('authenticated', 'public.analysis_runs', 'insert')
    or has_table_privilege('authenticated', 'public.capability_reviews', 'insert') then
    raise exception 'the public Data API can bypass server lifecycle invariants';
  end if;
end
$schema_test$;

do $tenant_read_test$
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  execute 'set local role authenticated';
  if (select count(*) from public.organizations) <> 1
    or (select count(*) from public.memberships) <> 1
    or (select count(*) from public.projects) <> 1
    or (select count(*) from public.capabilities) <> 1
    or (select count(*) from public.releases) <> 1 then
    raise exception 'organization A member can read outside their tenant';
  end if;

  begin
    insert into public.projects (id, organization_id, created_by, name, source_type, source_url, status)
    values ('aaaaaaaa-0000-0000-0000-000000000099', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '11111111-1111-1111-1111-111111111111', 'Data API bypass', 'website',
            'https://acme.example', 'created');
    raise exception 'authenticated Data API role can mutate projects';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from private.analysis_jobs;
    raise exception 'authenticated Data API role can read the private queue';
  exception
    when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  if (select count(*) from public.projects) <> 1
    or exists (select 1 from public.projects where organization_id <> 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') then
    raise exception 'organization B member can read organization A';
  end if;

  execute 'reset role';
  execute 'set local role anon';
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform count(*) from public.projects;
    raise exception 'anonymous role can read tenant projects';
  exception
    when insufficient_privilege then null;
  end;
  execute 'reset role';
end
$tenant_read_test$;

do $integrity_test$
declare
  active_run_id uuid := 'aaaaaaaa-0000-0000-0000-000000000010';
  ungated_run_id uuid := 'aaaaaaaa-0000-0000-0000-000000000020';
  editor_updated_rows bigint;
  worker_updated_rows bigint;
begin
  begin
    insert into public.analysis_runs (id, organization_id, project_id, requested_by, status, attempts)
    values ('bbbbbbbb-0000-0000-0000-000000000090', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            'aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'failed', 0);
    raise exception 'cross-tenant project/run reference was accepted';
  exception
    when foreign_key_violation then null;
  end;

  insert into public.analysis_runs (id, organization_id, project_id, requested_by, status, attempts,
                                    release_code, release_hash, allowed_origin, release_manifest)
  values (ungated_run_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
          'succeeded', 1, 'export {};', repeat('a', 64), 'https://acme.example', '{}');
  perform set_config('page2webmcp.organization_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
  perform set_config('page2webmcp.actor_id', '11111111-1111-1111-1111-111111111111', true);
  execute 'set local role page2webmcp_app';
  begin
    insert into public.releases (
      id, organization_id, project_id, analysis_run_id, capability_state_digest, content_hash,
      code, allowed_origin, manifest, sri, status
    ) values (
      'aaaaaaaa-0000-0000-0000-000000000021', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'aaaaaaaa-0000-0000-0000-000000000001', ungated_run_id, repeat('1', 64), repeat('b', 64),
      'export {};', 'https://acme.example', '{}', 'sha256-ungated', 'published'
    );
    raise exception 'app role published without an eligible exact-run verification';
  exception
    when insufficient_privilege then null;
  end;
  execute 'reset role';

  insert into public.capabilities (
    id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, version
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000022', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004',
    'owner-only-mutation', 'R1', 'proposed', 1
  );
  perform set_config('page2webmcp.organization_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
  perform set_config('page2webmcp.actor_id', '33333333-3333-3333-3333-333333333333', true);
  execute 'set local role page2webmcp_app';
  begin
    update public.capabilities
    set status = 'reviewed', version = version + 1
    where id = 'aaaaaaaa-0000-0000-0000-000000000022';
    get diagnostics editor_updated_rows = row_count;
    if editor_updated_rows <> 0 then
      raise exception 'editor directly approved an owner-only R1 capability';
    end if;
  exception
    when insufficient_privilege then null;
  end;
  execute 'reset role';
  if (select status from public.capabilities where id = 'aaaaaaaa-0000-0000-0000-000000000022') <> 'proposed' then
    raise exception 'editor changed an owner-only R1 capability';
  end if;

  execute 'set local role page2webmcp_worker';
  update public.analysis_runs
  set release_code = 'tampered after completion'
  where id = 'aaaaaaaa-0000-0000-0000-000000000004';
  get diagnostics worker_updated_rows = row_count;
  execute 'reset role';
  if worker_updated_rows <> 0 then
    raise exception 'worker mutated source bytes after analysis completion';
  end if;

  insert into public.analysis_runs (id, organization_id, project_id, requested_by, status, attempts)
  values (active_run_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'queued', 0);
  begin
    insert into public.analysis_runs (id, organization_id, project_id, requested_by, status, attempts)
    values ('aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            'aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'running', 0);
    raise exception 'more than one active run was accepted for a project';
  exception
    when unique_violation then null;
  end;

  insert into private.analysis_jobs (analysis_run_id, organization_id, source_type, source_url) values
    (active_run_id, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'website', 'https://acme.example');
  if (select status from public.projects where id = 'aaaaaaaa-0000-0000-0000-000000000001') <> 'analyzing' then
    raise exception 'queue/public lifecycle state did not synchronize';
  end if;
end
$integrity_test$;

rollback;
