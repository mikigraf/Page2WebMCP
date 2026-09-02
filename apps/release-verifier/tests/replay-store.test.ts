import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDurableReplayStore, createMemoryReplayStore } from "../src/replay-store.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "page2webmcp-replay-"));
  return join(directory, "replay.log");
}

test("an in-memory store admits once, evicts expired entries, and refuses when full", () => {
  const store = createMemoryReplayStore(2);
  assert.equal(store.admit("a", NOW + 1_000, NOW), true);
  assert.equal(store.admit("a", NOW + 1_000, NOW), false);
  assert.equal(store.admit("b", NOW + 1_000, NOW), true);
  assert.equal(store.admit("c", NOW + 1_000, NOW), false);
  assert.equal(store.admit("c", NOW + 1_000, NOW + 2_000), true);
});

test("a durable store refuses a key replayed after a process restart within its lifetime", () => {
  const path = scratch();
  const first = createDurableReplayStore({ path, maxEntries: 32, now: () => NOW });
  assert.equal(first.admit("request:one", NOW + 60_000, NOW), true);
  first.close();

  const restarted = createDurableReplayStore({ path, maxEntries: 32, now: () => NOW + 1_000 });
  assert.equal(restarted.admit("request:one", NOW + 60_000, NOW + 1_000), false);
  assert.equal(restarted.admit("request:two", NOW + 60_000, NOW + 1_000), true);
  restarted.close();
  rmSync(path, { force: true });
});

test("a durable store forgets only entries whose attestation window has closed", () => {
  const path = scratch();
  const first = createDurableReplayStore({ path, maxEntries: 32, now: () => NOW });
  assert.equal(first.admit("request:expired", NOW + 1_000, NOW), true);
  first.close();

  const later = createDurableReplayStore({ path, maxEntries: 32, now: () => NOW + 5_000 });
  assert.equal(later.admit("request:expired", NOW + 65_000, NOW + 5_000), true);
  later.close();
  rmSync(path, { force: true });
});

test("a durable store stays bounded and never records secrets", () => {
  const path = scratch();
  const store = createDurableReplayStore({ path, maxEntries: 4, now: () => NOW });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(store.admit(`request:${index}`, NOW + 60_000, NOW), true);
  }
  assert.equal(store.admit("request:overflow", NOW + 60_000, NOW), false);
  store.close();
  const persisted = readFileSync(path, "utf8");
  assert.equal(persisted.includes("overflow"), false);
  assert.equal(persisted.split("\n").filter(Boolean).length <= 8, true);
  rmSync(path, { force: true });
});
