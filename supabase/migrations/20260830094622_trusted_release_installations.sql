create or replace function private.valid_release_verification_checks(value jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  item_name text;
  item_status text;
  item_code text;
  names text[] := '{}';
  expected_names constant text[] := array[
    'authentication', 'cancellation', 'confirmation', 'final_state',
    'no_control_plane_or_model_calls', 'origin', 'read', 'replay_idempotency',
    'reversible_mutation', 'schema', 'secret_leakage', 'tool_selection', 'trusted_loader'
  ];
  allowed_codes constant text[] := array[
    'LOGGED_OUT', 'FORBIDDEN', 'STALE_PAGE', 'DEADLINE_EXCEEDED', 'INVALID_OUTPUT',
    'WRONG_STATE', 'DUPLICATE_REGISTRATION', 'ORIGIN_MISMATCH', 'WEBMCP_UNAVAILABLE',
    'TRUSTED_LOADER_REQUIRED', 'SECRET_LEAKAGE', 'CONTROL_PLANE_REQUEST', 'MODEL_REQUEST', 'CANCELLED'
  ];
begin
  if jsonb_typeof(value) <> 'array' or jsonb_array_length(value) <> 13 then
    return false;
  end if;
  for item in select element from jsonb_array_elements(value) as elements(element) loop
    if jsonb_typeof(item) <> 'object'
      or exists (select 1 from jsonb_object_keys(item) as keys(key) where key not in ('name', 'status', 'code')) then
      return false;
    end if;
    item_name := item->>'name';
    item_status := item->>'status';
    item_code := item->>'code';
    if not item_name = any(expected_names) or item_name = any(names)
      or item_status not in ('passed', 'failed')
      or (item_status = 'passed' and item ? 'code')
      or (item_status = 'failed' and (item_code is null or not item_code = any(allowed_codes))) then
      return false;
    end if;
    names := array_append(names, item_name);
  end loop;
  return names @> expected_names and expected_names @> names;
end
$$;

revoke all on function private.valid_release_verification_checks(jsonb) from public, anon, authenticated,
  page2webmcp_worker;
grant execute on function private.valid_release_verification_checks(jsonb) to page2webmcp_app;

create or replace function private.valid_release_csp_result(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'object'
    and octet_length(value::text) <= 1024
    and value->>'hosted' in ('allowed', 'blocked')
    and not exists (
      select 1 from jsonb_object_keys(value) as keys(key)
      where key not in ('hosted', 'directive')
    )
    and (not value ? 'directive' or
      (octet_length(value->>'directive') <= 512 and value->>'directive' !~ '[\r\n]'));
$$;

revoke all on function private.valid_release_csp_result(jsonb) from public, anon, authenticated,
  page2webmcp_worker;
grant execute on function private.valid_release_csp_result(jsonb) to page2webmcp_app;

alter table public.verification_runs
  add column checks jsonb,
  add column csp_result jsonb,
  add column verification_mode text;

alter table public.verification_runs drop constraint verification_runs_eligibility_check;

update public.verification_runs
set checks = '[
  {"name":"authentication","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"cancellation","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"confirmation","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"final_state","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"no_control_plane_or_model_calls","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"origin","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"read","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"replay_idempotency","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"reversible_mutation","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"schema","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"secret_leakage","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"tool_selection","status":"failed","code":"INVALID_OUTPUT"},
  {"name":"trusted_loader","status":"failed","code":"TRUSTED_LOADER_REQUIRED"}
]'::jsonb,
    csp_result = '{"hosted":"blocked","directive":"trusted reverification required"}'::jsonb,
    verification_mode = 'live',
    eligible = false,
    failures = array_append(failures, 'MIGRATION_TRUSTED_REVERIFY_REQUIRED')
where checks is null;

alter table public.verification_runs
  alter column checks set not null,
  alter column csp_result set not null,
  alter column verification_mode set not null,
  add constraint verification_runs_checks_valid_check
    check (private.valid_release_verification_checks(checks)),
  add constraint verification_runs_csp_result_check check (private.valid_release_csp_result(csp_result)),
  add constraint verification_runs_verification_mode_check check (verification_mode in ('live', 'hermetic'));

alter table public.verification_runs
  add constraint verification_runs_eligibility_check check (eligible = (
    schema_valid
    and authenticated
    and replay_passes >= 3
    and no_secret_leakage
    and browser_execution
    and selection_score >= 18
    and capability_state_digest <> repeat('0', 64)
    and candidate_content_hash <> repeat('0', 64)
    and not checks @? '$[*] ? (@.status == "failed")'
  ));

alter table public.releases
  add constraint releases_id_project_org_key unique (id, project_id, organization_id);

create table public.release_installations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  release_id uuid not null references public.releases(id) on delete restrict,
  actor_id uuid not null references auth.users(id),
  page_url text not null check (octet_length(page_url) between 9 and 2048
    and page_url ~ '^https://[^@/?#]+(?:/[^?#]*)?$'),
  artifact_url text not null check (octet_length(artifact_url) between 9 and 2048
    and artifact_url ~ '^https://[^@/?#]+/[^?#]+$'),
  self_hosted_url text check (self_hosted_url is null or
    (octet_length(self_hosted_url) between 9 and 2048 and self_hosted_url ~ '^https://[^@/?#]+/[^?#]+$')),
  target_origin text not null check (target_origin ~ '^https://[^/?#]+$'),
  artifact_content_hash text not null check (artifact_content_hash ~ '^[0-9a-f]{64}$'),
  integrity text not null check (integrity ~ '^sha384-[A-Za-z0-9+/]+={0,2}$'),
  expected_tools jsonb not null check (jsonb_typeof(expected_tools) = 'array'
    and jsonb_array_length(expected_tools) between 1 and 100 and octet_length(expected_tools::text) <= 8192),
  status text not null constraint release_installations_status_value_check
    check (status in ('pending_self_host', 'verified', 'failed')),
  delivery text not null check (delivery in ('hosted', 'self_hosted')),
  csp_status text not null check (csp_status in ('allowed', 'blocked')),
  csp_directive text check (csp_directive is null or
    (octet_length(csp_directive) <= 512 and csp_directive !~ '[\r\n]')),
  webmcp_implementation text not null check (webmcp_implementation in ('native', 'compatibility_shim')),
  attestation jsonb not null check (jsonb_typeof(attestation) = 'object'
    and octet_length(attestation::text) <= 16384),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  constraint release_installations_release_tenant_fk
    foreign key (release_id, project_id, organization_id)
    references public.releases(id, project_id, organization_id),
  constraint release_installations_actor_membership_fk
    foreign key (organization_id, actor_id)
    references public.memberships(organization_id, user_id),
  constraint release_installations_status_check check (
    (status = 'verified' and verified_at is not null and webmcp_implementation = 'native')
    or (status <> 'verified' and verified_at is null)
  ),
  unique (organization_id, actor_id, idempotency_key)
);

create unique index release_installations_exact_release_idx
  on public.release_installations (organization_id, project_id, release_id);
create index release_installations_release_id_idx on public.release_installations (release_id);
create index release_installations_actor_id_idx on public.release_installations (actor_id);

alter table public.release_installations enable row level security;
alter table public.release_installations force row level security;

create policy "owners read release installations"
on public.release_installations for select to page2webmcp_app
using (private.context_member(organization_id, array['owner']));
create policy "owners create release installations"
on public.release_installations for insert to page2webmcp_app
with check (
  organization_id = private.context_organization_id()
  and actor_id = private.context_actor_id()
  and private.context_member(organization_id, array['owner'])
  and exists (
    select 1 from public.releases release
    where release.id = release_installations.release_id
      and release.project_id = release_installations.project_id
      and release.organization_id = release_installations.organization_id
      and release.content_hash = release_installations.artifact_content_hash
      and release.sri = release_installations.integrity
      and release.allowed_origin = release_installations.target_origin
      and release.status = 'published'
      and release_installations.expected_tools = (
        select jsonb_agg(to_jsonb(plan->'tool'->>'name') order by (plan->'tool'->>'name') collate "C")
        from jsonb_array_elements(release.manifest->'plans') as plans(plan)
      )
  )
);

revoke all on public.release_installations from anon, authenticated, page2webmcp_worker;
revoke all on public.release_installations from page2webmcp_app;
grant select, insert on public.release_installations to page2webmcp_app;
