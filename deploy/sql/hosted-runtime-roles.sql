-- Hosted runtime logins for Page2WebMCP.
--
-- Run as the project owner (dashboard SQL editor or Supabase MCP) AFTER every
-- migration in supabase/migrations is applied. It is the hosted counterpart of
-- scripts/local-runtime-roles.mjs: each login can assume exactly one NOLOGIN
-- application role and is non-owner, non-superuser, non-inheriting, and cannot
-- bypass RLS, which is what packages/database/src/readiness.ts audits.
--
-- The Supabase session pooler does not forward the libpq "options" startup
-- parameter, so the assumed role is pinned on the login itself with
-- `alter role ... set role` instead of `?options=-c role=...` in the URL.
--
-- Replace the three __*_PW__ placeholders with fresh 32+ byte secrets before
-- running. Re-running rotates the passwords in place. Never commit real values.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('page2webmcp_app_hosted',         'page2webmcp_app',         10, '__APP_PW__'),
      ('page2webmcp_worker_hosted',      'page2webmcp_worker',       5, '__WORKER_PW__'),
      ('page2webmcp_maintenance_hosted', 'page2webmcp_maintenance',  2, '__MAINT_PW__')
    ) as t(login, app_role, conn_limit, pw)
  loop
    if exists (select 1 from pg_roles where rolname = spec.login) then
      execute format(
        'alter role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit %s password %L',
        spec.login, spec.conn_limit, spec.pw);
    else
      execute format(
        'create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit %s password %L',
        spec.login, spec.conn_limit, spec.pw);
    end if;
    execute format('revoke page2webmcp_app, page2webmcp_worker, page2webmcp_maintenance from %I', spec.login);
    execute format('grant %I to %I', spec.app_role, spec.login);
    execute format('alter role %I set role = %L', spec.login, spec.app_role);
  end loop;
end $$;

-- Verify: every row must show rolcanlogin=true, rolinherit=false, one member_of.
select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolconnlimit, rolconfig,
  coalesce(array(select r.rolname::text from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = l.oid), '{}') as member_of
from pg_roles l where rolname like 'page2webmcp%_hosted' order by rolname;
