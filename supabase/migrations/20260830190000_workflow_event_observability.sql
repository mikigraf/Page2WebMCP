alter table public.workflow_events
  drop constraint workflow_events_event_type_check;

alter table public.workflow_events
  add constraint workflow_events_event_type_check check (event_type in (
    'workflow.created', 'workflow.completed', 'workflow.failed', 'workflow.cancel_requested',
    'workflow.cancelled', 'workflow.reconciled', 'task.created', 'task.claimed', 'task.heartbeat',
    'task.completed', 'task.retry_scheduled', 'task.failed', 'task.waiting', 'task.resumed',
    'task.cancelled', 'task.reconciled', 'task.side_effect_started',
    'task.side_effect_completed', 'task.side_effect_failed'
  ));

create function private.workflow_task_event_payload_valid(target_event_type text, target_payload jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  keys text[];
begin
  if jsonb_typeof(target_payload) <> 'object' then return false; end if;
  select coalesce(array_agg(key order by key), array[]::text[])
  into keys from jsonb_object_keys(target_payload) as key;
  if jsonb_typeof(target_payload->'operation') <> 'string'
    or jsonb_typeof(target_payload->'inputHash') <> 'string'
    or target_payload->>'operation' !~ '^[a-z][a-z0-9._:-]{0,127}$'
    or target_payload->>'inputHash' !~ '^[0-9a-f]{64}$' then return false;
  end if;
  if target_event_type = 'task.side_effect_started' then
    return keys = array['inputHash', 'operation'];
  end if;
  if jsonb_typeof(target_payload->'durationMs') <> 'number'
    or target_payload->>'durationMs' !~ '^[0-9]{1,7}$'
    or (target_payload->>'durationMs')::integer > 3600000 then return false;
  end if;
  if target_event_type = 'task.side_effect_failed' then
    return keys = array['durationMs', 'inputHash', 'operation', 'outcome']
      and target_payload->>'outcome' = 'failure';
  end if;
  if target_event_type <> 'task.side_effect_completed'
    or target_payload->>'outputHash' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(target_payload->'outputHash') <> 'string'
    or not (keys <@ array['costMicros', 'durationMs', 'inputHash', 'operation', 'outputHash', 'version'])
    or not (array['durationMs', 'inputHash', 'operation', 'outputHash'] <@ keys) then return false;
  end if;
  if target_payload ? 'version'
    and (jsonb_typeof(target_payload->'version') <> 'string'
      or target_payload->>'version' !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$') then return false;
  end if;
  if target_payload ? 'costMicros'
    and (jsonb_typeof(target_payload->'costMicros') <> 'number'
      or target_payload->>'costMicros' !~ '^[0-9]{1,10}$'
      or (target_payload->>'costMicros')::bigint > 1000000000) then return false;
  end if;
  return true;
exception when others then
  return false;
end
$$;

revoke all on function private.workflow_task_event_payload_valid(text, jsonb) from public;
grant execute on function private.workflow_task_event_payload_valid(text, jsonb)
  to page2webmcp_app, page2webmcp_worker;

alter table public.workflow_events
  add constraint workflow_events_payload_shape_check check (
    case when event_type in (
      'task.side_effect_started', 'task.side_effect_completed', 'task.side_effect_failed'
    ) then private.workflow_task_event_payload_valid(event_type, payload)
    else payload = '{}'::jsonb end
  );

create function private.enforce_workflow_side_effect_event_insert()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  leased private.workflow_tasks;
begin
  if new.event_type not in (
    'task.side_effect_started', 'task.side_effect_completed', 'task.side_effect_failed'
  ) then return new;
  end if;
  if new.task_id is null
    or current_setting('page2webmcp.workflow_task_id', true) is null
    or current_setting('page2webmcp.worker_id', true) is null
    or current_setting('page2webmcp.lease_generation', true) is null
    or new.task_id::text <> current_setting('page2webmcp.workflow_task_id', true) then
    raise exception 'workflow side effect lease context required' using errcode = '23514';
  end if;
  select * into leased from private.workflow_tasks
  where id = new.task_id and workflow_run_id = new.workflow_run_id
    and status = 'running'
    and lease_owner = current_setting('page2webmcp.worker_id', true)
    and lease_generation = current_setting('page2webmcp.lease_generation', true)::integer
    and lease_expires_at > now();
  if leased.id is null then
    raise exception 'active workflow side effect lease required' using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function private.enforce_workflow_side_effect_event_insert() from public;

create trigger enforce_workflow_side_effect_event_insert
before insert on public.workflow_events
for each row execute function private.enforce_workflow_side_effect_event_insert();

create function private.append_workflow_task_event(
  target_task_id uuid,
  target_event_type text,
  target_payload jsonb
)
returns public.workflow_events
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  target_task private.workflow_tasks;
  target_run public.workflow_runs;
  inserted public.workflow_events;
begin
  if target_event_type not in (
    'task.side_effect_started', 'task.side_effect_completed', 'task.side_effect_failed'
  ) or not private.workflow_task_event_payload_valid(target_event_type, target_payload) then
    raise exception 'invalid workflow task event' using errcode = '23514';
  end if;
  select * into target_task from private.workflow_tasks
  where id = target_task_id and status = 'running'
    and lease_owner = current_setting('page2webmcp.worker_id', true)
    and lease_generation = current_setting('page2webmcp.lease_generation', true)::integer
    and lease_expires_at > now()
  for update;
  if target_task.id is null then
    raise exception 'active workflow task lease required' using errcode = '23514';
  end if;
  update public.workflow_runs
  set version = version + 1, next_event_sequence = next_event_sequence + 1, updated_at = now()
  where id = target_task.workflow_run_id
  returning * into target_run;
  insert into public.workflow_events (
    organization_id, project_id, workflow_run_id, task_id, sequence, version,
    event_type, code, payload
  ) values (
    target_run.organization_id, target_run.project_id, target_run.id, target_task.id,
    target_run.next_event_sequence - 1, target_run.version, target_event_type, null, target_payload
  ) returning * into inserted;
  return inserted;
end
$$;

revoke all on function private.append_workflow_task_event(uuid, text, jsonb) from public;
grant execute on function private.append_workflow_task_event(uuid, text, jsonb) to page2webmcp_worker;
