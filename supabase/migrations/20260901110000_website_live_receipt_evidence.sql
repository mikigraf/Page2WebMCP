begin;

create table private.website_live_receipt_evidence (
  analysis_run_id uuid primary key,
  organization_id uuid not null,
  project_id uuid not null,
  workflow_task_id uuid not null,
  source_snapshot_id uuid not null,
  source_identity_hash text not null check (source_identity_hash ~ '^[0-9a-f]{64}$'),
  target_origin_digest text not null check (target_origin_digest ~ '^[0-9a-f]{64}$'),
  checkpoint_reference text not null
    check (checkpoint_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  checkpoint_expires_at timestamptz not null,
  ownership_decision_digest text not null
    check (ownership_decision_digest ~ '^[0-9a-f]{64}$'),
  provider_session_identity_digest text not null
    check (provider_session_identity_digest ~ '^[0-9a-f]{64}$'),
  browser_use_api_version text not null check (browser_use_api_version = 'v4'),
  browser_use_model text not null check (browser_use_model = 'browser-use-2.0'),
  browser_use_adapter text not null check (browser_use_adapter = 'browser-use-v4'),
  browser_use_adapter_version integer not null check (browser_use_adapter_version = 4),
  browser_policy_digest text not null check (browser_policy_digest ~ '^[0-9a-f]{64}$'),
  browser_lease_identity_digest text not null check (browser_lease_identity_digest ~ '^[0-9a-f]{64}$'),
  browser_lease_expires_at timestamptz not null,
  egress_policy_reference_digest text not null check (egress_policy_reference_digest ~ '^[0-9a-f]{64}$'),
  egress_policy_digest text not null check (egress_policy_digest ~ '^[0-9a-f]{64}$'),
  cdp_reference_digest text not null check (cdp_reference_digest ~ '^[0-9a-f]{64}$'),
  public_evidence_reference text not null
    check (public_evidence_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  ttl_secret_references jsonb not null,
  suspended_worker_identity_digest text not null
    check (suspended_worker_identity_digest ~ '^[0-9a-f]{64}$'),
  suspended_lease_generation bigint not null check (suspended_lease_generation > 0),
  suspended_at timestamptz not null default now(),
  authentication_evidence_reference_digest text
    check (authentication_evidence_reference_digest is null
      or authentication_evidence_reference_digest ~ '^[0-9a-f]{64}$'),
  authentication_consumed_at timestamptz,
  resumed_worker_identity_digest text
    check (resumed_worker_identity_digest is null
      or resumed_worker_identity_digest ~ '^[0-9a-f]{64}$'),
  resume_lease_generation bigint check (resume_lease_generation is null or resume_lease_generation > 0),
  resume_claimed_at timestamptz,
  result_checkpoint_hash text
    check (result_checkpoint_hash is null or result_checkpoint_hash ~ '^[0-9a-f]{64}$'),
  result_checkpoint_output_reference text
    check (result_checkpoint_output_reference is null
      or result_checkpoint_output_reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  result_checkpoint_worker_identity_digest text
    check (result_checkpoint_worker_identity_digest is null
      or result_checkpoint_worker_identity_digest ~ '^[0-9a-f]{64}$'),
  result_checkpoint_lease_generation bigint
    check (result_checkpoint_lease_generation is null or result_checkpoint_lease_generation > 0),
  result_checkpointed_at timestamptz,
  completion_worker_identity_digest text
    check (completion_worker_identity_digest is null
      or completion_worker_identity_digest ~ '^[0-9a-f]{64}$'),
  completion_lease_generation bigint
    check (completion_lease_generation is null or completion_lease_generation > 0),
  resume_acknowledged_at timestamptz,
  restart_verified boolean not null default false,
  cleanup_resources jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(ttl_secret_references) = 'array'
    and jsonb_array_length(ttl_secret_references) = 2
    and octet_length(ttl_secret_references::text) <= 4096),
  check (jsonb_typeof(cleanup_resources) = 'array'
    and jsonb_array_length(cleanup_resources) = 7
    and octet_length(cleanup_resources::text) <= 16384),
  check (checkpoint_expires_at = browser_lease_expires_at),
  check ((authentication_evidence_reference_digest is null) = (authentication_consumed_at is null)),
  check ((resumed_worker_identity_digest is null) = (resume_lease_generation is null)
    and (resumed_worker_identity_digest is null) = (resume_claimed_at is null)),
  check ((result_checkpoint_hash is null) = (result_checkpoint_output_reference is null)
    and (result_checkpoint_hash is null) = (result_checkpoint_worker_identity_digest is null)
    and (result_checkpoint_hash is null) = (result_checkpoint_lease_generation is null)
    and (result_checkpoint_hash is null) = (result_checkpointed_at is null)),
  check ((completion_worker_identity_digest is null) = (completion_lease_generation is null)
    and (completion_worker_identity_digest is null) = (resume_acknowledged_at is null)),
  check (resume_acknowledged_at is null or (resume_claimed_at is not null and result_checkpointed_at is not null)),
  check (not restart_verified or (resume_acknowledged_at is not null
    and completion_worker_identity_digest <> suspended_worker_identity_digest)),
  check (updated_at >= created_at and suspended_at between created_at and updated_at),
  foreign key (analysis_run_id, project_id, organization_id)
    references public.analysis_runs(id, project_id, organization_id) on delete cascade,
  foreign key (workflow_task_id, analysis_run_id, project_id, organization_id)
    references private.workflow_tasks(id, workflow_run_id, project_id, organization_id) on delete cascade,
  foreign key (source_snapshot_id, project_id, organization_id)
    references public.source_snapshots(id, project_id, organization_id) on delete restrict,
  foreign key (analysis_run_id)
    references private.website_authentication_checkpoints(analysis_run_id) on delete cascade
);

create index website_live_receipt_evidence_selected_idx
  on private.website_live_receipt_evidence(analysis_run_id, source_snapshot_id, project_id, organization_id);

create function private.enforce_website_live_receipt_evidence_monotonic()
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
    or old.checkpoint_expires_at <> new.checkpoint_expires_at
    or old.ownership_decision_digest <> new.ownership_decision_digest
    or old.provider_session_identity_digest <> new.provider_session_identity_digest
    or old.browser_use_api_version <> new.browser_use_api_version
    or old.browser_use_model <> new.browser_use_model
    or old.browser_use_adapter <> new.browser_use_adapter
    or old.browser_use_adapter_version <> new.browser_use_adapter_version
    or old.browser_policy_digest <> new.browser_policy_digest
    or old.browser_lease_identity_digest <> new.browser_lease_identity_digest
    or old.browser_lease_expires_at <> new.browser_lease_expires_at
    or old.egress_policy_reference_digest <> new.egress_policy_reference_digest
    or old.egress_policy_digest <> new.egress_policy_digest
    or old.cdp_reference_digest <> new.cdp_reference_digest
    or old.public_evidence_reference <> new.public_evidence_reference
    or old.ttl_secret_references <> new.ttl_secret_references
    or old.suspended_worker_identity_digest <> new.suspended_worker_identity_digest
    or old.suspended_lease_generation <> new.suspended_lease_generation
    or old.suspended_at <> new.suspended_at
    or old.created_at <> new.created_at then
    raise exception 'website live receipt suspension binding is immutable' using errcode = '23514';
  end if;

  if new.updated_at < old.updated_at
    or old.authentication_evidence_reference_digest is not null
      and old.authentication_evidence_reference_digest is distinct from new.authentication_evidence_reference_digest
    or old.authentication_consumed_at is not null
      and old.authentication_consumed_at is distinct from new.authentication_consumed_at
    or old.resumed_worker_identity_digest is not null
      and old.resumed_worker_identity_digest is distinct from new.resumed_worker_identity_digest
    or old.resume_lease_generation is not null
      and old.resume_lease_generation is distinct from new.resume_lease_generation
    or old.resume_claimed_at is not null and old.resume_claimed_at is distinct from new.resume_claimed_at
    or old.result_checkpoint_hash is not null
      and old.result_checkpoint_hash is distinct from new.result_checkpoint_hash
    or old.result_checkpoint_output_reference is not null
      and old.result_checkpoint_output_reference is distinct from new.result_checkpoint_output_reference
    or old.result_checkpoint_worker_identity_digest is not null
      and old.result_checkpoint_worker_identity_digest is distinct from new.result_checkpoint_worker_identity_digest
    or old.result_checkpoint_lease_generation is not null
      and old.result_checkpoint_lease_generation is distinct from new.result_checkpoint_lease_generation
    or old.result_checkpointed_at is not null
      and old.result_checkpointed_at is distinct from new.result_checkpointed_at
    or old.completion_worker_identity_digest is not null
      and old.completion_worker_identity_digest is distinct from new.completion_worker_identity_digest
    or old.completion_lease_generation is not null
      and old.completion_lease_generation is distinct from new.completion_lease_generation
    or old.resume_acknowledged_at is not null
      and old.resume_acknowledged_at is distinct from new.resume_acknowledged_at
    or old.restart_verified and not new.restart_verified
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(old.cleanup_resources) old_item
      where old_item->>'disposition' not in ('pending', 'failed')
        and not new.cleanup_resources @> pg_catalog.jsonb_build_array(old_item)
    ) then
    raise exception 'website live receipt evidence cannot move backwards' using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function private.enforce_website_live_receipt_evidence_monotonic()
  from public, anon, authenticated, service_role, page2webmcp_app, page2webmcp_maintenance;
grant execute on function private.enforce_website_live_receipt_evidence_monotonic()
  to page2webmcp_worker;

create trigger enforce_website_live_receipt_evidence_monotonic
before update on private.website_live_receipt_evidence
for each row execute function private.enforce_website_live_receipt_evidence_monotonic();

-- The application can advance only the already-consumed human-authentication
-- digest through this exact tenant/member-bound transition. It receives no
-- table privilege and the raw checkpoint evidence never leaves this function.
create function private.record_website_authentication_evidence(
  target_analysis_run_id uuid,
  target_organization_id uuid,
  target_evidence_digest text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  checkpoint_evidence_reference text;
  checkpoint_consumed_at timestamptz;
  stored_digest text;
  stored_consumed_at timestamptz;
begin
  if target_evidence_digest is null or not (target_evidence_digest ~ '^[0-9a-f]{64}$')
    or private.context_organization_id() is distinct from target_organization_id
    or not private.context_member(target_organization_id, array['owner', 'editor']) then
    raise exception 'website authentication evidence transition forbidden' using errcode = '42501';
  end if;

  select checkpoint.authentication_evidence_reference, checkpoint.consumed_at
  into checkpoint_evidence_reference, checkpoint_consumed_at
  from private.website_authentication_checkpoints checkpoint
  where checkpoint.analysis_run_id = target_analysis_run_id
    and checkpoint.organization_id = target_organization_id
    and checkpoint.state = 'consumed'
  for update;

  if checkpoint_evidence_reference is null or checkpoint_consumed_at is null
    or pg_catalog.encode(extensions.digest(checkpoint_evidence_reference, 'sha256'), 'hex')
      <> target_evidence_digest then
    return false;
  end if;

  update private.website_live_receipt_evidence evidence
  set authentication_evidence_reference_digest = target_evidence_digest,
      authentication_consumed_at = checkpoint_consumed_at,
      updated_at = checkpoint_consumed_at
  where evidence.analysis_run_id = target_analysis_run_id
    and evidence.organization_id = target_organization_id
    and evidence.authentication_evidence_reference_digest is null;

  select evidence.authentication_evidence_reference_digest, evidence.authentication_consumed_at
  into stored_digest, stored_consumed_at
  from private.website_live_receipt_evidence evidence
  where evidence.analysis_run_id = target_analysis_run_id
    and evidence.organization_id = target_organization_id;

  return stored_digest = target_evidence_digest and stored_consumed_at = checkpoint_consumed_at;
end;
$$;

revoke all on function private.record_website_authentication_evidence(uuid, uuid, text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.record_website_authentication_evidence(uuid, uuid, text)
  to page2webmcp_app;

alter table private.website_live_receipt_evidence enable row level security;
alter table private.website_live_receipt_evidence force row level security;

create policy "worker manages leased website live receipt evidence"
on private.website_live_receipt_evidence for all to page2webmcp_worker
using (
  workflow_task_id::text = current_setting('page2webmcp.workflow_task_id', true)
  and (
    exists (
      select 1 from private.workflow_tasks task
      where task.id = website_live_receipt_evidence.workflow_task_id
        and task.workflow_run_id = website_live_receipt_evidence.analysis_run_id
        and task.phase = 'analysis'
        and private.worker_has_active_workflow_lease(task.workflow_run_id)
    )
    or exists (
      select 1 from private.website_authentication_checkpoints checkpoint
      where checkpoint.analysis_run_id = website_live_receipt_evidence.analysis_run_id
        and checkpoint.workflow_task_id = website_live_receipt_evidence.workflow_task_id
        and checkpoint.cleanup_status = 'running'
        and checkpoint.cleanup_lease_owner = current_setting('page2webmcp.worker_id', true)
        and checkpoint.cleanup_lease_generation =
          nullif(current_setting('page2webmcp.lease_generation', true), '')::bigint
        and checkpoint.cleanup_lease_expires_at > now()
    )
  )
) with check (
  workflow_task_id::text = current_setting('page2webmcp.workflow_task_id', true)
  and (
    exists (
      select 1 from private.workflow_tasks task
      where task.id = website_live_receipt_evidence.workflow_task_id
        and task.workflow_run_id = website_live_receipt_evidence.analysis_run_id
        and task.phase = 'analysis'
        and private.worker_has_active_workflow_lease(task.workflow_run_id)
    )
    or exists (
      select 1 from private.website_authentication_checkpoints checkpoint
      where checkpoint.analysis_run_id = website_live_receipt_evidence.analysis_run_id
        and checkpoint.workflow_task_id = website_live_receipt_evidence.workflow_task_id
        and checkpoint.cleanup_status = 'running'
        and checkpoint.cleanup_lease_owner = current_setting('page2webmcp.worker_id', true)
        and checkpoint.cleanup_lease_generation =
          nullif(current_setting('page2webmcp.lease_generation', true), '')::bigint
        and checkpoint.cleanup_lease_expires_at > now()
    )
  )
);

revoke all on private.website_live_receipt_evidence
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;
grant select, insert,
  update (authentication_evidence_reference_digest, authentication_consumed_at,
    resumed_worker_identity_digest, resume_lease_generation, resume_claimed_at,
    result_checkpoint_hash, result_checkpoint_output_reference,
    result_checkpoint_worker_identity_digest, result_checkpoint_lease_generation, result_checkpointed_at,
    completion_worker_identity_digest, completion_lease_generation,
    resume_acknowledged_at, restart_verified, cleanup_resources, updated_at)
  on private.website_live_receipt_evidence to page2webmcp_worker;

-- Result checkpoint completion must prove that the exact task-linked evidence
-- still exists after a lease is recovered. The worker may read only links for
-- its currently active workflow task and generation.
drop policy if exists "worker reads exact leased workflow evidence"
  on public.workflow_evidence;
create policy "worker reads exact leased workflow evidence"
on public.workflow_evidence for select to page2webmcp_worker
using (
  task_id::text = current_setting('page2webmcp.workflow_task_id', true)
  and private.worker_has_active_workflow_lease(workflow_run_id)
);

create function private.selected_website_live_receipt_evidence(selected_hash text)
returns table (
  selected_release_hash text,
  analysis_run_identity_digest text,
  source_snapshot_identity_digest text,
  source_identity_hash text,
  target_origin_digest text,
  ownership_decision_digest text,
  provider_session_identity_digest text,
  browser_use_api_version text,
  browser_use_model text,
  browser_use_adapter text,
  browser_use_adapter_version integer,
  browser_policy_digest text,
  browser_lease_identity_digest text,
  browser_lease_expires_at timestamptz,
  egress_policy_reference_digest text,
  egress_policy_digest text,
  cdp_reference_digest text,
  public_evidence_reference text,
  ttl_secret_digest_evidence jsonb,
  checkpoint_identity_digest text,
  checkpoint_expires_at timestamptz,
  suspended_worker_identity_digest text,
  suspended_lease_generation bigint,
  suspended_at timestamptz,
  authentication_evidence_reference_digest text,
  authentication_consumed_at timestamptz,
  resumed_worker_identity_digest text,
  resume_lease_generation bigint,
  resume_claimed_at timestamptz,
  result_checkpoint_hash text,
  result_checkpoint_output_reference text,
  result_checkpoint_worker_identity_digest text,
  result_checkpoint_lease_generation bigint,
  result_checkpointed_at timestamptz,
  completion_worker_identity_digest text,
  completion_lease_generation bigint,
  resume_acknowledged_at timestamptz,
  restart_verified boolean,
  cleanup_resources jsonb
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
  select distinct
    release.content_hash,
    pg_catalog.encode(extensions.digest(evidence.analysis_run_id::text, 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(evidence.source_snapshot_id::text, 'sha256'), 'hex'),
    evidence.source_identity_hash,
    evidence.target_origin_digest,
    evidence.ownership_decision_digest,
    evidence.provider_session_identity_digest,
    evidence.browser_use_api_version,
    evidence.browser_use_model,
    evidence.browser_use_adapter,
    evidence.browser_use_adapter_version,
    evidence.browser_policy_digest,
    evidence.browser_lease_identity_digest,
    evidence.browser_lease_expires_at,
    evidence.egress_policy_reference_digest,
    evidence.egress_policy_digest,
    evidence.cdp_reference_digest,
    evidence.public_evidence_reference,
    evidence.ttl_secret_references,
    pg_catalog.encode(extensions.digest(evidence.checkpoint_reference, 'sha256'), 'hex'),
    evidence.checkpoint_expires_at,
    evidence.suspended_worker_identity_digest,
    evidence.suspended_lease_generation,
    evidence.suspended_at,
    evidence.authentication_evidence_reference_digest,
    evidence.authentication_consumed_at,
    evidence.resumed_worker_identity_digest,
    evidence.resume_lease_generation,
    evidence.resume_claimed_at,
    evidence.result_checkpoint_hash,
    evidence.result_checkpoint_output_reference,
    evidence.result_checkpoint_worker_identity_digest,
    evidence.result_checkpoint_lease_generation,
    evidence.result_checkpointed_at,
    evidence.completion_worker_identity_digest,
    evidence.completion_lease_generation,
    evidence.resume_acknowledged_at,
    evidence.restart_verified,
    evidence.cleanup_resources
  from public.releases release
  join public.verification_runs verification
    on verification.id = release.verification_run_id
   and verification.organization_id = release.organization_id
   and verification.project_id = release.project_id
   and verification.analysis_run_id = release.analysis_run_id
   and verification.candidate_content_hash = release.content_hash
   and verification.capability_state_digest = release.capability_state_digest
  join public.analysis_runs analysis
    on analysis.id = release.analysis_run_id
   and analysis.organization_id = release.organization_id
   and analysis.project_id = release.project_id
  join public.workflow_runs workflow
    on workflow.id = analysis.id
   and workflow.analysis_run_id = analysis.id
   and workflow.organization_id = analysis.organization_id
   and workflow.project_id = analysis.project_id
  join public.source_snapshots snapshot
    on snapshot.id = workflow.source_snapshot_id
   and snapshot.organization_id = workflow.organization_id
   and snapshot.project_id = workflow.project_id
  join private.website_live_receipt_evidence evidence
    on evidence.analysis_run_id = analysis.id
   and evidence.organization_id = analysis.organization_id
   and evidence.project_id = analysis.project_id
   and evidence.source_snapshot_id = snapshot.id
   and evidence.source_identity_hash = snapshot.source_identity_hash
  join private.workflow_tasks task
    on task.id = evidence.workflow_task_id
   and task.workflow_run_id = workflow.id
   and task.organization_id = workflow.organization_id
   and task.project_id = workflow.project_id
   and task.phase = 'analysis'
  join private.website_authentication_checkpoints checkpoint
    on checkpoint.analysis_run_id = evidence.analysis_run_id
   and checkpoint.organization_id = evidence.organization_id
   and checkpoint.project_id = evidence.project_id
   and checkpoint.workflow_task_id = evidence.workflow_task_id
   and checkpoint.source_snapshot_id = evidence.source_snapshot_id
   and checkpoint.source_identity_hash = evidence.source_identity_hash
   and checkpoint.target_origin_digest = evidence.target_origin_digest
   and checkpoint.checkpoint_reference = evidence.checkpoint_reference
   and checkpoint.expires_at = evidence.checkpoint_expires_at
   and checkpoint.state = 'completed'
  where release.content_hash = selected_hash
    and release.status = 'published'
    and verification.eligible
    and analysis.provider_mode = 'website'
    and analysis.provider_adapter = 'browser-use-v4'
    and analysis.provider_adapter_version = 4
    and analysis.provider_fixture = false
    and snapshot.is_fixture = false
    and evidence.target_origin_digest =
      pg_catalog.encode(extensions.digest(release.allowed_origin, 'sha256'), 'hex')
    and evidence.result_checkpoint_output_reference = 'urn:sha256:' || release.content_hash
    and evidence.result_checkpoint_hash = task.output_hash
    and evidence.restart_verified
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(evidence.cleanup_resources) cleanup
      where cleanup->>'disposition' in ('pending', 'failed')
    );
end;
$$;

revoke all on function private.selected_website_live_receipt_evidence(text)
  from public, anon, authenticated, service_role, page2webmcp_app,
    page2webmcp_worker, page2webmcp_maintenance;
grant execute on function private.selected_website_live_receipt_evidence(text)
  to page2webmcp_maintenance;

commit;
