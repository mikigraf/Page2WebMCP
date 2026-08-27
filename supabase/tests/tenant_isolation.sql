begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

-- The pgTAP runner owns this setup transaction. It bypasses RLS while creating
-- fixtures; all assertions below run as the API's authenticated role.
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

select ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.organizations'::regclass,
  'public.memberships'::regclass,
  'public.projects'::regclass,
  'public.capabilities'::regclass,
  'public.releases'::regclass
)), 'RLS is enabled on every tenant table');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select is((select count(*) from public.organizations), 1::bigint, 'owner A reads only organization A');
select is((select count(*) from public.memberships), 1::bigint, 'owner A reads only their membership');
select is((select count(*) from public.projects), 1::bigint, 'owner A reads only project A');
select is((select count(*) from public.capabilities), 1::bigint, 'owner A reads only capability A');
select is((select count(*) from public.releases), 1::bigint, 'owner A reads only release A');

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select is((select count(*) from public.organizations), 1::bigint, 'viewer B cannot read organization A');
select is((select count(*) from public.releases), 0::bigint, 'viewer B cannot read or publish releases');

set local role anon;
reset request.jwt.claim.sub;

select throws_ok('select count(*) from public.projects', '42501', null, 'anonymous users cannot read projects');

select * from finish();
rollback;
