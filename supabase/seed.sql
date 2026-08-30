-- Deterministic local fixture identities. Authentication itself is handled by
-- an explicit hermetic Supabase Auth adapter; these rows satisfy durable
-- membership and audit foreign keys after every `supabase db reset`.
insert into auth.users (id, email, email_confirmed_at) values
  ('11111111-1111-1111-1111-111111111111', 'owner@page2webmcp.local', now()),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@page2webmcp.local', now()),
  ('33333333-3333-3333-3333-333333333333', 'editor@page2webmcp.local', now()),
  ('44444444-4444-4444-4444-444444444444', 'viewer@page2webmcp.local', now())
on conflict (id) do nothing;

insert into public.organizations (id, name) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Acme fixture organization'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Isolation fixture organization')
on conflict (id) do nothing;

insert into public.memberships (organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'editor'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 'viewer')
on conflict (organization_id, user_id) do update set role = excluded.role;
