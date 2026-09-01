import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260830190000_workflow_event_observability.sql", import.meta.url);

test("Task 9 migration admits only bounded lease-written side-effect event payloads", async () => {
  const sql = await readFile(migrationUrl, "utf8");

  for (const event of [
    "task.side_effect_started",
    "task.side_effect_completed",
    "task.side_effect_failed",
  ]) assert.match(sql, new RegExp(event.replaceAll(".", "\\.")));
  assert.match(sql, /jsonb_object_keys/);
  assert.match(sql, /inputHash/);
  assert.match(sql, /outputHash/);
  assert.match(sql, /durationMs/);
  assert.match(sql, /costMicros/);
  assert.match(sql, /page2webmcp\.workflow_task_id/);
  assert.match(sql, /page2webmcp\.worker_id/);
  assert.match(sql, /page2webmcp\.lease_generation/);
  assert.match(sql, /lease_expires_at > now\(\)/);
  assert.match(sql, /create trigger enforce_workflow_side_effect_event_insert/i);
  assert.match(sql, /current_setting\('page2webmcp\.workflow_task_id', true\)/);
  assert.match(sql, /grant execute on function private\.append_workflow_task_event\(uuid, text, jsonb\) to page2webmcp_worker/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.doesNotMatch(sql, /grant .*workflow_events.*(?:anon|authenticated)/i);
});
