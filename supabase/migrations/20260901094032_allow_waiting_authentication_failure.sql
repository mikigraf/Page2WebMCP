begin;

alter table private.website_authentication_checkpoints
  drop constraint website_authentication_checkpoints_check4,
  add constraint website_authentication_terminal_evidence_check check (
    (state <> 'completed' or (
      authentication_evidence_reference is not null
      and consumed_at is not null
      and terminal_at is not null
    ))
    and (state <> 'failed' or (
      terminal_at is not null
      and (
        authentication_evidence_reference is null
          and consumed_at is null
          and resume_idempotency_key is null
          and resume_input_hash is null
        or authentication_evidence_reference is not null
          and consumed_at is not null
          and resume_idempotency_key is not null
          and resume_input_hash is not null
      )
    ))
  );

-- A failed authentication gateway result terminates a still-waiting handoff.
-- Keep every immutable binding and evidence monotonicity rule from the original
-- guard; this adds only the missing waiting -> failed edge used by the durable
-- control-plane termination transaction.
create or replace function private.enforce_website_authentication_checkpoint_transition()
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
    (old.state = 'waiting' and new.state in ('consumed', 'failed', 'cancelled', 'expired')) or
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

revoke all on function private.enforce_website_authentication_checkpoint_transition()
  from public, anon, authenticated, service_role, page2webmcp_maintenance;
grant execute on function private.enforce_website_authentication_checkpoint_transition()
  to page2webmcp_app, page2webmcp_worker;

grant update (error_code, retry_classification)
  on private.workflow_tasks to page2webmcp_app;
grant update (error_code, updated_at)
  on public.analysis_runs to page2webmcp_app;

create policy "app records terminal website authentication diagnostics"
on public.analysis_runs for update to page2webmcp_app
using (
  status = 'failed'
  and private.context_member(analysis_runs.organization_id, array['owner', 'editor'])
  and exists (
    select 1
    from private.website_authentication_checkpoints checkpoint
    where checkpoint.analysis_run_id = analysis_runs.id
      and checkpoint.organization_id = analysis_runs.organization_id
      and checkpoint.project_id = analysis_runs.project_id
      and checkpoint.state in ('failed', 'expired')
  )
)
with check (
  status = 'failed'
  and private.context_member(analysis_runs.organization_id, array['owner', 'editor'])
  and exists (
    select 1
    from private.website_authentication_checkpoints checkpoint
    where checkpoint.analysis_run_id = analysis_runs.id
      and checkpoint.organization_id = analysis_runs.organization_id
      and checkpoint.project_id = analysis_runs.project_id
      and checkpoint.state in ('failed', 'expired')
  )
);

alter function private.selected_release_readiness_topology(text)
  rename to selected_release_readiness_topology_legacy_20260901092107;
revoke all on function private.selected_release_readiness_topology_legacy_20260901092107(text)
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
      ('20260901071658'),
      ('20260901090842'),
      ('20260901092107'),
      ('20260901094032')
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
  ), transition_guard as (
    select count(*) = 1
      and bool_and(
        not procedure_row.prosecdef
        and position(
          '(old.state = ''waiting'' and new.state in (''consumed'', ''failed'', ''cancelled'', ''expired''))'
          in pg_get_functiondef(procedure_row.oid)
        ) > 0
        and not has_function_privilege('anon', procedure_row.oid, 'execute')
        and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
        and not has_function_privilege('service_role', procedure_row.oid, 'execute')
        and not has_function_privilege('page2webmcp_maintenance', procedure_row.oid, 'execute')
        and has_function_privilege('page2webmcp_app', procedure_row.oid, 'execute')
        and has_function_privilege('page2webmcp_worker', procedure_row.oid, 'execute')
        and exists (
          select 1
          from pg_catalog.pg_trigger trigger_row
          join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
          join pg_catalog.pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
          where trigger_row.tgfoid = procedure_row.oid
            and trigger_row.tgname = 'enforce_website_authentication_checkpoint_transition'
            and trigger_row.tgenabled = 'O'
            and not trigger_row.tgisinternal
            and relation_namespace.nspname = 'private'
            and relation.relname = 'website_authentication_checkpoints'
        )
      ) as verified
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace procedure_namespace on procedure_namespace.oid = procedure_row.pronamespace
    where procedure_namespace.nspname = 'private'
      and procedure_row.proname = 'enforce_website_authentication_checkpoint_transition'
      and procedure_row.pronargs = 0
  ), terminal_authorization_guard as (
    select
      has_column_privilege('page2webmcp_app', 'private.workflow_tasks', 'error_code', 'update')
      and has_column_privilege('page2webmcp_app', 'private.workflow_tasks', 'retry_classification', 'update')
      and has_column_privilege('page2webmcp_app', 'public.analysis_runs', 'error_code', 'update')
      and has_column_privilege('page2webmcp_app', 'public.analysis_runs', 'updated_at', 'update')
      and exists (
        select 1
        from pg_catalog.pg_policy policy_row
        join pg_catalog.pg_class relation on relation.oid = policy_row.polrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'analysis_runs'
          and policy_row.polname = 'app records terminal website authentication diagnostics'
          and policy_row.polcmd = 'w'
          and 'page2webmcp_app'::regrole::oid = any(policy_row.polroles)
      ) as verified
  ), terminal_evidence_guard as (
    select exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'private'
        and relation.relname = 'website_authentication_checkpoints'
        and constraint_row.conname = 'website_authentication_terminal_evidence_check'
        and constraint_row.contype = 'c'
    ) as verified
  ), legacy as (
    select *
    from private.selected_release_readiness_topology_legacy_20260901092107(selected_hash)
  )
  select
    (select current from migration_state),
    legacy.rls_verified
      and coalesce((select verified from transition_guard), false)
      and coalesce((select verified from terminal_authorization_guard), false)
      and coalesce((select verified from terminal_evidence_guard), false),
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
