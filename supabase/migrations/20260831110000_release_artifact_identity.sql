-- Persist only the immutable identity returned by the release artifact store.
-- Legacy rows remain readable with an all-null identity and cannot be installed.
alter table public.releases
  add column artifact_url text,
  add column download_url text,
  add column local_only boolean;

alter table public.releases
  add constraint releases_artifact_identity_check check (
    (artifact_url is null and download_url is null and local_only is null)
    or (
      artifact_url is not null and download_url is not null and local_only is not null
      and octet_length(artifact_url) between 1 and 2048
      and octet_length(download_url) between 1 and 2048
      and download_url = artifact_url || '?download=page2webmcp-' || content_hash || '.js'
      and (
        (not local_only and artifact_url =
          'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || content_hash || '.js')
        or
        (local_only and artifact_url =
          'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/' || content_hash || '.js')
      )
    )
  );

-- Existing all-null releases remain readable, but every new application
-- publication must carry the producer-owned immutable Storage identity.
drop policy "owners create releases" on public.releases;
create policy "owners create releases"
on public.releases for insert to page2webmcp_app
with check (
  private.context_member(organization_id, array['owner'])
  and artifact_url is not null
  and download_url is not null
  and local_only is not null
  and exists (
    select 1 from public.verification_runs vr
    where vr.analysis_run_id = releases.analysis_run_id
      and vr.project_id = releases.project_id
      and vr.organization_id = releases.organization_id
      and vr.capability_state_digest = releases.capability_state_digest
      and vr.candidate_content_hash = releases.content_hash
      and vr.eligible
  )
);

-- The old constraint admitted arbitrary HTTPS artifact URLs. New observations
-- may name only one of the two canonical immutable artifact locations. NOT
-- VALID preserves legacy observations while enforcing the check on new rows.
alter table public.release_installations
  drop constraint release_installations_artifact_url_check,
  add constraint release_installations_artifact_url_check check (
    artifact_url =
      'https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/' || artifact_content_hash || '.js'
    or artifact_url =
      'http://127.0.0.1:54321/storage/v1/object/public/page2webmcp-releases/' || artifact_content_hash || '.js'
  ) not valid;

alter table public.release_installations
  add constraint release_installations_delivery_csp_check check (
    (status <> 'pending_self_host'
      or (delivery = 'hosted' and csp_status = 'blocked' and self_hosted_url is null))
    and (status <> 'verified'
      or (delivery = 'hosted' and csp_status = 'allowed' and self_hosted_url is null)
      or (delivery = 'self_hosted' and self_hosted_url is not null))
  ) not valid;

-- Installation attempts are immutable evidence. A hosted CSP observation and
-- a later exact self-host proof use distinct idempotency keys and rows.
drop index public.release_installations_exact_release_idx;

drop policy "owners create release installations" on public.release_installations;
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
      and release.artifact_url is not null
      and release.download_url is not null
      and release.local_only is not null
      and release.artifact_url = release_installations.artifact_url
      and release.status = 'published'
      and release_installations.expected_tools = (
        select jsonb_agg(to_jsonb(plan->'tool'->>'name') order by (plan->'tool'->>'name') collate "C")
        from jsonb_array_elements(release.manifest->'plans') as plans(plan)
      )
  )
);
