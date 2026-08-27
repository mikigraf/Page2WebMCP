#!/usr/bin/env bash
set -euo pipefail

task_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/page2webmcp-postgres.XXXXXX")"
task_port="$((55000 + RANDOM % 1000))"
task_data_dir="$task_tmp_dir/data"

cleanup() {
  pg_ctl -D "$task_data_dir" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$task_tmp_dir"
}
trap cleanup EXIT

initdb -D "$task_data_dir" --auth=trust --no-locale >/dev/null
pg_ctl -D "$task_data_dir" -o "-k $task_tmp_dir -p $task_port" -w start >/dev/null

psql -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -c "create schema auth; create table auth.users (id uuid primary key, email text not null); create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid'; create role anon nologin; create role authenticated nologin;"
psql -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260826000000_page2webmcp.sql
psql -h "$task_tmp_dir" -p "$task_port" -d postgres -v ON_ERROR_STOP=1 -f supabase/tests/tenant_isolation_standalone.sql

echo "Standalone PostgreSQL RLS integration test passed."
