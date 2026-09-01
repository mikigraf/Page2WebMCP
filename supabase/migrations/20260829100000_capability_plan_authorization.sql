begin;

alter table public.capabilities
  add column plan jsonb,
  add column plan_digest text,
  add column reviewed_plan_digest text,
  add constraint capabilities_plan_digest_check
    check (plan_digest is null or plan_digest ~ '^[0-9a-f]{64}$'),
  add constraint capabilities_reviewed_plan_digest_check
    check (reviewed_plan_digest is null or reviewed_plan_digest ~ '^[0-9a-f]{64}$'),
  add constraint capabilities_plan_binding_presence_check
    check ((plan is null) = (plan_digest is null)),
  add constraint capabilities_review_requires_plan_check
    check (reviewed_plan_digest is null or plan_digest is not null);

alter table public.capability_reviews
  add column plan_digest text,
  add constraint capability_reviews_plan_digest_check
    check (plan_digest is null or plan_digest ~ '^[0-9a-f]{64}$');

alter table public.analysis_evidence
  add column content text,
  add column reference text,
  drop constraint analysis_evidence_source_check,
  add constraint analysis_evidence_source_check
    check (source in ('runtime', 'openapi', 'github', 'owner_review', 'source')),
  add constraint analysis_evidence_reference_check
    check (reference is null or reference ~ '^urn:sha256:[0-9a-f]{64}$'),
  add constraint analysis_evidence_binding_presence_check
    check ((content is null) = (reference is null));

create unique index analysis_evidence_run_reference_key
  on public.analysis_evidence(analysis_run_id, reference)
  where reference is not null;

create function private.lock_current_analysis_evidence_rows(
  target_organization_id uuid,
  target_project_id uuid,
  target_analysis_run_id uuid
)
returns table (
  id uuid,
  organization_id uuid,
  project_id uuid,
  analysis_run_id uuid,
  source text,
  content text,
  reference text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if target_organization_id is distinct from private.context_organization_id()
    or not private.context_member(target_organization_id, array['owner']) then
    raise exception 'current actor cannot lock analysis evidence'
      using errcode = '42501';
  end if;

  return query
  select evidence.id, evidence.organization_id, evidence.project_id, evidence.analysis_run_id,
    evidence.source, evidence.content, evidence.reference, evidence.expires_at
  from public.analysis_evidence as evidence
  where evidence.organization_id = target_organization_id
    and evidence.project_id = target_project_id
    and evidence.analysis_run_id = target_analysis_run_id
    and evidence.expires_at > pg_catalog.statement_timestamp()
  order by evidence.reference
  for key share of evidence;
end
$$;

revoke all on function private.lock_current_analysis_evidence_rows(uuid, uuid, uuid) from public;
grant execute on function private.lock_current_analysis_evidence_rows(uuid, uuid, uuid) to page2webmcp_app;

grant update (reviewed_plan_digest) on public.capabilities to page2webmcp_app;

commit;
