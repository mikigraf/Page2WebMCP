begin;

alter table public.analysis_runs
  drop constraint analysis_runs_status_check,
  add constraint analysis_runs_status_check
    check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'));

alter table private.analysis_jobs
  drop constraint analysis_jobs_status_check,
  add constraint analysis_jobs_status_check
    check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'));

-- The private queue remains authoritative for the compatibility run. A human
-- authentication wait is active work, so its project remains analyzing while
-- both public and private run records expose the durable waiting boundary.
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
    when 'waiting' then 'analyzing'
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

create table private.website_authentication_checkpoints (
  analysis_run_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  workflow_task_id uuid not null,
  source_snapshot_id uuid not null,
  source_identity_hash text not null check (source_identity_hash ~ '^[0-9a-f]{64}$'),
  target_origin_digest text not null check (target_origin_digest ~ '^[0-9a-f]{64}$'),
  checkpoint_reference text not null unique
    check (checkpoint_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  authentication_evidence_reference text
    check (authentication_evidence_reference is null
      or authentication_evidence_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  state text not null check (state in ('waiting', 'consumed', 'completed', 'failed', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  wait_idempotency_key text not null
    check (wait_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  wait_input_hash text not null check (wait_input_hash ~ '^[0-9a-f]{64}$'),
  resume_idempotency_key text
    check (resume_idempotency_key is null
      or resume_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  resume_input_hash text check (resume_input_hash is null or resume_input_hash ~ '^[0-9a-f]{64}$'),
  consumed_at timestamptz,
  terminal_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check ((resume_idempotency_key is null) = (resume_input_hash is null)),
  check (state <> 'waiting' or (
    authentication_evidence_reference is null and consumed_at is null
    and terminal_at is null and resume_idempotency_key is null
  )),
  check (state <> 'consumed' or (
    authentication_evidence_reference is not null and consumed_at is not null and terminal_at is null
  )),
  check (state not in ('completed', 'failed') or (
    authentication_evidence_reference is not null and consumed_at is not null and terminal_at is not null
  )),
  check (state not in ('cancelled', 'expired') or terminal_at is not null),
  check (consumed_at is null or consumed_at between created_at and updated_at),
  check (terminal_at is null or terminal_at between created_at and updated_at),
  foreign key (analysis_run_id, project_id, organization_id)
    references public.analysis_runs(id, project_id, organization_id) on delete cascade,
  foreign key (workflow_task_id, analysis_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id) on delete cascade,
  foreign key (source_snapshot_id, project_id, organization_id)
    references public.source_snapshots(id, project_id, organization_id) on delete restrict
);

create index website_authentication_checkpoints_workflow_task_idx
  on private.website_authentication_checkpoints(workflow_task_id, analysis_run_id, project_id, organization_id);
create index website_authentication_checkpoints_source_snapshot_idx
  on private.website_authentication_checkpoints(source_snapshot_id, project_id, organization_id);
create index website_authentication_checkpoints_active_expiry_idx
  on private.website_authentication_checkpoints(expires_at, analysis_run_id)
  where state in ('waiting', 'consumed');

create function private.enforce_website_authentication_checkpoint_transition()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if old.analysis_run_id <> new.analysis_run_id
    or old.organization_id <> new.organization_id
    or old.project_id <> new.project_id
    or old.workflow_task_id <> new.workflow_task_id
    or old.source_snapshot_id <> new.source_snapshot_id
    or old.source_identity_hash <> new.source_identity_hash
    or old.target_origin_digest <> new.target_origin_digest
    or old.checkpoint_reference <> new.checkpoint_reference
    or old.expires_at <> new.expires_at
    or old.wait_idempotency_key <> new.wait_idempotency_key
    or old.wait_input_hash <> new.wait_input_hash
    or old.created_at <> new.created_at then
    raise exception 'website authentication checkpoint binding is immutable' using errcode = '23514';
  end if;

  if old.state <> new.state and not (
    (old.state = 'waiting' and new.state in ('consumed', 'cancelled', 'expired')) or
    (old.state = 'consumed' and new.state in ('completed', 'failed', 'cancelled', 'expired'))
  ) then
    raise exception 'illegal website authentication checkpoint transition % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if new.updated_at < old.updated_at
    or old.authentication_evidence_reference is not null
      and old.authentication_evidence_reference is distinct from new.authentication_evidence_reference
    or old.consumed_at is not null and old.consumed_at is distinct from new.consumed_at
    or old.terminal_at is not null and old.terminal_at is distinct from new.terminal_at
    or old.resume_idempotency_key is not null
      and old.resume_idempotency_key is distinct from new.resume_idempotency_key
    or old.resume_input_hash is not null and old.resume_input_hash is distinct from new.resume_input_hash then
    raise exception 'website authentication checkpoint evidence cannot move backwards' using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function private.enforce_website_authentication_checkpoint_transition() from public;
revoke all on function private.enforce_website_authentication_checkpoint_transition()
  from anon, authenticated, service_role, page2webmcp_maintenance;
grant execute on function private.enforce_website_authentication_checkpoint_transition()
  to page2webmcp_app, page2webmcp_worker;

create trigger enforce_website_authentication_checkpoint_transition
before update on private.website_authentication_checkpoints
for each row execute function private.enforce_website_authentication_checkpoint_transition();

alter table private.website_authentication_checkpoints enable row level security;
alter table private.website_authentication_checkpoints force row level security;

create policy "worker manages website authentication checkpoints"
on private.website_authentication_checkpoints for all to page2webmcp_worker
using (true) with check (true);
create policy "app reads website authentication checkpoints"
on private.website_authentication_checkpoints for select to page2webmcp_app
using (organization_id = private.context_organization_id());
create policy "app resumes website authentication checkpoints"
on private.website_authentication_checkpoints for update to page2webmcp_app
using (
  organization_id = private.context_organization_id()
  and private.context_member(organization_id, array['owner', 'editor'])
) with check (
  organization_id = private.context_organization_id()
  and private.context_member(organization_id, array['owner', 'editor'])
);

revoke all on private.website_authentication_checkpoints
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;
grant select,
  update (state, authentication_evidence_reference, resume_idempotency_key,
    resume_input_hash, consumed_at, terminal_at, updated_at)
  on private.website_authentication_checkpoints to page2webmcp_app;
grant select, insert,
  update (state, terminal_at, updated_at)
  on private.website_authentication_checkpoints to page2webmcp_worker;
grant update (available_at) on private.analysis_jobs to page2webmcp_app;

-- Keep production readiness tied to the exact forward ledger and include the
-- new private table in the forced-RLS proof without duplicating artifact facts.
alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901060852;
revoke all on function private.selected_release_readiness_topology_legacy_20260901060852(text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;

create function private.selected_release_readiness_topology(selected_hash text)
returns table (
  migrations_current boolean,
  rls_verified boolean,
  local_openapi_release boolean,
  local_website_release boolean,
  local_github_release boolean,
  hosted_openapi_release boolean,
  hosted_website_release boolean,
  hosted_github_release boolean
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if selected_hash is null or not (selected_hash ~ '^[0-9a-f]{64}$') then
    raise exception 'selected release hash is invalid' using errcode = '22023';
  end if;

  return query
  with required_migrations(version) as (
    values
      ('20260826000000'),
      ('20260829074144'),
      ('20260829090000'),
      ('20260829092023'),
      ('20260829094207'),
      ('20260829100000'),
      ('20260830094622'),
      ('20260830120000'),
      ('20260830160000'),
      ('20260830180000'),
      ('20260830190000'),
      ('20260831090000'),
      ('20260831100000'),
      ('20260831110000'),
      ('20260831111000'),
      ('20260831120000'),
      ('20260831211329'),
      ('20260901000000'),
      ('20260901010000'),
      ('20260901020000'),
      ('20260901030000'),
      ('20260901040000'),
      ('20260901060852'),
      ('20260901071658')
  ), applied_migrations(version) as (
    select migration.version::text
    from supabase_migrations.schema_migrations migration
  ), migration_state as (
    select
      (select count(*) = count(distinct version) from applied_migrations)
      and coalesce(
        (select array_agg(version order by version) from applied_migrations),
        array[]::text[]
      ) = (select array_agg(version order by version) from required_migrations) as current
  ), checkpoint_security as (
    select
      relation.relrowsecurity
      and relation.relforcerowsecurity
      and not exists (
        select 1
        from information_schema.role_table_grants grant_row
        where grant_row.table_schema = 'private'
          and grant_row.table_name = 'website_authentication_checkpoints'
          and grant_row.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role', 'page2webmcp_maintenance')
      ) as verified
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'private'
      and relation.relname = 'website_authentication_checkpoints'
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901060852(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and coalesce((select verified from checkpoint_security), false),
    legacy.local_openapi_release,
    legacy.local_website_release,
    legacy.local_github_release,
    legacy.hosted_openapi_release,
    legacy.hosted_website_release,
    legacy.hosted_github_release
  from legacy;
end;
$$;

revoke all on function private.selected_release_readiness_topology(text)
  from public, anon, authenticated, service_role, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_release_readiness_topology(text)
  to page2webmcp_maintenance;

commit;
