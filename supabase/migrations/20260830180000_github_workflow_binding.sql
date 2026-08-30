-- Bind a generic GitHub workflow to the exact completed, reviewed analysis
-- whose canonical plans authorize its source-native mutation.

alter table public.workflow_runs
  add column reviewed_analysis_run_id uuid,
  add constraint workflow_runs_reviewed_analysis_project_org_fkey
    foreign key (reviewed_analysis_run_id, project_id, organization_id)
    references public.analysis_runs(id, project_id, organization_id) on delete restrict;

create index workflow_runs_reviewed_analysis_idx
  on public.workflow_runs(reviewed_analysis_run_id)
  where reviewed_analysis_run_id is not null;

create policy "worker reads workflow project sources"
on public.project_sources for select to page2webmcp_worker
using (exists (
  select 1
  from public.source_snapshots snapshot
  join public.workflow_runs run on run.source_snapshot_id = snapshot.id
  where snapshot.project_source_id = project_sources.id
));

create policy "worker reads workflow source snapshots"
on public.source_snapshots for select to page2webmcp_worker
using (exists (
  select 1 from public.workflow_runs run where run.source_snapshot_id = source_snapshots.id
));

create policy "worker reads reviewed workflow analysis evidence"
on public.analysis_evidence for select to page2webmcp_worker
using (exists (
  select 1 from public.workflow_runs run
  where run.reviewed_analysis_run_id = analysis_evidence.analysis_run_id
    and run.project_id = analysis_evidence.project_id
    and run.organization_id = analysis_evidence.organization_id
));

create policy "worker reads reviewed workflow capabilities"
on public.capabilities for select to page2webmcp_worker
using (exists (
  select 1 from public.workflow_runs run
  where run.reviewed_analysis_run_id = capabilities.analysis_run_id
    and run.project_id = capabilities.project_id
    and run.organization_id = capabilities.organization_id
));

grant select on public.project_sources, public.source_snapshots to page2webmcp_worker;
grant select on public.analysis_evidence, public.capabilities to page2webmcp_worker;
