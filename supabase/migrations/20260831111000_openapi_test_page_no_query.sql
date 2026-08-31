begin;

-- Applied databases previously admitted query-bearing OpenAPI test pages even
-- though installation guides can only verify a stable query-free page. Replace
-- the shared predicate so both source and copied analysis-job CHECK constraints
-- reject every new query-bearing configuration. Existing rows remain readable
-- only through the application parser, which now fails those rows closed.
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
