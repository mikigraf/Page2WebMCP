begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'viewer-b@example.test');

insert into public.organizations (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Organization A'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Organization B');

insert into public.memberships (organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'viewer');

insert into public.projects (id, organization_id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Project A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Project B');

insert into public.capabilities (id, project_id, stable_name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'read-project-a', 'verified'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', 'read-project-b', 'verified');

insert into public.releases (id, project_id, content_hash, status) values
  ('aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'hash-a', 'published'),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'hash-b', 'published');

do $rls_test$
begin
  if not (select bool_and(relrowsecurity) from pg_class where oid in (
    'public.organizations'::regclass,
    'public.memberships'::regclass,
    'public.projects'::regclass,
    'public.capabilities'::regclass,
    'public.releases'::regclass
  )) then
    raise exception 'RLS is not enabled on every tenant table';
  end if;

  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  execute 'set local role authenticated';

  if (select count(*) from public.organizations) <> 1
    or (select count(*) from public.memberships) <> 1
    or (select count(*) from public.projects) <> 1
    or (select count(*) from public.capabilities) <> 1
    or (select count(*) from public.releases) <> 1 then
    raise exception 'owner A can read data outside organization A';
  end if;

  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  if (select count(*) from public.organizations) <> 1
    or (select count(*) from public.releases) <> 0 then
    raise exception 'viewer B has unauthorized cross-tenant or release access';
  end if;

  execute 'reset role';
  execute 'set local role anon';
  perform set_config('request.jwt.claim.sub', '', true);

  begin
    perform count(*) from public.projects;
    raise exception 'anonymous users can read tenant projects';
  exception
    when insufficient_privilege then null;
  end;
end;
$rls_test$;

rollback;
