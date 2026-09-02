import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_FILE = /^(\d{14})_[a-z0-9_]+\.sql$/;
// Same convention as scripts/local-supabase.mjs: every 14-digit prefixed .sql
// file under supabase/migrations, sorted, with unique versions.
const PACKAGED_DIRECTORY = new URL("../../../supabase/migrations/", import.meta.url);

export type MigrationRange = Readonly<{ from: string; to: string }>;

let cachedLedger: readonly string[] | undefined;

export function readMigrationLedger(directory?: URL | string): readonly string[] {
  const candidates = directory !== undefined
    ? [directory]
    : [PACKAGED_DIRECTORY, resolve(process.cwd(), "supabase/migrations")];
  for (const candidate of candidates) {
    let names: readonly string[];
    try { names = readdirSync(candidate as URL); } catch { continue; }
    const versions = names
      .map((name) => MIGRATION_FILE.exec(name)?.[1])
      .filter((version): version is string => version !== undefined)
      .sort();
    if (versions.length === 0) continue;
    if (new Set(versions).size !== versions.length) throw new Error("MIGRATION_LEDGER_AMBIGUOUS");
    return Object.freeze(versions);
  }
  throw new Error("MIGRATION_LEDGER_UNAVAILABLE");
}

// The deployed tree is bound to the deployed commit: the journey proves the
// operator tree is clean and equal to PAGE2WEBMCP_GIT_COMMIT_SHA, and the
// deployment identity digest binds that commit to the running application.
export function deployedMigrationRange(directory?: URL | string): MigrationRange {
  if (directory !== undefined) {
    const ledger = readMigrationLedger(directory);
    return Object.freeze({ from: ledger[0]!, to: ledger.at(-1)! });
  }
  cachedLedger ??= readMigrationLedger();
  return Object.freeze({ from: cachedLedger[0]!, to: cachedLedger.at(-1)! });
}
