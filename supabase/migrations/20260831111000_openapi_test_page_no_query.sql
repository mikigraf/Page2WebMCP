begin;

-- Applied databases previously admitted query-bearing OpenAPI test pages even
-- though installation guides can only verify a stable query-free page. Never
-- strip a query silently: it is part of the immutable source identity and may
-- select different target behavior. Stop with one bounded diagnostic before
-- changing the predicate if an operator must replace historical source state.
do $$
begin
  if exists (
    select 1
    from public.project_sources
    where source_type = 'openapi'
      and source_configuration->>'kind' = 'openapi'
      and position('?' in source_configuration->>'testPageUrl') > 0
  ) or exists (
    select 1
    from private.analysis_jobs
    where source_type = 'openapi'
      and source_configuration->>'kind' = 'openapi'
      and position('?' in source_configuration->>'testPageUrl') > 0
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'OPENAPI_TEST_PAGE_QUERY_REMEDIATION_REQUIRED';
  end if;
end
$$;

-- With historical state proven compatible, replace the shared predicate so
-- both source and copied analysis-job CHECK constraints reject every new
-- query-bearing configuration.
create or replace function private.canonical_https_test_page(origin text, page_url text)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, private
as $$
declare
  path text;
  segment text;
begin
  if not private.canonical_https_origin(origin) or page_url is null
    or position('?' in page_url) > 0 or position('#' in page_url) > 0 or position(' ' in page_url) > 0
    or left(page_url, char_length(origin) + 1) <> origin || '/' then return false; end if;
  path := substring(page_url from char_length(origin) + 1);
  if not private.canonical_https_test_page_characters(path) then return false; end if;
  if position(E'\\' in path) > 0 then return false; end if;
  foreach segment in array string_to_array(path, '/') loop
    if not private.canonical_https_test_page_segment(segment) then return false; end if;
  end loop;
  return true;
end
$$;

commit;
