create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$
begin
  create role page2webmcp_worker nologin;
exception
  when duplicate_object then null;
end
$$;

alter table public.projects
  add column created_by uuid references auth.users(id),
  add column source_type text,
  add column source_url text,
  add column status text;

update public.projects p
set created_by = (
      select m.user_id
      from public.memberships m
      where m.organization_id = p.organization_id
      order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, m.user_id
      limit 1
    ),
    source_type = 'website',
    source_url = coalesce(p.primary_origin, 'https://acme.example'),
    status = 'created';

do $$
begin
  if exists (select 1 from public.projects where created_by is null) then
    raise exception 'every existing project must have an organization member before migration';
  end if;
end
$$;

alter table public.projects
  alter column created_by set not null,
  alter column source_type set not null,
  alter column source_url set not null,
  alter column status set not null,
  alter column id set default gen_random_uuid(),
  add constraint projects_source_type_check check (source_type in ('website', 'openapi', 'github')),
  add constraint projects_status_check check (status in ('created', 'analyzing', 'analyzed', 'failed'));

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  error_code text,
  result jsonb,
  release_code text,
  release_hash text,
  allowed_origin text,
  release_manifest jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.analysis_runs (organization_id, project_id, requested_by, status, attempts)
select organization_id, id, created_by, 'succeeded', 1
from public.projects;

alter table public.capabilities
  add column analysis_run_id uuid references public.analysis_runs(id),
  add column risk_tier text,
  add column version integer;

update public.capabilities c
set analysis_run_id = (
      select ar.id from public.analysis_runs ar
      where ar.project_id = c.project_id
      order by ar.created_at, ar.id
      limit 1
    ),
    risk_tier = case when c.status = 'blocked' then 'R3' else 'R0' end,
    version = 1;

alter table public.capabilities
  alter column id set default gen_random_uuid(),
  alter column analysis_run_id set not null,
  alter column risk_tier set not null,
  alter column version set not null,
  add constraint capabilities_risk_tier_check check (risk_tier in ('R0', 'R1', 'R2', 'R3')),
  add constraint capabilities_status_check check (status in ('proposed', 'reviewed', 'verified', 'blocked')),
  add constraint capabilities_version_check check (version > 0),
  add constraint capabilities_run_name_key unique (analysis_run_id, stable_name);

create table public.analysis_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete cascade,
  source text not null check (source in ('runtime', 'openapi', 'source')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);

create table public.capability_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  capability_id uuid not null references public.capabilities(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  action text not null check (action in ('approve', 'block', 'reject')),
  capability_version integer not null check (capability_version > 0),
  created_at timestamptz not null default now(),
  unique (capability_id, capability_version)
);

create table public.verification_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete cascade,
  schema_valid boolean not null,
  authenticated boolean not null,
  replay_passes integer not null check (replay_passes between 0 and 3),
  no_secret_leakage boolean not null,
  browser_execution boolean not null,
  selection_score integer not null check (selection_score between 0 and 20),
  eligible boolean not null,
  failures text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.releases
  add column organization_id uuid references public.organizations(id),
  add column analysis_run_id uuid references public.analysis_runs(id),
  add column code text,
  add column allowed_origin text,
  add column manifest jsonb,
  add column sri text;

update public.releases r
set organization_id = p.organization_id,
    analysis_run_id = (
      select ar.id from public.analysis_runs ar
      where ar.project_id = r.project_id
      order by ar.created_at, ar.id
      limit 1
    ),
    code = '',
    allowed_origin = coalesce(p.primary_origin, 'https://acme.example'),
    manifest = '{}'::jsonb,
    sri = '',
    status = 'revoked'
from public.projects p
where p.id = r.project_id;

alter table public.releases
  alter column id set default gen_random_uuid(),
  alter column organization_id set not null,
  alter column analysis_run_id set not null,
  alter column code set not null,
  alter column allowed_origin set not null,
  alter column manifest set not null,
  alter column sri set not null,
  add constraint releases_status_check check (status in ('published', 'revoked'));

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  actor_id uuid not null references auth.users(id),
  action text not null,
  target_id uuid not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create table private.analysis_jobs (
  analysis_run_id uuid primary key references public.analysis_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'running') = (lease_owner is not null and lease_expires_at is not null))
);

create table private.idempotency_keys (
  actor_id uuid not null references auth.users(id),
  organization_id uuid not null references public.organizations(id),
  operation text not null,
  idempotency_key text not null,
  input_hash text not null,
  result_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (actor_id, operation, idempotency_key)
);

create table private.app_sessions (
  id uuid primary key,
  actor_id uuid not null references auth.users(id),
  organization_id uuid not null references public.organizations(id),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index memberships_user_id_idx on public.memberships(user_id);
create index projects_organization_id_idx on public.projects(organization_id);
create index projects_created_by_idx on public.projects(created_by);
create index analysis_runs_organization_id_idx on public.analysis_runs(organization_id);
create index analysis_runs_project_id_idx on public.analysis_runs(project_id);
create index analysis_runs_requested_by_idx on public.analysis_runs(requested_by);
create index capabilities_project_id_idx on public.capabilities(project_id);
create index capabilities_analysis_run_id_idx on public.capabilities(analysis_run_id);
create index analysis_evidence_project_id_idx on public.analysis_evidence(project_id);
create index analysis_evidence_analysis_run_id_idx on public.analysis_evidence(analysis_run_id);
create index analysis_evidence_expires_at_idx on public.analysis_evidence(expires_at);
create index capability_reviews_project_id_idx on public.capability_reviews(project_id);
create index capability_reviews_capability_id_idx on public.capability_reviews(capability_id);
create index capability_reviews_actor_id_idx on public.capability_reviews(actor_id);
create index verification_runs_project_id_created_at_idx on public.verification_runs(project_id, created_at desc);
create index verification_runs_analysis_run_id_idx on public.verification_runs(analysis_run_id);
create index releases_project_id_idx on public.releases(project_id);
create index releases_organization_id_idx on public.releases(organization_id);
create index releases_analysis_run_id_idx on public.releases(analysis_run_id);
create index audit_events_organization_id_created_at_idx on public.audit_events(organization_id, created_at desc);
create index audit_events_actor_id_idx on public.audit_events(actor_id);
create index audit_events_expires_at_idx on public.audit_events(expires_at);
create index analysis_jobs_claim_idx on private.analysis_jobs(available_at, created_at)
  where status = 'queued';
create index analysis_jobs_lease_idx on private.analysis_jobs(lease_expires_at)
  where status = 'running';
create index idempotency_keys_expires_at_idx on private.idempotency_keys(expires_at);
create index app_sessions_actor_id_idx on private.app_sessions(actor_id);
create index app_sessions_expires_at_idx on private.app_sessions(expires_at);

alter table public.analysis_runs enable row level security;
alter table public.analysis_evidence enable row level security;
alter table public.capability_reviews enable row level security;
alter table public.verification_runs enable row level security;
alter table public.audit_events enable row level security;

alter table public.organizations force row level security;
alter table public.memberships force row level security;
alter table public.projects force row level security;
alter table public.analysis_runs force row level security;
alter table public.analysis_evidence force row level security;
alter table public.capabilities force row level security;
alter table public.capability_reviews force row level security;
alter table public.verification_runs force row level security;
alter table public.releases force row level security;
alter table public.audit_events force row level security;

drop policy if exists "members read organizations" on public.organizations;
drop policy if exists "members read memberships" on public.memberships;
drop policy if exists "members manage projects" on public.projects;
drop policy if exists "members manage capabilities" on public.capabilities;
drop policy if exists "owners publish releases" on public.releases;

create policy "members select organizations"
on public.organizations for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = organizations.id
    and m.user_id = (select auth.uid())
));

create policy "members select own membership"
on public.memberships for select to authenticated
using (user_id = (select auth.uid()));

create policy "members select projects"
on public.projects for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = projects.organization_id
    and m.user_id = (select auth.uid())
));

create policy "owners and editors insert projects"
on public.projects for insert to authenticated
with check (
  created_by = (select auth.uid())
  and exists (
    select 1 from public.memberships m
    where m.organization_id = projects.organization_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'editor')
  )
);

create policy "owners and editors update projects"
on public.projects for update to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = projects.organization_id
    and m.user_id = (select auth.uid())
    and m.role in ('owner', 'editor')
))
with check (exists (
  select 1 from public.memberships m
  where m.organization_id = projects.organization_id
    and m.user_id = (select auth.uid())
    and m.role in ('owner', 'editor')
));

create policy "owners delete projects"
on public.projects for delete to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = projects.organization_id
    and m.user_id = (select auth.uid())
    and m.role = 'owner'
));

create policy "members select analysis runs"
on public.analysis_runs for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = analysis_runs.organization_id
    and m.user_id = (select auth.uid())
));

create policy "owners and editors enqueue analysis"
on public.analysis_runs for insert to authenticated
with check (
  requested_by = (select auth.uid())
  and exists (
    select 1 from public.memberships m
    where m.organization_id = analysis_runs.organization_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'editor')
  )
);

create policy "members select evidence"
on public.analysis_evidence for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = analysis_evidence.organization_id
    and m.user_id = (select auth.uid())
));

create policy "members select capabilities"
on public.capabilities for select to authenticated
using (exists (
  select 1
  from public.projects p
  join public.memberships m on m.organization_id = p.organization_id
  where p.id = capabilities.project_id
    and m.user_id = (select auth.uid())
));

create policy "members select reviews"
on public.capability_reviews for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = capability_reviews.organization_id
    and m.user_id = (select auth.uid())
));

create policy "reviewers insert reviews"
on public.capability_reviews for insert to authenticated
with check (
  actor_id = (select auth.uid())
  and exists (
    select 1
    from public.memberships m
    join public.capabilities c on c.id = capability_reviews.capability_id
    where m.organization_id = capability_reviews.organization_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'editor')
      and (c.risk_tier = 'R0' or m.role = 'owner')
      and c.risk_tier <> 'R3'
  )
);

create policy "members select verification runs"
on public.verification_runs for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = verification_runs.organization_id
    and m.user_id = (select auth.uid())
));

create policy "members select releases"
on public.releases for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = releases.organization_id
    and m.user_id = (select auth.uid())
));

create policy "owners select audit events"
on public.audit_events for select to authenticated
using (exists (
  select 1 from public.memberships m
  where m.organization_id = audit_events.organization_id
    and m.user_id = (select auth.uid())
    and m.role = 'owner'
));

revoke all on public.analysis_runs, public.analysis_evidence, public.capability_reviews,
  public.verification_runs, public.audit_events from anon, authenticated;
grant select, insert on public.analysis_runs to authenticated;
grant select on public.analysis_evidence, public.capabilities, public.verification_runs,
  public.releases, public.audit_events to authenticated;
grant select, insert on public.capability_reviews to authenticated;
grant select on public.organizations, public.memberships to authenticated;
grant select, insert, update, delete on public.projects to authenticated;

grant usage on schema private to page2webmcp_worker;
grant select, insert, update, delete on private.analysis_jobs, private.idempotency_keys,
  private.app_sessions to page2webmcp_worker;
grant select, insert, update on public.analysis_runs, public.analysis_evidence,
  public.capabilities, public.capability_reviews, public.verification_runs,
  public.releases, public.audit_events, public.projects to page2webmcp_worker;
