import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));

test("local Supabase lifecycle is pinned, uses the pnpm CLI boundary, and declares the public release bucket", async () => {
  const packageJson = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const config = await readFile(join(workspaceRoot, "supabase/config.toml"), "utf8");
  const ignore = await readFile(join(workspaceRoot, ".gitignore"), "utf8");

  assert.equal(packageJson.devDependencies?.supabase, "2.116.0");
  for (const command of ["up", "reset", "status", "down"]) {
    assert.equal(packageJson.scripts?.[`local:${command}`], `node scripts/local-supabase.mjs ${command}`);
  }
  assert.match(config, /^\[storage\.buckets\.page2webmcp-releases\]\npublic = true$/m);
  assert.match(config, /^\[auth\]\n[\s\S]*?^site_url = "http:\/\/127\.0\.0\.1:3100"$/m);
  assert.match(config, /^additional_redirect_urls = \["http:\/\/127\.0\.0\.1:3100"\]$/m);
  assert.match(ignore, /^\.page2webmcp\/$/m);
  assert.equal(await exists(join(workspaceRoot, "scripts/local-supabase.mjs")), true);
});

test("runtime role bootstrap rejects a non-loopback owner URL without printing or persisting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-roles-"));
  const ownerUrl = "postgresql://postgres:owner-secret@database.example:5432/postgres";
  try {
    const result = await run("scripts/local-runtime-roles.mjs", ["--owner-database-url", ownerUrl], directory);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /LOCAL_OWNER_DATABASE_URL_LOOPBACK_REQUIRED/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /owner-secret|database\.example/);
    assert.equal(await exists(join(directory, ".page2webmcp/local.env")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function exists(path: string) {
  return existsSync(path);
}

async function run(script: string, args: string[], cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(workspaceRoot, script), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
