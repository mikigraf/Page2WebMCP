begin;

create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@page2webmcp.local'),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@page2webmcp.local'),
  ('33333333-3333-3333-3333-333333333333', 'editor@page2webmcp.local')
on conflict (id) do nothing;
insert into public.organizations (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Organization A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Organization B')
on conflict (id) do nothing;
insert into public.memberships (organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'editor')
on conflict (organization_id, user_id) do update set role = excluded.role;

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
   'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004', 'read-a', 'R0', 'verified', 1),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
   'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000004', 'read-b', 'R0', 'verified', 1);
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

select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in (
  'public.organizations'::regclass, 'public.memberships'::regclass, 'public.projects'::regclass,
  'public.analysis_runs'::regclass, 'public.analysis_evidence'::regclass, 'public.capabilities'::regclass,
  'public.capability_reviews'::regclass, 'public.verification_runs'::regclass, 'public.releases'::regclass,
  'public.audit_events'::regclass, 'private.analysis_jobs'::regclass,
  'private.idempotency_keys'::regclass, 'private.app_sessions'::regclass
)), 'RLS and FORCE RLS cover public and private lifecycle tables');

select is((select count(*) from pg_roles where rolname in ('page2webmcp_app', 'page2webmcp_worker')
  and not rolsuper and not rolbypassrls and not rolcanlogin and not rolinherit), 2::bigint,
  'internal roles are non-login, non-inheriting, and cannot bypass RLS');
select ok(not has_schema_privilege('page2webmcp_app', 'public', 'create')
  and not has_schema_privilege('page2webmcp_worker', 'public', 'create'),
  'internal roles cannot create objects in the public schema');
select ok(not has_table_privilege('page2webmcp_worker', 'public.projects', 'select')
  and not has_table_privilege('page2webmcp_worker', 'public.projects', 'update')
  and not has_table_privilege('page2webmcp_worker', 'public.analysis_evidence', 'select')
  and not has_table_privilege('page2webmcp_worker', 'public.capabilities', 'select'),
  'worker role has only the public-table privileges used by queue processing');
select ok(not has_column_privilege('page2webmcp_worker', 'private.analysis_jobs', 'source_type', 'update')
  and not has_column_privilege('page2webmcp_worker', 'private.analysis_jobs', 'source_url', 'update'),
  'worker role cannot mutate immutable queue source snapshots');
select ok(not has_table_privilege('authenticated', 'public.projects', 'insert')
  and not has_table_privilege('authenticated', 'public.analysis_runs', 'insert')
  and not has_table_privilege('authenticated', 'public.capability_reviews', 'insert'),
  'Data API lifecycle writes are revoked');
select is((select count(*) from public.releases where content_hash = repeat('a', 64)), 2::bigint,
  'content hashes identify bytes without collapsing run attribution');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from public.projects), 1::bigint, 'member reads only their organization project');
select is((select count(*) from public.capabilities), 1::bigint, 'member reads only their organization capability');
select is((select count(*) from public.releases), 1::bigint, 'member reads only their organization release');
select throws_ok(
  $$insert into public.projects (id, organization_id, created_by, name, source_type, source_url, status)
    values ('aaaaaaaa-0000-0000-0000-000000000099', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111', 'Bypass', 'website', 'https://acme.example', 'created')$$,
  '42501', null, 'authenticated Data API role cannot mutate projects');
select throws_ok('select count(*) from private.analysis_jobs', '42501', null,
  'authenticated Data API role cannot read the worker queue');

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select is((select count(*) from public.projects where organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0::bigint, 'cross-tenant project rows are invisible');

reset role;
insert into public.capabilities (
  id, organization_id, project_id, analysis_run_id, stable_name, risk_tier, status, version
) values (
  'aaaaaaaa-0000-0000-0000-000000000022', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000004',
  'owner-only-mutation', 'R1', 'proposed', 1
);
set local page2webmcp.organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local page2webmcp.actor_id = '33333333-3333-3333-3333-333333333333';
set local role page2webmcp_app;
do $editor_review$
begin
  update public.capabilities
  set status = 'reviewed', version = version + 1
  where id = 'aaaaaaaa-0000-0000-0000-000000000022';
exception
  when insufficient_privilege then null;
end
$editor_review$;
reset role;
select is((select status from public.capabilities where id = 'aaaaaaaa-0000-0000-0000-000000000022'),
  'proposed', 'editors cannot directly approve owner-only R1 capabilities');

select * from finish();
rollback;
