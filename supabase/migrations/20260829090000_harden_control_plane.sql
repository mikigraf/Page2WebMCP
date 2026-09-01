-- Harden the durable control-plane model around explicit tenant context.
-- Internal roles remain NOLOGIN/NOINHERIT and never bypass RLS. A deployment
-- login must be granted only the role(s) needed by that process.
do $$
begin
  create role page2webmcp_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception
  when duplicate_object then null;
end
$$;

-- Supabase's tenant postgres role may restate only attributes that do not
-- require true superuser authority. The next migration asserts every safe
-- attribute after all three application roles exist.
alter role page2webmcp_app nologin noinherit nocreatedb nocreaterole;
alter role page2webmcp_worker nologin noinherit nocreatedb nocreaterole;

-- Make every redundant tenant identifier relationally consistent. These keys
-- let PostgreSQL reject cross-tenant references even for privileged migrations.
alter table public.projects
  add constraint projects_id_organization_id_key unique (id, organization_id),
  add constraint projects_creator_membership_fk
    foreign key (organization_id, created_by)
    references public.memberships (organization_id, user_id);

alter table public.analysis_runs
  add constraint analysis_runs_id_organization_id_key unique (id, organization_id),
  add constraint analysis_runs_id_project_org_key unique (id, project_id, organization_id),
  add constraint analysis_runs_project_tenant_fk
    foreign key (project_id, organization_id)
    references public.projects (id, organization_id),
  add constraint analysis_runs_requester_membership_fk
    foreign key (organization_id, requested_by)
    references public.memberships (organization_id, user_id);

alter table public.capabilities add column organization_id uuid;
update public.capabilities c
set organization_id = p.organization_id
from public.projects p
where p.id = c.project_id;
alter table public.capabilities
  alter column organization_id set not null,
  add constraint capabilities_high_risk_blocked_check
    check (risk_tier <> 'R3' or status = 'blocked'),
  add constraint capabilities_id_project_org_key unique (id, project_id, organization_id),
  add constraint capabilities_run_project_tenant_fk
    foreign key (analysis_run_id, project_id, organization_id)
    references public.analysis_runs (id, project_id, organization_id);

alter table public.analysis_evidence
  add constraint analysis_evidence_run_project_tenant_fk
    foreign key (analysis_run_id, project_id, organization_id)
    references public.analysis_runs (id, project_id, organization_id);

alter table public.capability_reviews
  add constraint capability_reviews_capability_tenant_fk
    foreign key (capability_id, project_id, organization_id)
    references public.capabilities (id, project_id, organization_id),
  add constraint capability_reviews_actor_membership_fk
    foreign key (organization_id, actor_id)
    references public.memberships (organization_id, user_id);

alter table public.verification_runs
  add column capability_state_digest text,
  add column candidate_content_hash text,
  add column revision bigint generated always as identity;
update public.verification_runs
set capability_state_digest = repeat('0', 64),
    candidate_content_hash = repeat('0', 64),
    eligible = false,
    failures = array_append(failures, 'MIGRATION_REVERIFY_REQUIRED')
where capability_state_digest is null
   or candidate_content_hash is null;
alter table public.verification_runs
  alter column capability_state_digest set not null,
  alter column candidate_content_hash set not null,
  add constraint verification_runs_capability_digest_check
    check (capability_state_digest ~ '^[0-9a-f]{64}$'),
  add constraint verification_runs_candidate_hash_check
    check (candidate_content_hash ~ '^[0-9a-f]{64}$'),
  add constraint verification_runs_eligibility_check
    check (eligible = (
      schema_valid
      and authenticated
      and replay_passes >= 3
      and no_secret_leakage
      and browser_execution
      and selection_score >= 18
      and capability_state_digest <> repeat('0', 64)
      and candidate_content_hash <> repeat('0', 64)
    )),
  add constraint verification_runs_run_project_tenant_fk
    foreign key (analysis_run_id, project_id, organization_id)
    references public.analysis_runs (id, project_id, organization_id);

alter table public.releases drop constraint if exists releases_content_hash_key;
alter table public.releases add column capability_state_digest text;
update public.releases set capability_state_digest = repeat('0', 64) where capability_state_digest is null;
alter table public.releases
  alter column capability_state_digest set not null,
  add constraint releases_capability_digest_check
    check (capability_state_digest ~ '^[0-9a-f]{64}$'),
  add constraint releases_published_integrity_check
    check (
      status <> 'published'
      or (
        capability_state_digest <> repeat('0', 64)
        and content_hash ~ '^[0-9a-f]{64}$'
        and octet_length(code) <= 65536
      )
    ),
  add constraint releases_run_project_tenant_fk
    foreign key (analysis_run_id, project_id, organization_id)
    references public.analysis_runs (id, project_id, organization_id),
  add constraint releases_project_analysis_run_key unique (project_id, analysis_run_id);

update public.analysis_runs
set status = 'failed',
    error_code = 'MIGRATION_REANALYSIS_REQUIRED',
    updated_at = now()
where status = 'succeeded'
  and release_code is null;
update public.projects p
set status = 'failed'
where exists (
  select 1 from public.analysis_runs ar
  where ar.project_id = p.id
    and ar.organization_id = p.organization_id
    and ar.error_code = 'MIGRATION_REANALYSIS_REQUIRED'
);

-- Queue claims carry the source identity captured when the run was enqueued.
-- Adding and backfilling here keeps this migration safe for databases that
-- already applied the original durable-queue migration.
alter table private.analysis_jobs
  add column if not exists source_type text,
  add column if not exists source_url text;
update private.analysis_jobs j
set source_type = p.source_type,
    source_url = p.source_url
from public.analysis_runs ar
join public.projects p
  on p.id = ar.project_id
 and p.organization_id = ar.organization_id
where ar.id = j.analysis_run_id
  and ar.organization_id = j.organization_id
  and (j.source_type is null or j.source_url is null);
do $$
begin
  if exists (select 1 from private.analysis_jobs where source_type is null or source_url is null) then
    raise exception 'every analysis job must resolve to a source snapshot before hardening';
  end if;
end
$$;
alter table private.analysis_jobs
  alter column source_type set not null,
  alter column source_url set not null,
  add constraint analysis_jobs_source_type_check
    check (source_type in ('website', 'openapi', 'github')),
  add constraint analysis_jobs_source_url_check
    check (octet_length(source_url) between 1 and 2048),
  add constraint analysis_jobs_run_tenant_fk
    foreign key (analysis_run_id, organization_id)
    references public.analysis_runs (id, organization_id);

alter table private.app_sessions
  add constraint app_sessions_actor_membership_fk
    foreign key (organization_id, actor_id)
    references public.memberships (organization_id, user_id);

alter table private.idempotency_keys drop constraint idempotency_keys_pkey;
alter table private.idempotency_keys
  add constraint idempotency_keys_pkey
    primary key (organization_id, actor_id, operation, idempotency_key),
  add constraint idempotency_operation_check check (operation in ('project', 'analysis', 'release'));

create unique index analysis_runs_one_active_per_project_idx
  on public.analysis_runs (project_id)
  where status in ('queued', 'running');
create index capabilities_organization_id_idx on public.capabilities (organization_id);
create index releases_content_hash_published_idx
  on public.releases (content_hash, created_at, id)
  where status = 'published';
create index verification_runs_exact_gate_idx
  on public.verification_runs (
    analysis_run_id, capability_state_digest, candidate_content_hash, revision desc
  );

-- Explicit, transaction-local server identity. Values are set by the
-- repository after SET LOCAL ROLE; Data API callers cannot assume these roles.
create or replace function private.context_organization_id()
returns uuid
language sql
stable
as $$
  select case
    when current_setting('page2webmcp.organization_id', true)
      ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then current_setting('page2webmcp.organization_id', true)::uuid
    else null
  end
$$;

create or replace function private.context_actor_id()
returns uuid
language sql
stable
as $$
  select case
    when current_setting('page2webmcp.actor_id', true)
      ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then current_setting('page2webmcp.actor_id', true)::uuid
    else null
  end
$$;

create or replace function private.context_access()
returns text
language sql
stable
as $$
  select coalesce(current_setting('page2webmcp.access', true), '')
$$;

create or replace function private.context_member(target_organization_id uuid, allowed_roles text[] default null)
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = target_organization_id
      and m.organization_id = private.context_organization_id()
      and m.user_id = private.context_actor_id()
      and (allowed_roles is null or m.role = any (allowed_roles))
  )
$$;

revoke all on function private.context_organization_id() from public;
revoke all on function private.context_actor_id() from public;
revoke all on function private.context_access() from public;
revoke all on function private.context_member(uuid, text[]) from public;
grant execute on function private.context_organization_id(), private.context_actor_id(),
  private.context_access(), private.context_member(uuid, text[])
  to page2webmcp_app, page2webmcp_worker;

-- The private queue is authoritative for run state. Synchronizing in one
-- security-definer trigger prevents public/private state drift while keeping
-- the worker's column privileges minimal.
create or replace function private.sync_analysis_job_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  target_project_id uuid;
begin
  update public.analysis_runs
  set status = new.status,
      attempts = new.attempts,
      updated_at = now()
  where id = new.analysis_run_id
    and organization_id = new.organization_id
  returning project_id into target_project_id;

  if target_project_id is null then
    raise exception 'analysis job tenant does not match its run' using errcode = '23503';
  end if;

  update public.projects
  set status = case new.status
    when 'queued' then 'analyzing'
    when 'running' then 'analyzing'
    when 'succeeded' then 'analyzed'
    when 'failed' then 'failed'
    else status
  end
  where id = target_project_id
    and organization_id = new.organization_id;

  return new;
end
$$;

revoke all on function private.sync_analysis_job_state() from public;
drop trigger if exists sync_analysis_job_state on private.analysis_jobs;
create trigger sync_analysis_job_state
after insert or update of status, attempts on private.analysis_jobs
for each row execute function private.sync_analysis_job_state();

alter table private.analysis_jobs enable row level security;
alter table private.analysis_jobs force row level security;
alter table private.idempotency_keys enable row level security;
alter table private.idempotency_keys force row level security;
alter table private.app_sessions enable row level security;
alter table private.app_sessions force row level security;

-- Public Data API access is intentionally read-only. All lifecycle mutations
-- go through the server repository so idempotency and state transitions cannot
-- be bypassed.
drop policy if exists "owners and editors insert projects" on public.projects;
drop policy if exists "owners and editors update projects" on public.projects;
drop policy if exists "owners delete projects" on public.projects;
drop policy if exists "owners and editors enqueue analysis" on public.analysis_runs;
drop policy if exists "reviewers insert reviews" on public.capability_reviews;

revoke insert, update, delete on public.organizations, public.memberships, public.projects,
  public.analysis_runs, public.analysis_evidence, public.capabilities, public.capability_reviews,
  public.verification_runs, public.releases, public.audit_events from authenticated;

create policy "app reads current membership"
on public.memberships for select to page2webmcp_app
using (
  organization_id = private.context_organization_id()
  and user_id = private.context_actor_id()
);

create policy "app reads projects"
on public.projects for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app creates projects"
on public.projects for insert to page2webmcp_app
with check (
  organization_id = private.context_organization_id()
  and created_by = private.context_actor_id()
  and private.context_member(organization_id, array['owner', 'editor'])
);

create policy "app reads analysis runs"
on public.analysis_runs for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app enqueues analysis runs"
on public.analysis_runs for insert to page2webmcp_app
with check (
  organization_id = private.context_organization_id()
  and requested_by = private.context_actor_id()
  and private.context_member(organization_id, array['owner', 'editor'])
);
create policy "owners persist verified candidates"
on public.analysis_runs for update to page2webmcp_app
using (
  status = 'succeeded'
  and private.context_member(organization_id, array['owner'])
)
with check (
  status = 'succeeded'
  and private.context_member(organization_id, array['owner'])
);
create policy "worker reads analysis runs"
on public.analysis_runs for select to page2webmcp_worker using (true);
create policy "worker updates analysis runs"
on public.analysis_runs for update to page2webmcp_worker using (true) with check (true);

create policy "app reads evidence"
on public.analysis_evidence for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "worker creates evidence"
on public.analysis_evidence for insert to page2webmcp_worker
with check (exists (
  select 1 from public.analysis_runs ar
  where ar.id = analysis_evidence.analysis_run_id
    and ar.project_id = analysis_evidence.project_id
    and ar.organization_id = analysis_evidence.organization_id
    and ar.status = 'running'
));

create policy "app reads capabilities"
on public.capabilities for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app reviews capabilities"
on public.capabilities for update to page2webmcp_app
using (private.context_member(organization_id, array['owner', 'editor']))
with check (
  risk_tier <> 'R3'
  and private.context_member(organization_id, array['owner', 'editor'])
  and (
    risk_tier = 'R0'
    or private.context_member(organization_id, array['owner'])
  )
);
create policy "worker creates capabilities"
on public.capabilities for insert to page2webmcp_worker
with check (exists (
  select 1 from public.analysis_runs ar
  where ar.id = capabilities.analysis_run_id
    and ar.project_id = capabilities.project_id
    and ar.organization_id = capabilities.organization_id
    and ar.status = 'running'
));

create policy "app reads capability reviews"
on public.capability_reviews for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app creates capability reviews"
on public.capability_reviews for insert to page2webmcp_app
with check (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
  and private.context_member(organization_id, array['owner', 'editor'])
  and exists (
    select 1 from public.capabilities c
    where c.id = capability_reviews.capability_id
      and c.project_id = capability_reviews.project_id
      and c.organization_id = capability_reviews.organization_id
      and c.risk_tier <> 'R3'
      and (
        c.risk_tier = 'R0'
        or private.context_member(capability_reviews.organization_id, array['owner'])
      )
  )
);

create policy "app reads verification runs"
on public.verification_runs for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "owners create verification runs"
on public.verification_runs for insert to page2webmcp_app
with check (
  private.context_member(organization_id, array['owner'])
  and exists (
    select 1 from public.analysis_runs ar
    where ar.id = verification_runs.analysis_run_id
      and ar.project_id = verification_runs.project_id
      and ar.organization_id = verification_runs.organization_id
      and ar.status = 'succeeded'
  )
);

create policy "app reads releases"
on public.releases for select to page2webmcp_app
using (
  private.context_member(organization_id)
  or (private.context_access() = 'artifact' and status = 'published')
);
create policy "owners create releases"
on public.releases for insert to page2webmcp_app
with check (
  private.context_member(organization_id, array['owner'])
  and exists (
    select 1 from public.verification_runs vr
    where vr.analysis_run_id = releases.analysis_run_id
      and vr.project_id = releases.project_id
      and vr.organization_id = releases.organization_id
      and vr.capability_state_digest = releases.capability_state_digest
      and vr.candidate_content_hash = releases.content_hash
      and vr.eligible
  )
);

create policy "owners read audit events"
on public.audit_events for select to page2webmcp_app
using (private.context_member(organization_id, array['owner']));
create policy "app creates audit events"
on public.audit_events for insert to page2webmcp_app
with check (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
  and private.context_member(organization_id)
);

create policy "app reads own organization jobs"
on private.analysis_jobs for select to page2webmcp_app
using (organization_id = private.context_organization_id());
create policy "app creates own organization jobs"
on private.analysis_jobs for insert to page2webmcp_app
with check (organization_id = private.context_organization_id());
create policy "worker manages jobs"
on private.analysis_jobs for all to page2webmcp_worker using (true) with check (true);

create policy "app manages scoped idempotency"
on private.idempotency_keys for all to page2webmcp_app
using (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
)
with check (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
);

create policy "app manages scoped sessions"
on private.app_sessions for all to page2webmcp_app
using (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
)
with check (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
  and private.context_member(organization_id, array[role])
);

revoke all on schema private from page2webmcp_app, page2webmcp_worker;
revoke create on schema public from public;
grant usage on schema public, private to page2webmcp_app, page2webmcp_worker;

revoke all on public.organizations, public.memberships, public.projects, public.analysis_runs,
  public.analysis_evidence, public.capabilities, public.capability_reviews,
  public.verification_runs, public.releases, public.audit_events
  from page2webmcp_app, page2webmcp_worker;
revoke all on private.analysis_jobs, private.idempotency_keys, private.app_sessions
  from page2webmcp_app, page2webmcp_worker;

grant select, insert on public.projects to page2webmcp_app;
grant select on public.memberships to page2webmcp_app;
grant select, insert, update (release_code, release_hash, allowed_origin, release_manifest, updated_at)
  on public.analysis_runs to page2webmcp_app;
grant select on public.analysis_evidence to page2webmcp_app;
grant select, update (status, version) on public.capabilities to page2webmcp_app;
grant select, insert on public.capability_reviews to page2webmcp_app;
grant select, insert on public.verification_runs to page2webmcp_app;
grant select, insert on public.releases to page2webmcp_app;
grant select, insert on public.audit_events to page2webmcp_app;
grant select, insert on private.analysis_jobs to page2webmcp_app;
grant select, insert, update, delete on private.idempotency_keys, private.app_sessions to page2webmcp_app;

grant select, update (result, release_code, release_hash, allowed_origin, release_manifest, error_code, updated_at)
  on public.analysis_runs to page2webmcp_worker;
grant insert on public.analysis_evidence, public.capabilities to page2webmcp_worker;
grant select, update (status, attempts, lease_owner, lease_expires_at, available_at, updated_at)
  on private.analysis_jobs to page2webmcp_worker;
