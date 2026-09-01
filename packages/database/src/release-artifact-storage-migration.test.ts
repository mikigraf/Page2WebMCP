import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260831100000_release_artifact_storage.sql", import.meta.url);
const configUrl = new URL("../../../supabase/config.toml", import.meta.url);

test("release artifact bucket is public but bounded to immutable JavaScript candidates", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /insert into storage\.buckets\s*\(id, name, public, file_size_limit, allowed_mime_types\)/i);
  assert.match(sql, /'page2webmcp-releases',\s*'page2webmcp-releases',\s*true,\s*65536,\s*array\['application\/javascript'\]::text\[\]/i);
  assert.match(sql, /on conflict \(id\) do nothing/i);
  assert.match(sql, /raise exception 'release artifact bucket configuration mismatch'/i);
  assert.match(sql, /name = 'page2webmcp-releases'/i);
  assert.match(sql, /public is not distinct from true/i);
  assert.match(sql, /file_size_limit is not distinct from 65536/i);
  assert.match(sql, /allowed_mime_types is not distinct from array\['application\/javascript'\]::text\[\]/i);
  assert.doesNotMatch(sql, /storage\.objects/i);
  assert.doesNotMatch(sql, /\b(?:create|alter|drop)\s+schema\b/i);
  assert.doesNotMatch(sql, /\bcreate\s+policy\b/i);
  assert.doesNotMatch(sql, /\bgrant\b/i);
});

test("local Storage config enforces the same bucket byte and MIME limits", async () => {
  const config = await readFile(configUrl, "utf8");
  const section = config.match(/\[storage\.buckets\.page2webmcp-releases\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  assert.ok(section);
  assert.match(section, /^public = true$/m);
  assert.match(section, /^file_size_limit = "64KiB"$/m);
  assert.match(section, /^allowed_mime_types = \["application\/javascript"\]$/m);
  assert.doesNotMatch(section, /text\/javascript/);
});
