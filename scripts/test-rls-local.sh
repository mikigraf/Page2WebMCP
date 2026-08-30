#!/usr/bin/env bash
set -euo pipefail

task_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/page2webmcp-postgres.XXXXXX")"
task_port="$((55000 + RANDOM % 1000))"
task_data_dir="$task_tmp_dir/data"
task_pg_bindir="$(pg_config --bindir)"
task_initdb="$task_pg_bindir/initdb"
task_pg_ctl="$task_pg_bindir/pg_ctl"
task_psql="$task_pg_bindir/psql"

run_typescript_test() {
  if [[ "${PAGE2WEBMCP_NATIVE_TYPESCRIPT_TESTS:-false}" == "true" ]]; then
    "${PAGE2WEBMCP_NODE_BINARY:-node}" --experimental-transform-types --test "$@"
  else
    pnpm exec tsx --test "$@"
  fi
}

cleanup() {
  "$task_pg_ctl" -D "$task_data_dir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$task_tmp_dir"
}
trap cleanup EXIT

"$task_initdb" -D "$task_data_dir" --auth=trust --no-locale >/dev/null
"$task_pg_ctl" -D "$task_data_dir" -o "-k $task_tmp_dir -p $task_port" -w start >/dev/null

"$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -c "create extension if not exists pgcrypto; create schema auth; create table auth.users (id uuid primary key, email text not null, email_confirmed_at timestamptz); create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id), not_after timestamptz); create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid'; create role anon nologin; create role authenticated nologin;"
for migration in supabase/migrations/*.sql; do
  "$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f "$migration"
  if [[ "$(basename "$migration")" == "20260826000000_page2webmcp.sql" ]]; then
    "$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f supabase/seed.sql
  fi
  if [[ "$(basename "$migration")" == "20260829074144_durable_control_plane.sql" ]]; then
    "$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -c \
      "insert into public.projects (id, organization_id, created_by, name, source_type, source_url, status)
       values ('aaaaaaaa-0000-0000-0000-0000000000ff', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
               '11111111-1111-1111-1111-111111111111', 'Migration backfill', 'openapi',
               'https://acme.example/openapi.json', 'analyzing');
       insert into public.analysis_runs (id, organization_id, project_id, requested_by, status, attempts)
       values ('aaaaaaaa-0000-0000-0000-0000000000fe', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
               'aaaaaaaa-0000-0000-0000-0000000000ff', '11111111-1111-1111-1111-111111111111', 'queued', 0);
       insert into private.analysis_jobs (analysis_run_id, organization_id)
       values ('aaaaaaaa-0000-0000-0000-0000000000fe', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');"
  fi
  if [[ "$(basename "$migration")" == "20260829092023_bounded_retention_cleanup.sql" ]]; then
    "$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -c \
      "insert into public.projects
         (id, organization_id, created_by, name, source_type, source_url, status)
       values
         ('aaaaaaaa-0000-0000-0000-0000000000fd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '11111111-1111-1111-1111-111111111111', 'Legacy unpublished verification', 'website',
          'https://acme.example', 'analyzed'),
         ('aaaaaaaa-0000-0000-0000-0000000000fa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '11111111-1111-1111-1111-111111111111', 'Legacy published verification', 'website',
          'https://acme.example', 'analyzed');
       insert into public.analysis_runs
         (id, organization_id, project_id, requested_by, status, attempts, result,
          release_code, release_hash, allowed_origin, release_manifest)
       values
         ('aaaaaaaa-0000-0000-0000-0000000000fc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-0000000000fd', '11111111-1111-1111-1111-111111111111',
          'succeeded', 1, '{}', 'legacy unpublished subset', repeat('b', 64), 'https://acme.example', '{}'),
         ('aaaaaaaa-0000-0000-0000-0000000000f9', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-0000000000fa', '11111111-1111-1111-1111-111111111111',
          'succeeded', 1, '{}', 'legacy overwritten bytes', repeat('a', 64), 'https://acme.example', '{}');
       insert into private.analysis_jobs
         (analysis_run_id, organization_id, status, attempts, source_type, source_url)
       values
         ('aaaaaaaa-0000-0000-0000-0000000000fc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'succeeded', 1, 'website', 'https://acme.example'),
         ('aaaaaaaa-0000-0000-0000-0000000000f9', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'succeeded', 1, 'website', 'https://acme.example');
       insert into public.verification_runs
         (id, organization_id, project_id, analysis_run_id, capability_state_digest,
          candidate_content_hash, schema_valid, authenticated, replay_passes,
          no_secret_leakage, browser_execution, selection_score, eligible, failures)
       values
         ('aaaaaaaa-0000-0000-0000-0000000000fb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-0000000000fd', 'aaaaaaaa-0000-0000-0000-0000000000fc',
          repeat('1', 64), repeat('b', 64), true, true, 3, true, true, 20, true, '{}'),
         ('aaaaaaaa-0000-0000-0000-0000000000f8', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-0000000000fa', 'aaaaaaaa-0000-0000-0000-0000000000f9',
          repeat('2', 64), repeat('a', 64), true, true, 3, true, true, 20, true, '{}'),
         ('aaaaaaaa-0000-0000-0000-0000000000f6', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-0000000000fa', 'aaaaaaaa-0000-0000-0000-0000000000f9',
          repeat('3', 64), repeat('c', 64), true, true, 3, true, true, 20, true, '{}');
       insert into public.releases
         (id, organization_id, project_id, analysis_run_id, capability_state_digest,
          content_hash, code, allowed_origin, manifest, sri, status)
       values
         ('aaaaaaaa-0000-0000-0000-0000000000f7', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'aaaaaaaa-0000-0000-0000-0000000000fa', 'aaaaaaaa-0000-0000-0000-0000000000f9',
          repeat('2', 64), repeat('a', 64), 'legacy published candidate',
          'https://acme.example', '{}', 'sha256-legacy', 'published');"
  fi
done
"$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -c \
  "do \$\$
   begin
     if not exists (
       select 1 from private.analysis_jobs
       where analysis_run_id = 'aaaaaaaa-0000-0000-0000-0000000000fe'
         and source_type = 'openapi'
         and source_url = 'https://acme.example/openapi.json'
     ) then
       raise exception 'hardening migration did not backfill the immutable source snapshot';
     end if;
   end
   \$\$;
   do \$\$
   begin
     if not exists (
       select 1
       from public.analysis_runs
       where id = 'aaaaaaaa-0000-0000-0000-0000000000fc'
         and status = 'failed'
         and error_code = 'MIGRATION_REANALYSIS_REQUIRED'
     ) or not exists (
       select 1
       from public.verification_runs
       where id = 'aaaaaaaa-0000-0000-0000-0000000000fb'
         and not eligible
         and 'MIGRATION_REANALYSIS_REQUIRED' = any(failures)
     ) then
       raise exception 'legacy unpublished verification did not fail closed for reanalysis';
     end if;
     if not exists (
       select 1
       from public.analysis_runs
       where id = 'aaaaaaaa-0000-0000-0000-0000000000f9'
         and status = 'succeeded'
     ) or not exists (
       select 1
       from public.verification_runs
       where id = 'aaaaaaaa-0000-0000-0000-0000000000f8'
         and eligible
         and candidate_code = 'legacy published candidate'
     ) then
       raise exception 'legacy published verification was not reconstructed from immutable release bytes';
     end if;
     if not exists (
       select 1
       from public.verification_runs
       where id = 'aaaaaaaa-0000-0000-0000-0000000000f6'
         and not eligible
         and not schema_valid
         and 'MIGRATION_REVERIFY_REQUIRED' = any(failures)
     ) then
       raise exception 'unreconstructible historical verification did not become permanently ineligible';
     end if;
   end
   \$\$;
   delete from public.releases where id = 'aaaaaaaa-0000-0000-0000-0000000000f7';
   delete from public.projects where id in (
     'aaaaaaaa-0000-0000-0000-0000000000ff',
     'aaaaaaaa-0000-0000-0000-0000000000fd',
     'aaaaaaaa-0000-0000-0000-0000000000fa'
   );"
"$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f supabase/seed.sql
"$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -c \
  "create role page2webmcp_test_runtime login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role page2webmcp_test_app login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role page2webmcp_test_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   grant page2webmcp_app, page2webmcp_worker to page2webmcp_test_runtime;
   grant page2webmcp_app to page2webmcp_test_app;
   grant page2webmcp_worker to page2webmcp_test_worker;"
"$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/auth_identity_standalone.sql
"$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/tenant_isolation_standalone.sql
"$task_psql" -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/retention_standalone.sql

PAGE2WEBMCP_TEST_DATABASE_URL="postgresql://page2webmcp_test_runtime@127.0.0.1:$task_port/postgres?host=$task_tmp_dir" \
PAGE2WEBMCP_TEST_ADMIN_DATABASE_URL="postgresql://127.0.0.1:$task_port/postgres?host=$task_tmp_dir" \
  run_typescript_test packages/database/src/postgres.integration.test.ts

NODE_ENV=test \
PAGE2WEBMCP_TEST_APP_DATABASE_URL="postgresql://page2webmcp_test_app@127.0.0.1:$task_port/postgres?host=$task_tmp_dir" \
PAGE2WEBMCP_TEST_WORKER_DATABASE_URL="postgresql://page2webmcp_test_worker@127.0.0.1:$task_port/postgres?host=$task_tmp_dir" \
PAGE2WEBMCP_TEST_ADMIN_DATABASE_URL="postgresql://127.0.0.1:$task_port/postgres?host=$task_tmp_dir" \
  run_typescript_test apps/control-plane/tests/postgres-topology.integration.test.ts

echo "Standalone PostgreSQL RLS and production-topology integration tests passed."
