import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Replay refusal for request identifiers and nonces.
 *
 * Guarantees:
 *  - a key is admitted at most once while its recorded expiry is in the future;
 *  - the durable store writes and flushes each admitted key to disk before the caller proceeds,
 *    so a single process restart within the attestation lifetime still refuses the replay;
 *  - both stores are bounded: once `maxEntries` unexpired keys are held, further keys are
 *    refused (fail closed) rather than evicting a key that could then be replayed.
 *
 * Limits (stated honestly):
 *  - eviction is by expiry only; the bound is on live entries, so a flood of valid requests
 *    inside one 60 second window can exhaust capacity and cause refusals until entries expire;
 *  - durability is single-node. Two verifier processes that do not share the file do not share
 *    replay state, and a lost or truncated file forgets every key recorded before the loss;
 *  - the file records only key strings and expiry milliseconds. Keys are identifiers and
 *    digests, never tokens, cookies, or page content.
 */
export type ReplayStore = Readonly<{
  admit(key: string, expiresAt: number, now: number): boolean;
  close(): void;
}>;

const MAX_LINE_BYTES = 256;

export function createMemoryReplayStore(maxEntries: number): ReplayStore {
  const admitted = new Map<string, number>();
  return Object.freeze({
    admit: (key, expiresAt, now) => admitInto(admitted, maxEntries, key, expiresAt, now),
    close: () => admitted.clear(),
  });
}

export function createDurableReplayStore(input: Readonly<{
  path: string;
  maxEntries: number;
  now?: () => number;
}>): ReplayStore {
  const now = input.now ?? (() => Date.now());
  const admitted = loadEntries(input.path, now());
  mkdirSync(dirname(input.path), { recursive: true });
  compact(input.path, admitted);
  let descriptor: number | undefined = openSync(input.path, "a");
  return Object.freeze({
    admit(key, expiresAt, at) {
      if (!admitInto(admitted, input.maxEntries, key, expiresAt, at)) return false;
      const line = `${encodeURIComponent(key)} ${Math.trunc(expiresAt)}\n`;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES || descriptor === undefined) {
        admitted.delete(key);
        return false;
      }
      try {
        writeSync(descriptor, line);
        fsyncSync(descriptor);
      } catch {
        admitted.delete(key);
        return false;
      }
      return true;
    },
    close() {
      if (descriptor !== undefined) closeSync(descriptor);
      descriptor = undefined;
    },
  });
}

function admitInto(
  admitted: Map<string, number>,
  maxEntries: number,
  key: string,
  expiresAt: number,
  now: number,
): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 128
    || !Number.isFinite(expiresAt) || !Number.isFinite(now)) return false;
  for (const [recorded, expiry] of admitted) if (expiry <= now) admitted.delete(recorded);
  if (admitted.has(key)) return false;
  if (admitted.size >= maxEntries) return false;
  admitted.set(key, expiresAt);
  return true;
}

function loadEntries(path: string, now: number): Map<string, number> {
  const admitted = new Map<string, number>();
  if (!existsSync(path)) return admitted;
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return admitted;
  }
  for (const line of content.split("\n")) {
    const [key, expiry] = line.split(" ");
    if (!key || !expiry || !/^\d{1,15}$/.test(expiry)) continue;
    const expiresAt = Number(expiry);
    if (expiresAt > now) admitted.set(decodeURIComponent(key), expiresAt);
  }
  return admitted;
}

function compact(path: string, admitted: Map<string, number>): void {
  const lines = [...admitted].map(([key, expiry]) => `${encodeURIComponent(key)} ${expiry}\n`).join("");
  writeFileSync(path, lines, { mode: 0o600 });
}
