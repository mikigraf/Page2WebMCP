-- Persist the bounded verification context with the source and copy it to each
-- analysis job. Existing sources are deliberately marked legacy rather than
-- inferred, because they did not supply the required OpenAPI verification data.
create function private.canonical_https_origin(origin text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  authority text;
  host text;
  port_text text;
  port integer;
  label text;
begin
  if origin is null or left(origin, 8) <> 'https://' then return false; end if;
  authority := substring(origin from 9);
  if authority = '' or position('/' in authority) > 0 or position('?' in authority) > 0
    or position('#' in authority) > 0 or position('@' in authority) > 0 then return false; end if;
  if position(':' in authority) > 0 then
    if position(':' in substring(authority from position(':' in authority) + 1)) > 0 then return false; end if;
    host := split_part(authority, ':', 1);
    port_text := split_part(authority, ':', 2);
    if port_text = '' or char_length(port_text) > 5
      or translate(port_text, '0123456789', '') <> '' then return false; end if;
    port := port_text::integer;
    if port < 1 or port > 65535 or port = 443 or port_text <> port::text then return false; end if;
  else
    host := authority;
  end if;
  if host = '' or char_length(host) > 253 or host <> lower(host)
    or translate(host, 'abcdefghijklmnopqrstuvwxyz0123456789.-', '') <> ''
    or left(host, 1) in ('.', '-') or right(host, 1) in ('.', '-') then return false; end if;
  foreach label in array string_to_array(host, '.') loop
    if label = '' or char_length(label) > 63 or left(label, 1) = '-' or right(label, 1) = '-' then return false; end if;
  end loop;
  return true;
end
$$;

create function private.canonical_https_test_page_segment(segment text)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select lower(segment) not in ('.', '..', '%2e', '.%2e', '%2e.', '%2e%2e');
$$;

create function private.canonical_https_test_page(origin text, page_url text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  path text;
  segment text;
begin
  if not private.canonical_https_origin(origin) or page_url is null
    or position('#' in page_url) > 0 or position(' ' in page_url) > 0
    or left(page_url, char_length(origin) + 1) <> origin || '/' then return false; end if;
  path := split_part(substring(page_url from char_length(origin) + 1), '?', 1);
  if position(E'\\' in path) > 0 then return false; end if;
  foreach segment in array string_to_array(path, '/') loop
    if not private.canonical_https_test_page_segment(segment) then return false; end if;
  end loop;
  return true;
end
$$;

create function private.valid_source_configuration(source_type text, value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = pg_catalog, private
as $$
  select case source_type
    when 'website' then value in ('{"kind":"website"}'::jsonb, '{"kind":"legacy_unconfigured"}'::jsonb)
    when 'github' then value in ('{"kind":"github"}'::jsonb, '{"kind":"legacy_unconfigured"}'::jsonb)
    when 'openapi' then value = '{"kind":"legacy_unconfigured"}'::jsonb or (
      jsonb_typeof(value) = 'object'
      and value ?& array['kind', 'targetOrigin', 'testPageUrl', 'environment']
      and value - array['kind', 'targetOrigin', 'testPageUrl', 'environment'] = '{}'::jsonb
      and value->>'kind' = 'openapi'
      and value->>'environment' in ('test', 'staging', 'production')
      and private.canonical_https_origin(value->>'targetOrigin')
      and private.canonical_https_test_page(value->>'targetOrigin', value->>'testPageUrl')
    )
    else false
  end;
$$;

revoke all on function private.canonical_https_origin(text) from public;
revoke all on function private.canonical_https_test_page_segment(text) from public;
revoke all on function private.canonical_https_test_page(text, text) from public;
revoke all on function private.valid_source_configuration(text, jsonb) from public;
grant execute on function private.canonical_https_origin(text), private.canonical_https_test_page_segment(text), private.canonical_https_test_page(text, text),
  private.valid_source_configuration(text, jsonb) to page2webmcp_app, page2webmcp_worker;

alter table public.project_sources
  add column source_configuration jsonb;

update public.project_sources
set source_configuration = '{"kind":"legacy_unconfigured"}'::jsonb
where source_configuration is null;

alter table public.project_sources
  alter column source_configuration set not null,
  add constraint project_sources_source_configuration_check
    check (private.valid_source_configuration(source_type, source_configuration));

alter table private.analysis_jobs
  add column source_configuration jsonb;

update private.analysis_jobs job
set source_configuration = source.source_configuration
from public.analysis_runs run
join public.project_sources source
  on source.project_id = run.project_id
 and source.organization_id = run.organization_id
 and source.active
where job.analysis_run_id = run.id
  and job.organization_id = run.organization_id
  and job.source_configuration is null;

do $$
begin
  if exists (select 1 from private.analysis_jobs where source_configuration is null) then
    raise exception 'every analysis job must resolve to a source configuration before hardening';
  end if;
end
$$;

alter table private.analysis_jobs
  alter column source_configuration set not null,
  add constraint analysis_jobs_source_configuration_check
    check (private.valid_source_configuration(source_type, source_configuration));

-- Source snapshots bind the canonical JSON representation as well as type/URL.
update public.source_snapshots snapshot
set source_identity_hash = encode(digest(
  octet_length(source.source_type)::text || ':' || source.source_type || ':' ||
  octet_length(source.source_url)::text || ':' || source.source_url || ':' ||
  octet_length(source.source_configuration::text)::text || ':' || source.source_configuration::text,
  'sha256'
), 'hex')
from public.project_sources source
where source.id = snapshot.project_source_id
  and source.project_id = snapshot.project_id
  and source.organization_id = snapshot.organization_id;

-- Both tables already use forced RLS. Reassert the role boundary after adding
-- the JSON columns: no anon/authenticated role receives table access.
revoke all on public.project_sources from anon, authenticated;
revoke all on private.analysis_jobs from anon, authenticated;
grant select, insert on public.project_sources to page2webmcp_app;
grant select on public.project_sources to page2webmcp_worker;
grant select, insert on private.analysis_jobs to page2webmcp_app;
grant select, update (status, attempts, lease_owner, lease_expires_at, available_at, updated_at)
  on private.analysis_jobs to page2webmcp_worker;
