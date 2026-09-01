do $$
declare
  selected_candidate uuid;
begin
  if (select count(*) from private.selected_native_installation_proof(repeat('1', 64))) <> 0 then
    raise exception 'upgraded proof still spliced complementary installation rows';
  end if;

  select candidate_verification_run_id into selected_candidate
  from private.selected_native_installation_proof(repeat('2', 64));
  if selected_candidate is distinct from '91000000-0000-4000-8000-000000000042'::uuid then
    raise exception 'newer invalid duplicate-hash release hid the valid older proof';
  end if;
end;
$$;

delete from public.release_installations
where project_id in (
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000003'
);
delete from public.releases
where project_id in (
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000003'
);
delete from public.projects
where id in (
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000003'
);
