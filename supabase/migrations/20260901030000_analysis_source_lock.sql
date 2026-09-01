begin;

-- Analysis enqueue calls this inside its existing short application
-- transaction. The definer acquires row locks without granting the app role
-- UPDATE on immutable source records, so an active-source replacement must
-- serialize before or after the exact attested source is persisted.
create function private.lock_active_analysis_source(
  target_organization_id uuid,
  target_project_id uuid,
  expected_project_source_id uuid default null,
  expected_source_snapshot_id uuid default null,
  expected_source_identity_hash text default null
)
returns table (
  source_snapshot_id uuid,
  project_source_id uuid,
  source_identity_hash text,
  source_type text,
  source_url text,
  source_configuration jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if target_organization_id is distinct from private.context_organization_id()
    or not private.context_member(target_organization_id, array['owner', 'editor']) then
    raise exception 'current actor cannot lock analysis source'
      using errcode = '42501';
  end if;

  if (expected_project_source_id is null) <> (expected_source_snapshot_id is null)
    or (expected_project_source_id is null) <> (expected_source_identity_hash is null)
    or (expected_source_identity_hash is not null
      and not (expected_source_identity_hash ~ '^[0-9a-f]{64}$')) then
    raise exception 'expected analysis source is invalid'
      using errcode = '22023';
  end if;

  return query
  select
    snapshot.id,
    source.id,
    snapshot.source_identity_hash,
    source.source_type::text,
    source.source_url,
    source.source_configuration
  from public.source_snapshots as snapshot
  join public.project_sources as source on source.id = snapshot.project_source_id
  where source.project_id = target_project_id
    and source.organization_id = target_organization_id
    and source.active
    and (
      expected_project_source_id is null
      or (
        source.id = expected_project_source_id
        and snapshot.id = expected_source_snapshot_id
        and snapshot.source_identity_hash = expected_source_identity_hash
      )
    )
  order by snapshot.created_at desc, snapshot.id
  limit 1
  for update of source, snapshot;
end;
$$;

revoke all on function private.lock_active_analysis_source(uuid, uuid, uuid, uuid, text) from public;
revoke all on function private.lock_active_analysis_source(uuid, uuid, uuid, uuid, text)
  from anon, authenticated, page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.lock_active_analysis_source(uuid, uuid, uuid, uuid, text)
  to page2webmcp_app;

commit;
