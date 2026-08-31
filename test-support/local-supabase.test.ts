import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error JavaScript operational script has no declaration file.
import { bootstrapLocalRuntimeRoles } from "../scripts/local-runtime-roles.mjs";

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

test("local status invokes Supabase only through pnpm exec and never prints status credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-status-"));
  const bin = join(directory, "bin");
  const log = join(directory, "pnpm-arguments.log");
  try {
    await mkdir(join(directory, "supabase/migrations"), { recursive: true });
    await writeFile(join(directory, "supabase/migrations/20260830190000_workflow_event_observability.sql"), "-- fixture\n");
    await mkdir(bin);
    const fakePnpm = join(bin, "pnpm");
    await writeFile(fakePnpm, `#!/bin/sh\nprintf '%s\\n' "$@" > "$PAGE2WEBMCP_PNPM_LOG"\nprintf '%s\\n' '{"API_URL":"http://127.0.0.1:54321","DB_URL":"postgresql://postgres:owner-secret@127.0.0.1:54322/postgres","SERVICE_ROLE_KEY":"service-secret"}'\n`);
    await chmod(fakePnpm, 0o755);

    const result = await run("scripts/local-supabase.mjs", ["status"], directory, {
      PATH: `${bin}:${process.env.PATH}`,
      PAGE2WEBMCP_PNPM_LOG: log
    });

    assert.equal(result.code, 0);
    assert.equal(await readFile(log, "utf8"), "exec\nsupabase\nstatus\n-o\njson\n");
    assert.match(result.stdout, /API_URL: http:\/\/127\.0\.0\.1:54321/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /owner-secret|service-secret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime role bootstrap writes three bounded distinct login URLs and verifies their one-role memberships", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-roles-success-"));
  const destination = join(directory, ".page2webmcp/local.env");
  const client = fakeBootstrapClient();
  try {
    const result = await bootstrapLocalRuntimeRoles(
      "postgresql://postgres:owner-secret@127.0.0.1:54322/postgres",
      destination,
      { createClient: () => client }
    );
    const environment = Object.fromEntries((await readFile(destination, "utf8")).trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const urls = [
      environment.PAGE2WEBMCP_APP_DATABASE_URL,
      environment.PAGE2WEBMCP_WORKER_DATABASE_URL,
      environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL
    ];

    assert.equal(result.length, 3);
    assert.equal(new Set(urls).size, 3);
    for (const value of urls) {
      const parsed = new URL(value!);
      assert.equal(parsed.hostname, "127.0.0.1");
      assert.equal(parsed.port, "54322");
      assert.equal(parsed.pathname, "/postgres");
      assert.match(parsed.password, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(parsed.password, "owner-secret");
    }
    assert.deepEqual(client.membershipAssertions, [
      ["page2webmcp_local_app", "page2webmcp_app"],
      ["page2webmcp_local_worker", "page2webmcp_worker"],
      ["page2webmcp_local_maintenance", "page2webmcp_maintenance"]
    ]);
    assert.equal(client.ended, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function exists(path: string) {
  return existsSync(path);
}

function fakeBootstrapClient() {
  const applicationRoles = ["page2webmcp_app", "page2webmcp_worker", "page2webmcp_maintenance"];
  const membershipAssertions: string[][] = [];
  return {
    ended: false,
    membershipAssertions,
    async connect() {},
    async end() { this.ended = true; },
    async query(text: string, values?: unknown[]) {
      if (text.includes("from pg_roles")) return {
        rows: applicationRoles.map((rolname) => ({ rolname, rolcanlogin: false, rolinherit: false, rolsuper: false, rolbypassrls: false }))
      };
      if (text.includes("from pg_auth_members")) {
        const logins = values?.[0] as string[];
        return {
          rows: logins.map((login) => {
            const role = login.replace("page2webmcp_local_", "page2webmcp_");
            membershipAssertions.push([login, role]);
            return { login, application_role: role, rolinherit: false, rolsuper: false, rolbypassrls: false };
          })
        };
      }
      if (text.startsWith("select format")) return { rows: [{ sql: "select 1" }] };
      return { rows: [] };
    }
  };
}

async function run(script: string, args: string[], cwd: string, environment: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(workspaceRoot, script), ...args], {
      cwd,
      env: { ...process.env, ...environment },
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
