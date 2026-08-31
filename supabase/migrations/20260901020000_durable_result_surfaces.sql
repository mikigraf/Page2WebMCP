begin;

-- Installation evidence is safe for every member of its owning tenant to
-- inspect. Only owners retain permission to create installation attempts.
drop policy "owners read release installations" on public.release_installations;
create policy "members read release installations"
on public.release_installations for select to page2webmcp_app
using (private.context_member(organization_id));

-- A GitHub draft PR is an externally reconciled product result, not a claim
-- inferred from a successful task. Persist one immutable observation per
-- publish/install-verification task while that exact task lease is live.
create table public.github_draft_pull_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  workflow_run_id uuid not null references public.workflow_runs(id) on delete cascade,
  task_id uuid not null references private.workflow_tasks(id) on delete restrict,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete restrict,
  source_snapshot_id uuid not null references public.source_snapshots(id) on delete restrict,
  project_source_id uuid not null references public.project_sources(id) on delete restrict,
  phase text not null check (phase in ('publish', 'install_verify')),
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null check (owner ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  repository text not null check (repository ~ '^[A-Za-z0-9._-]{1,100}$'),
  requested_ref text not null check (
    requested_ref ~ '^refs/(heads|tags)/[A-Za-z0-9][A-Za-z0-9._/-]{0,252}$'
    and requested_ref !~ '(^|/)[.][.]?(/|$)'
  ),
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  patch_digest text not null check (patch_digest ~ '^[a-f0-9]{64}$'),
  branch text not null check (branch ~ '^page2webmcp/[a-f0-9]{16}$'),
  pull_request_number integer not null check (pull_request_number > 0),
  pull_request_url text not null check (
    pull_request_url = 'https://github.com/' || owner || '/' || repository || '/pull/' || pull_request_number::text
  ),
  head_commit_sha text not null check (head_commit_sha ~ '^[a-f0-9]{40}$' and head_commit_sha <> base_commit_sha),
  draft boolean not null default true check (draft),
  merged boolean not null default false check (not merged),
  check_external_id text not null check (check_external_id ~ '^wfx_[a-f0-9]{64}$'),
  check_status text not null check (check_status in ('queued', 'in_progress', 'completed')),
  check_conclusion text check (check_conclusion is null or check_conclusion in (
    'action_required', 'cancelled', 'failure', 'neutral', 'success', 'skipped', 'stale', 'timed_out'
  )),
  sandbox_reference text not null check (sandbox_reference ~ '^urn:sha256:[a-f0-9]{64}$'),
  preview_reference text check (preview_reference is null or preview_reference ~ '^urn:sha256:[a-f0-9]{64}$'),
  side_effect_idempotency_key text not null check (side_effect_idempotency_key ~ '^wfx_[a-f0-9]{64}$'),
  side_effect_input_hash text not null check (side_effect_input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text not null check (output_hash ~ '^[a-f0-9]{64}$'),
  output_reference text not null check (output_reference = 'urn:sha256:' || output_hash),
  created_at timestamptz not null default now(),
  unique (task_id),
  unique (workflow_run_id, phase),
  foreign key (workflow_run_id, project_id, organization_id)
    references public.workflow_runs(id, project_id, organization_id) on delete cascade,
  foreign key (task_id, workflow_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id) on delete restrict,
  foreign key (analysis_run_id, project_id, organization_id)
    references public.analysis_runs(id, project_id, organization_id) on delete restrict,
  foreign key (source_snapshot_id, project_id, organization_id)
    references public.source_snapshots(id, project_id, organization_id) on delete restrict,
  foreign key (project_source_id, project_id, organization_id)
    references public.project_sources(id, project_id, organization_id) on delete restrict,
  check (phase <> 'install_verify' or (check_status = 'completed' and check_conclusion = 'success'))
);

create index github_draft_pull_requests_tenant_workflow_idx
  on public.github_draft_pull_requests(organization_id, workflow_run_id, created_at desc, id desc);
create index github_draft_pull_requests_tenant_project_idx
  on public.github_draft_pull_requests(
    organization_id, project_id, created_at desc, (phase = 'install_verify') desc, id desc
  );

alter table public.github_draft_pull_requests enable row level security;
alter table public.github_draft_pull_requests force row level security;

create policy "app reads tenant GitHub draft PRs"
on public.github_draft_pull_requests for select to page2webmcp_app
using (private.context_member(organization_id));

create policy "worker reads leased GitHub draft PRs"
on public.github_draft_pull_requests for select to page2webmcp_worker
using (
  task_id::text = current_setting('page2webmcp.workflow_task_id', true)
  and private.worker_has_active_workflow_lease(workflow_run_id)
);

create policy "worker persists leased GitHub draft PRs"
on public.github_draft_pull_requests for insert to page2webmcp_worker
with check (
  task_id::text = current_setting('page2webmcp.workflow_task_id', true)
  and private.worker_has_active_workflow_lease(workflow_run_id)
  and exists (
    select 1
    from private.workflow_tasks task
    join public.workflow_runs run
      on run.id = task.workflow_run_id
     and run.project_id = task.project_id
     and run.organization_id = task.organization_id
    join public.source_snapshots snapshot
      on snapshot.id = run.source_snapshot_id
     and snapshot.project_id = run.project_id
     and snapshot.organization_id = run.organization_id
    join public.project_sources source
      on source.id = snapshot.project_source_id
     and source.project_id = snapshot.project_id
     and source.organization_id = snapshot.organization_id
    join public.analysis_evidence evidence
      on evidence.analysis_run_id = run.reviewed_analysis_run_id
     and evidence.project_id = run.project_id
     and evidence.organization_id = run.organization_id
     and evidence.source = 'github'
    where task.id = github_draft_pull_requests.task_id
      and task.workflow_run_id = github_draft_pull_requests.workflow_run_id
      and task.project_id = github_draft_pull_requests.project_id
      and task.organization_id = github_draft_pull_requests.organization_id
      and task.phase = github_draft_pull_requests.phase
      and run.reviewed_analysis_run_id = github_draft_pull_requests.analysis_run_id
      and snapshot.id = github_draft_pull_requests.source_snapshot_id
      and source.id = github_draft_pull_requests.project_source_id
      and source.source_type = 'github'
      and source.source_url = 'https://github.com/' || github_draft_pull_requests.owner || '/'
        || github_draft_pull_requests.repository
      and evidence.reference = 'urn:sha256:' || encode(extensions.digest(evidence.content, 'sha256'), 'hex')
      and evidence.content::jsonb->>'adapter' = 'github-nextjs-source'
      and evidence.content::jsonb->>'adapterVersion' = '1'
      and evidence.content::jsonb->>'installationId' = github_draft_pull_requests.installation_id::text
      and evidence.content::jsonb->>'repositoryId' = github_draft_pull_requests.repository_id::text
      and evidence.content::jsonb->>'repository' = github_draft_pull_requests.owner || '/'
        || github_draft_pull_requests.repository
      and evidence.content::jsonb->>'requestedRef' = github_draft_pull_requests.requested_ref
      and evidence.content::jsonb->>'commitSha' = github_draft_pull_requests.base_commit_sha
  )
);

revoke all on public.github_draft_pull_requests
  from public, anon, authenticated, page2webmcp_app, page2webmcp_worker, page2webmcp_maintenance;
grant select on public.github_draft_pull_requests to page2webmcp_app;
grant select, insert on public.github_draft_pull_requests to page2webmcp_worker;

comment on table public.github_draft_pull_requests is
  'Append-only, lease-written identity of a real reconciled GitHub draft PR. It never represents merge or installation.';

-- Advance readiness to the exact complete migration set and include this new
-- user-visible result table in the forced-RLS topology proof.
alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901010000;
revoke all on function private.selected_release_readiness_topology_legacy_20260901010000(text) from public;
revoke all on function private.selected_release_readiness_topology_legacy_20260901010000(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker, page2webmcp_maintenance;

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
      ('20260901020000')
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
  ), new_rls_state as (
    select coalesce(bool_and(table_state.relrowsecurity and table_state.relforcerowsecurity), false) as current
    from pg_catalog.pg_class table_state
    join pg_catalog.pg_namespace namespace on namespace.oid = table_state.relnamespace
    where namespace.nspname = 'public' and table_state.relname = 'github_draft_pull_requests'
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901010000(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified and (select current from new_rls_state),
    legacy.local_openapi_release,
    legacy.local_website_release,
    legacy.local_github_release,
    legacy.hosted_openapi_release,
    legacy.hosted_website_release,
    legacy.hosted_github_release
  from legacy;
end;
$$;

revoke all on function private.selected_release_readiness_topology(text) from public;
revoke all on function private.selected_release_readiness_topology(text)
  from anon, authenticated, page2webmcp_app, page2webmcp_worker;
grant execute on function private.selected_release_readiness_topology(text) to page2webmcp_maintenance;

commit;
