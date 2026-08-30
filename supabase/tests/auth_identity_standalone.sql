begin;

insert into auth.users (id, email, email_confirmed_at)
values ('55555555-5555-5555-5555-555555555555', 'personal@example.test', now());
insert into auth.sessions (id, user_id, not_after)
values (
  '55555555-aaaa-4aaa-8aaa-555555555555',
  '55555555-5555-5555-5555-555555555555',
  now() + interval '1 hour'
);

do $schema_test$
begin
  if has_function_privilege(
      'authenticated', 'private.provision_personal_organization(uuid,text)', 'execute'
    ) or has_function_privilege(
      'anon', 'private.provision_personal_organization(uuid,text)', 'execute'
    ) or not has_function_privilege(
      'page2webmcp_app', 'private.provision_personal_organization(uuid,text)', 'execute'
    ) then
    raise exception 'personal organization provisioning is not private to the application role';
  end if;
  if has_table_privilege('authenticated', 'public.organizations', 'insert')
    or has_table_privilege('authenticated', 'public.organizations', 'update')
    or has_table_privilege('authenticated', 'public.memberships', 'insert')
    or has_table_privilege('authenticated', 'public.memberships', 'update') then
    raise exception 'Data API can bypass personal organization provisioning';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'organizations'
      and cmd = 'UPDATE'
      and qual is not null
      and with_check is not null
  ) then
    raise exception 'organization update policy requires USING and WITH CHECK';
  end if;
end
$schema_test$;

set local role page2webmcp_app;
select set_config('page2webmcp.actor_id', '55555555-5555-5555-5555-555555555555', true);
select set_config('page2webmcp.access', 'identity', true);
select * from private.provision_personal_organization(
  '55555555-5555-5555-5555-555555555555',
  'personal@example.test'
);
select * from private.provision_personal_organization(
  '55555555-5555-5555-5555-555555555555',
  'personal@example.test'
);
reset role;

do $convergence_test$
begin
  if (select count(*) from public.organizations where personal_owner_user_id = '55555555-5555-5555-5555-555555555555') <> 1
    or (select count(*) from public.memberships where user_id = '55555555-5555-5555-5555-555555555555' and role = 'owner') <> 1 then
    raise exception 'personal organization provisioning did not converge';
  end if;
end
$convergence_test$;

set local role page2webmcp_app;
select set_config('page2webmcp.actor_id', '55555555-5555-5555-5555-555555555555', true);
select set_config('page2webmcp.access', 'identity', true);
select * from private.resolve_identity_membership(
  '55555555-5555-5555-5555-555555555555',
  null,
  '55555555-aaaa-4aaa-8aaa-555555555555'
);
reset role;

delete from auth.sessions where id = '55555555-aaaa-4aaa-8aaa-555555555555';
do $revocation_test$
begin
  perform set_config('page2webmcp.actor_id', '55555555-5555-5555-5555-555555555555', true);
  perform set_config('page2webmcp.access', 'identity', true);
  execute 'set local role page2webmcp_app';
  begin
    perform * from private.resolve_identity_membership(
      '55555555-5555-5555-5555-555555555555',
      null,
      '55555555-aaaa-4aaa-8aaa-555555555555'
    );
    raise exception 'revoked auth session resolved an application actor';
  exception
    when insufficient_privilege then null;
  end;
  execute 'reset role';
end
$revocation_test$;

rollback;
