-- Additive authoritative workflow substrate. The existing analysis queue stays
-- intact as a compatibility projection and retains its analysis-only trigger.

alter table private.idempotency_keys drop constraint idempotency_operation_check;
alter table private.idempotency_keys
  add constraint idempotency_operation_check
  check (operation in ('project', 'analysis', 'release', 'workflow'));

alter table public.analysis_evidence
  add constraint analysis_evidence_id_project_org_key unique (id, project_id, organization_id);
alter table public.verification_runs
  add constraint verification_runs_id_project_org_key unique (id, project_id, organization_id);
alter table public.releases
  add constraint releases_id_project_org_key unique (id, project_id, organization_id);

create table public.project_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_type text not null check (source_type in ('website', 'openapi', 'github')),
  source_url text not null check (octet_length(source_url) between 1 and 2048),
  version integer not null check (version > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (project_id, version),
  unique (id, project_id, organization_id),
  foreign key (project_id, organization_id) references public.projects(id, organization_id)
);

create unique index project_sources_one_active_idx on public.project_sources(project_id) where active;
create index project_sources_organization_project_idx on public.project_sources(organization_id, project_id);

insert into public.project_sources (organization_id, project_id, source_type, source_url, version, active, created_at)
select organization_id, id, source_type, source_url, 1, true, created_at
from public.projects;

create table public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  project_source_id uuid not null references public.project_sources(id) on delete restrict,
  source_identity_hash text not null check (source_identity_hash ~ '^[0-9a-f]{64}$'),
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  artifact_reference text check (artifact_reference is null or artifact_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (project_source_id, source_identity_hash),
  unique (id, project_id, organization_id),
  foreign key (project_source_id, project_id, organization_id)
    references public.project_sources(id, project_id, organization_id),
  foreign key (project_id, organization_id) references public.projects(id, organization_id)
);

create index source_snapshots_organization_project_idx on public.source_snapshots(organization_id, project_id, created_at);

insert into public.source_snapshots (
  organization_id, project_id, project_source_id, source_identity_hash, created_at
)
select source.organization_id, source.project_id, source.id,
  encode(digest(
    octet_length(source.source_type)::text || ':' || source.source_type || ':' ||
    octet_length(source.source_url)::text || ':' || source.source_url,
    'sha256'
  ), 'hex'),
  source.created_at
from public.project_sources source;

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_snapshot_id uuid not null references public.source_snapshots(id) on delete restrict,
  analysis_run_id uuid unique references public.analysis_runs(id) on delete restrict,
  status text not null check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  current_phase text not null check (current_phase in (
    'analysis', 'preflight', 'ownership', 'browser_auth', 'explore', 'propose', 'review_wait',
    'controlled_mutation_verification', 'compile', 'candidate_verify', 'publish', 'install_verify'
  )),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  version bigint not null default 0 check (version >= 0),
  next_event_sequence bigint not null default 1 check (next_event_sequence > 0),
  cancel_requested_at timestamptz,
  cancelled_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cancelled_at is null or cancel_requested_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null),
  unique (id, project_id, organization_id),
  foreign key (source_snapshot_id, project_id, organization_id)
    references public.source_snapshots(id, project_id, organization_id),
  foreign key (project_id, organization_id) references public.projects(id, organization_id)
);

create unique index workflow_runs_one_active_per_project_idx
  on public.workflow_runs(project_id) where status in ('queued', 'running', 'waiting');
create index workflow_runs_organization_project_idx on public.workflow_runs(organization_id, project_id, created_at);

create table private.workflow_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  phase text not null check (phase in (
    'analysis', 'preflight', 'ownership', 'browser_auth', 'explore', 'propose', 'review_wait',
    'controlled_mutation_verification', 'compile', 'candidate_verify', 'publish', 'install_verify'
  )),
  status text not null check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  idempotency_key text not null check (idempotency_key ~ '^wft_[0-9a-f]{64}$'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  output_hash text check (output_hash is null or output_hash ~ '^[0-9a-f]{64}$'),
  checkpoint_reference text check (checkpoint_reference is null or checkpoint_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  output_reference text check (output_reference is null or output_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  wait_key_hash text check (wait_key_hash is null or wait_key_hash ~ '^[0-9a-f]{64}$'),
  wait_reason text check (wait_reason is null or wait_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  wait_expires_at timestamptz,
  resumed_at timestamptz,
  cancel_requested_at timestamptz,
  cancelled_at timestamptz,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 3),
  max_attempts integer not null default 3 check (max_attempts = 3),
  retry_classification text check (retry_classification is null or retry_classification in ('transient', 'rate_limited', 'permanent')),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  available_at timestamptz not null default now(),
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_run_id, phase),
  unique (workflow_run_id, idempotency_key),
  unique (id, workflow_run_id),
  unique (id, workflow_run_id, project_id, organization_id),
  check ((status = 'running') = (lease_owner is not null and lease_expires_at is not null)),
  check (status <> 'waiting' or (wait_key_hash is not null and wait_reason is not null and wait_expires_at is not null)),
  check (status <> 'cancelled' or cancelled_at is not null),
  foreign key (workflow_run_id, project_id, organization_id)
    references public.workflow_runs(id, project_id, organization_id)
);

create index workflow_tasks_claim_idx on private.workflow_tasks(available_at, created_at, id)
  where status = 'queued';
create index workflow_tasks_lease_idx on private.workflow_tasks(lease_expires_at, id)
  where status = 'running';
create index workflow_tasks_fair_claim_idx on private.workflow_tasks(organization_id, available_at, created_at, id)
  where status = 'queued';

create table public.workflow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  task_id uuid references private.workflow_tasks(id) on delete set null,
  sequence bigint not null check (sequence > 0),
  version bigint not null check (version > 0),
  event_type text not null check (event_type in (
    'workflow.created', 'workflow.completed', 'workflow.failed', 'workflow.cancel_requested',
    'workflow.cancelled', 'workflow.reconciled', 'task.created', 'task.claimed', 'task.heartbeat',
    'task.completed', 'task.retry_scheduled', 'task.failed', 'task.waiting', 'task.resumed',
    'task.cancelled', 'task.reconciled'
  )),
  code text check (code is null or code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 4096),
  created_at timestamptz not null default now(),
  unique (workflow_run_id, sequence),
  unique (workflow_run_id, version),
  foreign key (workflow_run_id, project_id, organization_id)
    references public.workflow_runs(id, project_id, organization_id),
  foreign key (task_id, workflow_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id)
);

create index workflow_events_organization_run_idx on public.workflow_events(organization_id, workflow_run_id, sequence);

create table public.workflow_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  task_id uuid not null references private.workflow_tasks(id) on delete restrict,
  evidence_id uuid,
  reference text not null check (reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (workflow_run_id, evidence_id),
  unique (workflow_run_id, reference),
  foreign key (workflow_run_id, project_id, organization_id)
    references public.workflow_runs(id, project_id, organization_id),
  foreign key (task_id, workflow_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id),
  foreign key (evidence_id, project_id, organization_id)
    references public.analysis_evidence(id, project_id, organization_id)
);

-- Legacy analysis evidence is retention-bounded. The immutable workflow link
-- keeps its content-addressed reference after that row expires, while this
-- trigger detaches only the database pointer before the tenant-bound FK is
-- checked. A composite ON DELETE SET NULL would also null the non-null tenant
-- columns and is therefore intentionally not used.
create function private.detach_retained_workflow_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  update public.workflow_evidence
  set evidence_id = null
  where evidence_id = old.id
    and project_id = old.project_id
    and organization_id = old.organization_id;
  return old;
end
$$;

revoke all on function private.detach_retained_workflow_evidence() from public;

create trigger detach_retained_workflow_evidence
before delete on public.analysis_evidence
for each row execute function private.detach_retained_workflow_evidence();

create table public.capability_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  task_id uuid not null references private.workflow_tasks(id) on delete restrict,
  capability_id uuid not null references public.capabilities(id) on delete restrict,
  plan_digest text not null check (plan_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (workflow_run_id, capability_id),
  unique (workflow_run_id, plan_digest),
  foreign key (workflow_run_id, project_id, organization_id)
    references public.workflow_runs(id, project_id, organization_id),
  foreign key (task_id, workflow_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id),
  foreign key (capability_id, project_id, organization_id)
    references public.capabilities(id, project_id, organization_id)
);

create table public.verification_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  task_id uuid not null references private.workflow_tasks(id) on delete restrict,
  verification_run_id uuid references public.verification_runs(id) on delete restrict,
  check_name text not null check (check_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  status text not null check (status in ('pending', 'passed', 'failed', 'cancelled')),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  output_hash text check (output_hash is null or output_hash ~ '^[0-9a-f]{64}$'),
  evidence_reference text check (evidence_reference is null or evidence_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_run_id, check_name),
  foreign key (workflow_run_id, project_id, organization_id)
    references public.workflow_runs(id, project_id, organization_id),
  foreign key (task_id, workflow_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id),
  foreign key (verification_run_id, project_id, organization_id)
    references public.verification_runs(id, project_id, organization_id)
);

create table public.installations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  task_id uuid not null references private.workflow_tasks(id) on delete restrict,
  release_id uuid not null references public.releases(id) on delete restrict,
  target_origin text not null check (target_origin ~ '^https://[^/?#]+$'),
  artifact_content_hash text not null check (artifact_content_hash ~ '^[0-9a-f]{64}$'),
  integrity text not null check (integrity ~ '^sha384-[A-Za-z0-9+/]+={0,2}$'),
  status text not null check (status in ('pending', 'verified', 'failed', 'removed')),
  installed_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_run_id, release_id),
  foreign key (workflow_run_id, project_id, organization_id)
    references public.workflow_runs(id, project_id, organization_id),
  foreign key (task_id, workflow_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id),
  foreign key (release_id, project_id, organization_id)
    references public.releases(id, project_id, organization_id)
);

create table private.workflow_commands (
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  task_id uuid references private.workflow_tasks(id) on delete cascade,
  command_scope text not null check (command_scope ~ '^[a-z][a-z0-9_:-]{0,127}$'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (octet_length(result::text) <= 65536),
  created_at timestamptz not null default now(),
  primary key (workflow_run_id, command_scope, idempotency_key),
  foreign key (task_id, workflow_run_id)
    references private.workflow_tasks(id, workflow_run_id)
);

create function private.workflow_next_phase(target_phase text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case target_phase
    when 'preflight' then 'ownership'
    when 'ownership' then 'browser_auth'
    when 'browser_auth' then 'explore'
    when 'explore' then 'propose'
    when 'propose' then 'review_wait'
    when 'review_wait' then 'controlled_mutation_verification'
    when 'controlled_mutation_verification' then 'compile'
    when 'compile' then 'candidate_verify'
    when 'candidate_verify' then 'publish'
    when 'publish' then 'install_verify'
    else null
  end
$$;

revoke all on function private.workflow_next_phase(text) from public;
grant execute on function private.workflow_next_phase(text) to page2webmcp_app, page2webmcp_worker;

create function private.enforce_workflow_run_phase()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    if (new.analysis_run_id is null and new.current_phase <> 'preflight')
      or (new.analysis_run_id is not null and new.current_phase <> 'analysis') then
      raise exception 'illegal initial workflow run phase %', new.current_phase using errcode = '23514';
    end if;
    return new;
  end if;
  if old.current_phase <> new.current_phase then
    if old.current_phase = 'analysis'
      or private.workflow_next_phase(old.current_phase) is distinct from new.current_phase then
      raise exception 'illegal workflow run phase transition % -> %', old.current_phase, new.current_phase
        using errcode = '23514';
    end if;
    if not exists (
      select 1 from private.workflow_tasks predecessor
      where predecessor.workflow_run_id = old.id
        and predecessor.phase = old.current_phase
        and predecessor.status = 'succeeded'
    ) then
      raise exception 'workflow run phase requires succeeded predecessor %', old.current_phase using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

create function private.enforce_workflow_task_phase()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  target_run public.workflow_runs;
  predecessor private.workflow_tasks;
begin
  if tg_op = 'UPDATE' then
    if old.workflow_run_id <> new.workflow_run_id or old.organization_id <> new.organization_id
      or old.project_id <> new.project_id or old.phase <> new.phase
      or old.idempotency_key <> new.idempotency_key or old.input_hash <> new.input_hash then
      raise exception 'workflow task phase identity is immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  select * into target_run from public.workflow_runs where id = new.workflow_run_id;
  if target_run.id is null then
    raise exception 'workflow task run not found' using errcode = '23503';
  end if;
  if target_run.analysis_run_id is not null then
    if new.phase <> 'analysis' or target_run.current_phase <> 'analysis' then
      raise exception 'legacy analysis workflow requires analysis task' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.status <> 'queued' then
    raise exception 'generic workflow task must start queued' using errcode = '23514';
  end if;
  if new.phase = 'preflight' then
    if target_run.current_phase <> 'preflight' or exists (
      select 1 from private.workflow_tasks existing where existing.workflow_run_id = target_run.id
    ) then
      raise exception 'preflight must be the first workflow task' using errcode = '23514';
    end if;
    return new;
  end if;
  select * into predecessor
  from private.workflow_tasks candidate
  where candidate.workflow_run_id = target_run.id
    and private.workflow_next_phase(candidate.phase) = new.phase
  limit 1;
  if predecessor.id is null or predecessor.status <> 'succeeded'
    or target_run.current_phase <> new.phase
    or predecessor.output_hash is distinct from new.input_hash then
    raise exception 'workflow task phase requires succeeded predecessor %', new.phase using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function private.enforce_workflow_run_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.status <> new.status and not (
    (old.status = 'queued' and new.status in ('running', 'waiting', 'succeeded', 'failed', 'cancelled')) or
    (old.status = 'running' and new.status in ('queued', 'waiting', 'succeeded', 'failed', 'cancelled')) or
    (old.status = 'waiting' and new.status in ('queued', 'failed', 'cancelled'))
  ) then
    raise exception 'illegal workflow run transition % -> %', old.status, new.status using errcode = '23514';
  end if;
  if new.version < old.version or new.next_event_sequence < old.next_event_sequence then
    raise exception 'workflow counters cannot move backwards' using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function private.enforce_workflow_task_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.status <> new.status and not (
    (old.status = 'queued' and new.status in ('running', 'failed', 'cancelled')) or
    (old.status = 'running' and new.status in ('queued', 'waiting', 'succeeded', 'failed', 'cancelled')) or
    (old.status = 'waiting' and new.status in ('queued', 'failed', 'cancelled'))
  ) then
    raise exception 'illegal workflow task transition % -> %', old.status, new.status using errcode = '23514';
  end if;
  if new.lease_generation < old.lease_generation or new.attempts < old.attempts then
    raise exception 'workflow task counters cannot move backwards' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger enforce_workflow_run_transition
before update on public.workflow_runs
for each row execute function private.enforce_workflow_run_transition();

create trigger enforce_workflow_run_phase
before insert or update on public.workflow_runs
for each row execute function private.enforce_workflow_run_phase();

create trigger enforce_workflow_task_transition
before update on private.workflow_tasks
for each row execute function private.enforce_workflow_task_transition();

create trigger enforce_workflow_task_phase
before insert or update on private.workflow_tasks
for each row execute function private.enforce_workflow_task_phase();

create or replace function private.append_workflow_event(
  target_workflow_run_id uuid,
  target_task_id uuid,
  target_event_type text,
  target_code text default null
)
returns public.workflow_events
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  target_run public.workflow_runs;
  inserted public.workflow_events;
begin
  update public.workflow_runs
  set version = version + 1,
      next_event_sequence = next_event_sequence + 1,
      updated_at = now()
  where id = target_workflow_run_id
  returning * into target_run;
  if target_run.id is null then
    raise exception 'workflow run not found' using errcode = '23503';
  end if;
  insert into public.workflow_events (
    organization_id, project_id, workflow_run_id, task_id, sequence, version, event_type, code
  ) values (
    target_run.organization_id, target_run.project_id, target_run.id, target_task_id,
    target_run.next_event_sequence - 1, target_run.version, target_event_type, target_code
  ) returning * into inserted;
  return inserted;
end
$$;

revoke all on function private.enforce_workflow_run_transition() from public;
revoke all on function private.enforce_workflow_task_transition() from public;
revoke all on function private.append_workflow_event(uuid, uuid, text, text) from public;
grant execute on function private.append_workflow_event(uuid, uuid, text, text)
  to page2webmcp_app, page2webmcp_worker;

-- Backfill a compatibility workflow/task for every existing analysis run.
insert into public.workflow_runs (
  id, organization_id, project_id, source_snapshot_id, analysis_run_id, status,
  current_phase, input_hash, version, next_event_sequence, cancel_requested_at,
  cancelled_at, error_code, created_at, updated_at
)
select analysis.id, analysis.organization_id, analysis.project_id, snapshot.id, analysis.id,
  analysis.status, 'analysis', encode(digest('legacy-analysis:' || analysis.id::text, 'sha256'), 'hex'),
  0, 1,
  case when analysis.status = 'cancelled' then analysis.updated_at else null end,
  case when analysis.status = 'cancelled' then analysis.updated_at else null end,
  case
    when analysis.error_code ~ '^[A-Z][A-Z0-9_]{0,63}$' then analysis.error_code
    when analysis.status = 'failed' then 'LEGACY_ANALYSIS_FAILED'
    else null
  end,
  analysis.created_at, analysis.updated_at
from public.analysis_runs analysis
join public.project_sources source on source.project_id = analysis.project_id and source.active
join public.source_snapshots snapshot on snapshot.project_source_id = source.id;

insert into private.workflow_tasks (
  organization_id, project_id, workflow_run_id, phase, status, idempotency_key, input_hash,
  output_hash, cancel_requested_at, cancelled_at, lease_generation, lease_owner,
  lease_expires_at, attempts, retry_classification, error_code, available_at, created_at, updated_at
)
select analysis.organization_id, analysis.project_id, analysis.id, 'analysis', job.status,
  'wft_' || encode(digest(
    length(analysis.id::text)::text || ':' || analysis.id::text || ':' ||
    length('analysis')::text || ':analysis:' || workflow.input_hash,
    'sha256'
  ), 'hex'),
  workflow.input_hash, case when job.status = 'succeeded' then encode(digest(
    'legacy-analysis-result:' || analysis.id::text || ':' || coalesce(analysis.release_hash, 'diagnostic-only'),
    'sha256'
  ), 'hex') else null end,
  case when job.status = 'cancelled' then job.updated_at else null end,
  case when job.status = 'cancelled' then job.updated_at else null end,
  job.attempts, job.lease_owner, job.lease_expires_at, job.attempts,
  case when job.status = 'failed' then 'permanent' else null end,
  case
    when analysis.error_code ~ '^[A-Z][A-Z0-9_]{0,63}$' then analysis.error_code
    when job.status = 'failed' then 'LEGACY_ANALYSIS_FAILED'
    else null
  end,
  job.available_at, job.created_at, job.updated_at
from public.analysis_runs analysis
join public.workflow_runs workflow on workflow.analysis_run_id = analysis.id
join private.analysis_jobs job on job.analysis_run_id = analysis.id;

select private.append_workflow_event(workflow.id, null, 'workflow.created', null)
from public.workflow_runs workflow;
select private.append_workflow_event(workflow.id, task.id, 'task.created', null)
from public.workflow_runs workflow
join private.workflow_tasks task on task.workflow_run_id = workflow.id;
select private.append_workflow_event(workflow.id, task.id, 'task.claimed', null)
from public.workflow_runs workflow
join private.workflow_tasks task on task.workflow_run_id = workflow.id
where task.status = 'running';
select private.append_workflow_event(workflow.id, task.id, 'task.completed', null)
from public.workflow_runs workflow
join private.workflow_tasks task on task.workflow_run_id = workflow.id
where task.status = 'succeeded';
select private.append_workflow_event(workflow.id, null, 'workflow.completed', null)
from public.workflow_runs workflow
where workflow.status = 'succeeded';
select private.append_workflow_event(workflow.id, task.id, 'task.failed', task.error_code)
from public.workflow_runs workflow
join private.workflow_tasks task on task.workflow_run_id = workflow.id
where task.status = 'failed';
select private.append_workflow_event(workflow.id, null, 'workflow.failed', workflow.error_code)
from public.workflow_runs workflow
where workflow.status = 'failed';
select private.append_workflow_event(workflow.id, null, 'workflow.cancel_requested', null)
from public.workflow_runs workflow
where workflow.status = 'cancelled';
select private.append_workflow_event(workflow.id, task.id, 'task.cancelled', null)
from public.workflow_runs workflow
join private.workflow_tasks task on task.workflow_run_id = workflow.id
where task.status = 'cancelled';
select private.append_workflow_event(workflow.id, null, 'workflow.cancelled', null)
from public.workflow_runs workflow
where workflow.status = 'cancelled';

insert into public.workflow_evidence (
  organization_id, project_id, workflow_run_id, task_id, evidence_id, reference, created_at
)
select evidence.organization_id, evidence.project_id, evidence.analysis_run_id, task.id,
  evidence.id, evidence.reference, evidence.created_at
from public.analysis_evidence evidence
join private.workflow_tasks task
  on task.workflow_run_id = evidence.analysis_run_id and task.phase = 'analysis';

insert into public.capability_plans (
  organization_id, project_id, workflow_run_id, task_id, capability_id, plan_digest, created_at
)
select capability.organization_id, capability.project_id, capability.analysis_run_id, task.id,
  capability.id, capability.plan_digest, capability.created_at
from public.capabilities capability
join private.workflow_tasks task
  on task.workflow_run_id = capability.analysis_run_id and task.phase = 'analysis';

alter table public.project_sources enable row level security;
alter table public.project_sources force row level security;
alter table public.source_snapshots enable row level security;
alter table public.source_snapshots force row level security;
alter table public.workflow_runs enable row level security;
alter table public.workflow_runs force row level security;
alter table private.workflow_tasks enable row level security;
alter table private.workflow_tasks force row level security;
alter table public.workflow_events enable row level security;
alter table public.workflow_events force row level security;
alter table public.workflow_evidence enable row level security;
alter table public.workflow_evidence force row level security;
alter table public.capability_plans enable row level security;
alter table public.capability_plans force row level security;
alter table public.verification_checks enable row level security;
alter table public.verification_checks force row level security;
alter table public.installations enable row level security;
alter table public.installations force row level security;
alter table private.workflow_commands enable row level security;
alter table private.workflow_commands force row level security;

create policy "app updates workflow project status" on public.projects for update to page2webmcp_app
using (private.context_member(organization_id, array['owner', 'editor']))
with check (private.context_member(organization_id, array['owner', 'editor']));
create policy "worker updates workflow project status" on public.projects for update to page2webmcp_worker
using (true) with check (true);

create policy "app reads project sources" on public.project_sources for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app creates project sources" on public.project_sources for insert to page2webmcp_app
with check (private.context_member(organization_id, array['owner', 'editor']));
create policy "app reads source snapshots" on public.source_snapshots for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app creates source snapshots" on public.source_snapshots for insert to page2webmcp_app
with check (private.context_member(organization_id, array['owner', 'editor']));

create policy "app reads workflow runs" on public.workflow_runs for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app creates workflow runs" on public.workflow_runs for insert to page2webmcp_app
with check (private.context_member(organization_id, array['owner', 'editor']));
create policy "app updates workflow cancellation" on public.workflow_runs for update to page2webmcp_app
using (private.context_member(organization_id, array['owner', 'editor']))
with check (private.context_member(organization_id, array['owner', 'editor']));
create policy "worker manages workflow runs" on public.workflow_runs for all to page2webmcp_worker
using (true) with check (true);

create policy "app reads workflow tasks" on private.workflow_tasks for select to page2webmcp_app
using (organization_id = private.context_organization_id());
create policy "app creates workflow tasks" on private.workflow_tasks for insert to page2webmcp_app
with check (organization_id = private.context_organization_id());
create policy "app updates scoped workflow tasks" on private.workflow_tasks for update to page2webmcp_app
using (organization_id = private.context_organization_id())
with check (organization_id = private.context_organization_id());
create policy "worker manages workflow tasks" on private.workflow_tasks for all to page2webmcp_worker
using (true) with check (true);
create policy "app cancels own organization analysis jobs" on private.analysis_jobs for update to page2webmcp_app
using (organization_id = private.context_organization_id())
with check (organization_id = private.context_organization_id());

create policy "app reads workflow events" on public.workflow_events for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "app creates workflow events" on public.workflow_events for insert to page2webmcp_app
with check (private.context_member(organization_id, array['owner', 'editor']));
create policy "worker creates workflow events" on public.workflow_events for insert to page2webmcp_worker
with check (true);
create policy "worker reads workflow events" on public.workflow_events for select to page2webmcp_worker
using (true);

create policy "app reads workflow evidence" on public.workflow_evidence for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "worker creates workflow evidence" on public.workflow_evidence for insert to page2webmcp_worker
with check (true);
create policy "app reads capability plans" on public.capability_plans for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "worker creates capability plans" on public.capability_plans for insert to page2webmcp_worker
with check (true);
create policy "app reads verification checks" on public.verification_checks for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "worker manages verification checks" on public.verification_checks for all to page2webmcp_worker
using (true) with check (true);
create policy "app reads installations" on public.installations for select to page2webmcp_app
using (private.context_member(organization_id));
create policy "worker manages installations" on public.installations for all to page2webmcp_worker
using (true) with check (true);

create policy "app manages workflow commands" on private.workflow_commands for all to page2webmcp_app
using (exists (
  select 1 from public.workflow_runs run
  where run.id = workflow_commands.workflow_run_id
    and run.organization_id = private.context_organization_id()
)) with check (exists (
  select 1 from public.workflow_runs run
  where run.id = workflow_commands.workflow_run_id
    and run.organization_id = private.context_organization_id()
));
create policy "worker manages workflow commands" on private.workflow_commands for all to page2webmcp_worker
using (true) with check (true);

revoke all on public.project_sources, public.source_snapshots, public.workflow_runs,
  public.workflow_events, public.workflow_evidence, public.capability_plans,
  public.verification_checks, public.installations
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
revoke all on private.workflow_tasks, private.workflow_commands
  from page2webmcp_app, page2webmcp_worker;

grant select, insert on public.project_sources, public.source_snapshots to page2webmcp_app;
grant update (status) on public.projects to page2webmcp_app, page2webmcp_worker;
grant select, insert, update (status, current_phase, version, next_event_sequence, cancel_requested_at, cancelled_at, error_code, updated_at)
  on public.workflow_runs to page2webmcp_app;
grant select, insert on public.workflow_events to page2webmcp_app;
grant select on public.workflow_evidence, public.capability_plans, public.verification_checks, public.installations
  to page2webmcp_app;
grant select, insert,
  update (status, wait_key_hash, wait_reason, wait_expires_at, resumed_at, cancel_requested_at,
    cancelled_at, lease_owner, lease_expires_at, available_at, updated_at)
  on private.workflow_tasks to page2webmcp_app;
grant update (status, lease_owner, lease_expires_at, updated_at) on private.analysis_jobs to page2webmcp_app;
grant select, insert, update, delete on private.workflow_commands to page2webmcp_app;

grant select, insert, update on public.workflow_runs to page2webmcp_worker;
grant select, insert, update on private.workflow_tasks to page2webmcp_worker;
grant select, insert on public.workflow_events, public.workflow_evidence, public.capability_plans to page2webmcp_worker;
grant select, insert, update on public.verification_checks, public.installations to page2webmcp_worker;
grant select, insert, update, delete on private.workflow_commands to page2webmcp_worker;

comment on table private.workflow_tasks is
  'Authoritative generic workflow tasks. Updates here never invoke sync_analysis_job_state; only private.analysis_jobs projects legacy analysis state.';
