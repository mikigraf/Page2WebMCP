begin;

-- The worker-owned analysis artifact is the immutable source from which each
-- reviewed candidate is derived. Candidate bytes belong to the exact
-- verification revision so publication never needs to overwrite analysis_runs.
alter table public.verification_runs
  add column candidate_code text,
  add column candidate_allowed_origin text,
  add column candidate_manifest jsonb;

-- Published artifacts are an authoritative reconstruction source for the
-- verification revision that produced them.
update public.verification_runs as verification
set candidate_code = release.code,
    candidate_allowed_origin = release.allowed_origin,
    candidate_manifest = release.manifest
from public.releases as release
where release.analysis_run_id = verification.analysis_run_id
  and release.project_id = verification.project_id
  and release.organization_id = verification.organization_id
  and release.capability_state_digest = verification.capability_state_digest
  and release.content_hash = verification.candidate_content_hash
  and release.status = 'published';

-- Before this migration, the newest unpublished verification candidate was
-- stored in analysis_runs.release_*. Preserve those bytes as verification
-- history, but do not treat them as a recoverable worker source below.
update public.verification_runs as verification
set candidate_code = analysis.release_code,
    candidate_allowed_origin = analysis.allowed_origin,
    candidate_manifest = analysis.release_manifest
from public.analysis_runs as analysis
where verification.candidate_code is null
  and analysis.id = verification.analysis_run_id
  and analysis.project_id = verification.project_id
  and analysis.organization_id = verification.organization_id
  and analysis.release_hash = verification.candidate_content_hash
  and analysis.release_code is not null
  and analysis.allowed_origin is not null
  and analysis.release_manifest is not null;

-- Older verification revisions cannot be reconstructed when their candidate
-- differs from both the published artifact and the formerly overwritten run
-- columns. Keep their audit record but make them permanently ineligible.
update public.verification_runs
set candidate_code = '',
    candidate_content_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    candidate_allowed_origin = '',
    candidate_manifest = '{}'::jsonb,
    schema_valid = false,
    eligible = false,
    failures = case
      when 'MIGRATION_REVERIFY_REQUIRED' = any(failures) then failures
      else array_append(failures, 'MIGRATION_REVERIFY_REQUIRED')
    end
where candidate_code is null;

-- An unpublished run with pre-migration verification may contain reviewed
-- subset bytes where its worker source used to be. That source is not
-- reconstructible, so fail closed and require a new analysis instead of
-- freezing the subset as a supposedly immutable source.
update public.verification_runs as verification
set schema_valid = false,
    eligible = false,
    failures = case
      when 'MIGRATION_REANALYSIS_REQUIRED' = any(verification.failures) then verification.failures
      else array_append(verification.failures, 'MIGRATION_REANALYSIS_REQUIRED')
    end
where not exists (
  select 1
  from public.releases as release
  where release.analysis_run_id = verification.analysis_run_id
    and release.project_id = verification.project_id
    and release.organization_id = verification.organization_id
    and release.status = 'published'
);

update private.analysis_jobs as job
set status = 'failed',
    lease_owner = null,
    lease_expires_at = null,
    updated_at = now()
where job.status = 'succeeded'
  and exists (
    select 1
    from public.verification_runs as verification
    where verification.analysis_run_id = job.analysis_run_id
      and verification.organization_id = job.organization_id
  )
  and not exists (
    select 1
    from public.releases as release
    where release.analysis_run_id = job.analysis_run_id
      and release.organization_id = job.organization_id
      and release.status = 'published'
  );

update public.analysis_runs as analysis
set status = 'failed',
    error_code = 'MIGRATION_REANALYSIS_REQUIRED',
    updated_at = now()
where analysis.status in ('succeeded', 'failed')
  and exists (
    select 1
    from public.verification_runs as verification
    where verification.analysis_run_id = analysis.id
      and verification.project_id = analysis.project_id
      and verification.organization_id = analysis.organization_id
  )
  and not exists (
    select 1
    from public.releases as release
    where release.analysis_run_id = analysis.id
      and release.project_id = analysis.project_id
      and release.organization_id = analysis.organization_id
      and release.status = 'published'
  );

update public.projects as project
set status = 'failed'
where project.status = 'analyzed'
  and not exists (
    select 1
    from public.analysis_runs as analysis
    where analysis.project_id = project.id
      and analysis.organization_id = project.organization_id
      and analysis.status = 'succeeded'
  );

alter table public.verification_runs
  alter column candidate_code set not null,
  alter column candidate_allowed_origin set not null,
  alter column candidate_manifest set not null,
  add constraint verification_runs_candidate_code_size_check
    check (octet_length(candidate_code) <= 65536),
  add constraint verification_runs_candidate_origin_size_check
    check (octet_length(candidate_allowed_origin) <= 2048),
  add constraint verification_runs_candidate_manifest_size_check
    check (octet_length(candidate_manifest::text) <= 65536);

comment on column public.analysis_runs.release_code is
  'Immutable worker-produced source candidate; reviewed bytes live on verification_runs.';
comment on column public.verification_runs.candidate_code is
  'Reviewed candidate bytes for this exact verification revision.';

-- The application no longer owns any update path on worker source artifacts.
drop policy if exists "owners persist verified candidates" on public.analysis_runs;
revoke update (release_code, release_hash, allowed_origin, release_manifest, updated_at)
  on public.analysis_runs from page2webmcp_app;

-- A worker may populate source fields only while it owns an active run. Once
-- completion changes queue state, FORCE RLS makes those bytes immutable to the
-- worker role as well.
drop policy if exists "worker updates analysis runs" on public.analysis_runs;
create policy "worker updates running analysis runs"
on public.analysis_runs for update to page2webmcp_worker
using (status = 'running')
with check (status = 'running');

-- Verification and publication still need a transaction-scoped run lock, but
-- the application must not receive UPDATE privilege on source columns merely
-- to obtain it. This narrow function validates owner context and holds the row
-- lock without exposing any mutation surface.
create function private.lock_release_analysis_run(
  target_organization_id uuid,
  target_project_id uuid,
  target_analysis_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if target_organization_id is distinct from private.context_organization_id()
    or not private.context_member(target_organization_id, array['owner']) then
    raise exception 'current actor cannot lock analysis run'
      using errcode = '42501';
  end if;

  perform 1
  from public.analysis_runs as analysis
  where analysis.id = target_analysis_run_id
    and analysis.project_id = target_project_id
    and analysis.organization_id = target_organization_id
    and analysis.status = 'succeeded'
  for update;

  return found;
end
$$;

revoke all on function private.lock_release_analysis_run(uuid, uuid, uuid) from public;
revoke all on function private.lock_release_analysis_run(uuid, uuid, uuid)
  from anon, authenticated, page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.lock_release_analysis_run(uuid, uuid, uuid)
  to page2webmcp_app;

commit;
