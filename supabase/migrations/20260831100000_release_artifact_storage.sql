-- The Storage service owns its schema and object policies. This migration
-- creates only the fixed public bucket metadata and fails closed on drift.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'page2webmcp-releases',
  'page2webmcp-releases',
  true,
  65536,
  array['application/javascript']::text[]
)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from storage.buckets
    where id = 'page2webmcp-releases'
      and name = 'page2webmcp-releases'
      and public is not distinct from true
      and file_size_limit is not distinct from 65536
      and allowed_mime_types is not distinct from array['application/javascript']::text[]
  ) then
    raise exception 'release artifact bucket configuration mismatch';
  end if;
end
$$;
