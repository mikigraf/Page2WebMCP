-- Supabase Auth identities remain separate from application authorization.
-- Personal workspaces are convergent and all roles continue to come from the
-- membership row, never JWT/user metadata.
alter table public.organizations
  add column personal_owner_user_id uuid references auth.users(id);

with eligible as (
  select m.organization_id, min(m.user_id::text)::uuid as user_id
  from public.memberships m
  join auth.users auth_user
    on auth_user.id = m.user_id
    and auth_user.email_confirmed_at is not null
  where m.role = 'owner'
  group by m.organization_id
  having count(*) = 1
), unique_owner as (
  select e.organization_id, e.user_id
  from eligible e
  where 1 = (
    select count(*)
    from eligible other
    where other.user_id = e.user_id
  )
)
update public.organizations organization
set personal_owner_user_id = unique_owner.user_id
from unique_owner
where unique_owner.organization_id = organization.id
  and organization.personal_owner_user_id is null;

create unique index organizations_personal_owner_user_id_key
  on public.organizations (personal_owner_user_id)
  where personal_owner_user_id is not null;

alter table public.organizations enable row level security;
alter table public.organizations force row level security;
alter table public.memberships enable row level security;
alter table public.memberships force row level security;

drop policy if exists "owners update organizations" on public.organizations;
create policy "owners update organizations"
on public.organizations for update to authenticated
using (
  exists (
    select 1 from public.memberships membership
    where membership.organization_id = organizations.id
      and membership.user_id = (select auth.uid())
      and membership.role = 'owner'
  )
)
with check (
  exists (
    select 1 from public.memberships membership
    where membership.organization_id = organizations.id
      and membership.user_id = (select auth.uid())
      and membership.role = 'owner'
  )
);

create or replace function private.provision_personal_organization(
  requested_user_id uuid,
  requested_email text
)
returns table (organization_id uuid, user_id uuid, role text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
#variable_conflict use_column
declare
  target_organization_id uuid;
  target_name text;
begin
  if private.context_access() <> 'identity'
    or private.context_actor_id() is distinct from requested_user_id then
    raise exception 'authenticated identity context required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = requested_user_id
      and auth_user.email_confirmed_at is not null
      and (requested_email is null or lower(auth_user.email) = lower(requested_email))
  ) then
    raise exception 'verified auth identity required' using errcode = '42501';
  end if;

  target_name := left(
    coalesce(nullif(regexp_replace(split_part(coalesce(requested_email, ''), '@', 1), '[^[:alnum:] _.-]', '', 'g'), ''), 'Personal')
      || '''s workspace',
    120
  );
  insert into public.organizations (id, name, personal_owner_user_id)
  values (gen_random_uuid(), target_name, requested_user_id)
  on conflict (personal_owner_user_id) where personal_owner_user_id is not null
  do update set personal_owner_user_id = excluded.personal_owner_user_id
  returning id into target_organization_id;

  insert into public.memberships (organization_id, user_id, role)
  values (target_organization_id, requested_user_id, 'owner')
  on conflict (organization_id, user_id)
  do update set role = 'owner';

  return query select target_organization_id, requested_user_id, 'owner'::text;
end
$$;

create or replace function private.resolve_identity_membership(
  requested_user_id uuid,
  requested_organization_id uuid default null,
  requested_session_id uuid default null
)
returns table (organization_id uuid, user_id uuid, role text)
language plpgsql
security definer
stable
set search_path = pg_catalog
as $$
#variable_conflict use_column
begin
  if private.context_access() <> 'identity'
    or private.context_actor_id() is distinct from requested_user_id then
    raise exception 'authenticated identity context required' using errcode = '42501';
  end if;
  if requested_session_id is null or not exists (
    select 1
    from auth.sessions auth_session
    where auth_session.id = requested_session_id
      and auth_session.user_id = requested_user_id
      and (auth_session.not_after is null or auth_session.not_after > now())
  ) then
    raise exception 'active auth session required' using errcode = '42501';
  end if;

  return query
  select membership.organization_id, membership.user_id, membership.role
  from public.memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.user_id = requested_user_id
    and (requested_organization_id is null
      or membership.organization_id = requested_organization_id)
  order by
    (organization.personal_owner_user_id = requested_user_id) desc,
    membership.organization_id
  limit 1;
end
$$;

revoke all on function private.provision_personal_organization(uuid, text) from public;
revoke all on function private.resolve_identity_membership(uuid, uuid, uuid) from public;
grant execute on function private.provision_personal_organization(uuid, text) to page2webmcp_app;
grant execute on function private.resolve_identity_membership(uuid, uuid, uuid) to page2webmcp_app;

-- Direct Data API access remains read-only; the narrowly-scoped private
-- provisioning function above is the only personal-workspace creation path.
revoke insert, update, delete on public.organizations, public.memberships from anon, authenticated;
grant select on public.organizations, public.memberships to authenticated;
