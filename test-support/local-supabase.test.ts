import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error JavaScript operational script has no declaration file.
import { bootstrapLocalRuntimeRoles, validateOwnerDatabaseUrl } from "../scripts/local-runtime-roles.mjs";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const localStatus = {
  apiUrl: "http://127.0.0.1:58321",
  publishableKey: "sb_publishable_local-browser-safe-key",
  serviceKey: "sb_secret_local-server-only-key-value"
};
const migrationVersions = ["20260830190000", "20260831120000", "20260831211329"];

test("local Supabase lifecycle is pinned, uses the pnpm CLI boundary, and declares the public release bucket", async () => {
  const packageJson = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const config = await readFile(join(workspaceRoot, "supabase/config.toml"), "utf8");
  const ignore = await readFile(join(workspaceRoot, ".gitignore"), "utf8");

  assert.equal(packageJson.devDependencies?.supabase, "2.116.0");
  assert.match(
    await readFile(join(workspaceRoot, "scripts/local-supabase.mjs"), "utf8"),
    /const REQUIRED_MIGRATION = "20260901140000";/,
  );
  for (const command of ["up", "reset", "status", "down"]) {
    assert.equal(packageJson.scripts?.[`local:${command}`], `node scripts/local-supabase.mjs ${command}`);
  }
  assert.match(config, /^\[storage\.buckets\.page2webmcp-releases\]\npublic = true$/m);
  assert.match(config, /^\[auth\]\n[\s\S]*?^site_url = "http:\/\/127\.0\.0\.1:3100"$/m);
  assert.match(config, /^additional_redirect_urls = \["http:\/\/127\.0\.0\.1:3100"\]$/m);
  assert.match(config, /^\[api\]\n[\s\S]*?^port = 58321$/m);
  assert.match(config, /^\[db\]\n[\s\S]*?^port = 58322$/m);
  assert.match(config, /^shadow_port = 58320$/m);
  assert.match(config, /^\[db\.pooler\]\n[\s\S]*?^port = 58329$/m);
  assert.match(config, /^\[studio\]\n[\s\S]*?^port = 58323$/m);
  assert.match(config, /^\[inbucket\]\n[\s\S]*?^port = 58324$/m);
  assert.match(config, /^# smtp_port = 58325$/m);
  assert.match(config, /^# pop3_port = 58326$/m);
  assert.match(config, /^\[analytics\]\n[\s\S]*?^port = 58327$/m);
  assert.match(config, /^inspector_port = 8083$/m);
  assert.doesNotMatch(config, /\b5432[0-9]\b/);
  assert.match(ignore, /^\.page2webmcp\/$/m);
  assert.equal(await exists(join(workspaceRoot, "scripts/local-supabase.mjs")), true);
});

test("runtime role helper is import-only and local-supabase remains the executable lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-roles-"));
  const ownerUrl = "postgresql://postgres:owner-secret@database.example:5432/postgres";
  try {
    const result = await run("scripts/local-runtime-roles.mjs", ["--owner-database-url", ownerUrl], directory);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /owner-secret|database\.example/);
    assert.equal(await exists(join(directory, ".page2webmcp/local.env")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local lifecycle rejects an old-only migration ledger before constructing the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-old-ledger-"));
  try {
    await mkdir(join(directory, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(directory, "supabase/migrations/20260830190000_workflow_event_observability.sql"),
      "-- old-only fixture\n",
    );
    const result = await run("scripts/local-supabase.mjs", ["status"], directory, {
      PATH: "/usr/bin:/bin",
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "LOCAL_MIGRATION_LEDGER_INCOMPLETE\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local status verifies the pinned CLI, parses machine env output, and never prints status credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-status-"));
  const bin = join(directory, "bin");
  const log = join(directory, "pnpm-arguments.log");
  try {
    await mkdir(join(directory, "supabase/migrations"), { recursive: true });
    await writeFile(join(
      directory,
      "supabase/migrations/20260901140000_live_verifier_attestation_v2_repair.sql",
    ), "-- fixture\n");
    await mkdir(bin);
    const fakePnpm = join(bin, "pnpm");
    await writeFile(fakePnpm, `#!/bin/sh
printf '%s\\n' "$@" >> "$PAGE2WEBMCP_PNPM_LOG"
printf '%s\\n' -- >> "$PAGE2WEBMCP_PNPM_LOG"
if [ "$*" = "exec supabase --version" ]; then
  printf '%s\\n' '2.116.0'
else
  printf '%s\\n' 'API_URL="http://127.0.0.1:58321"'
  printf '%s\\n' 'DB_URL="postgresql://postgres:owner-secret@127.0.0.1:58322/postgres"'
  printf '%s\\n' 'ANON_KEY="sb_publishable_local-browser-safe-key"'
  printf '%s\\n' 'SERVICE_ROLE_KEY="service-secret"'
  printf '%s\\n' 'STUDIO_URL="http://127.0.0.1:58323"'
fi
`);
    await chmod(fakePnpm, 0o755);

    const result = await run("scripts/local-supabase.mjs", ["status"], directory, {
      PATH: `${bin}:${process.env.PATH}`,
      PAGE2WEBMCP_PNPM_LOG: log
    });

    assert.equal(result.code, 0);
    assert.equal(await readFile(log, "utf8"), [
      "exec", "supabase", "--version", "--",
      "exec", "supabase", "status", "-o", "env", "--"
    ].join("\n") + "\n");
    assert.match(result.stdout, /API_URL: http:\/\/127\.0\.0\.1:58321/);
    assert.match(result.stdout, /STUDIO_URL: http:\/\/127\.0\.0\.1:58323/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /owner-secret|service-secret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local lifecycle fails closed before stack commands when the executable version drifts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-version-"));
  const bin = join(directory, "bin");
  const log = join(directory, "pnpm-arguments.log");
  try {
    await mkdir(join(directory, "supabase/migrations"), { recursive: true });
    await writeFile(join(
      directory,
      "supabase/migrations/20260901140000_live_verifier_attestation_v2_repair.sql",
    ), "-- fixture\n");
    await mkdir(bin);
    const fakePnpm = join(bin, "pnpm");
    await writeFile(fakePnpm, `#!/bin/sh
printf '%s\\n' "$@" >> "$PAGE2WEBMCP_PNPM_LOG"
printf '%s\\n' -- >> "$PAGE2WEBMCP_PNPM_LOG"
printf '%s\\n' '2.115.0'
`);
    await chmod(fakePnpm, 0o755);

    const result = await run("scripts/local-supabase.mjs", ["status"], directory, {
      PATH: `${bin}:${process.env.PATH}`,
      PAGE2WEBMCP_PNPM_LOG: log
    });

    assert.equal(result.code, 2);
    assert.equal(result.stderr, "LOCAL_SUPABASE_VERSION_MISMATCH\n");
    assert.equal(await readFile(log, "utf8"), "exec\nsupabase\n--version\n--\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime role bootstrap writes one atomic mode-0600 environment with fresh isolated credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-roles-success-"));
  const destination = join(directory, ".page2webmcp/local.env");
  const firstClient = fakeBootstrapClient(migrationVersions);
  try {
    const result = await bootstrapLocalRuntimeRoles(
      "postgresql://postgres:owner-secret@127.0.0.1:58322/postgres",
      destination,
      { createClient: () => firstClient },
      { localStatus, expectedMigrationVersions: migrationVersions }
    );
    const firstText = await readFile(destination, "utf8");
    const environment = Object.fromEntries(firstText.trim().split("\n").map((line) => {
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
    const expectedLogins = ["page2webmcp_app_local", "page2webmcp_worker_local", "page2webmcp_maintenance_local"];
    for (const [index, value] of urls.entries()) {
      const parsed = new URL(value!);
      assert.equal(parsed.hostname, "127.0.0.1");
      assert.equal(parsed.port, "58322");
      assert.equal(parsed.pathname, "/postgres");
      assert.equal(parsed.username, expectedLogins[index]);
      assert.match(parsed.password, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(parsed.password, "owner-secret");
    }
    assert.deepEqual(firstClient.membershipAssertions, [
      ["page2webmcp_app_local", "page2webmcp_app"],
      ["page2webmcp_worker_local", "page2webmcp_worker"],
      ["page2webmcp_maintenance_local", "page2webmcp_maintenance"]
    ]);
    assert.deepEqual(firstClient.migrationAssertions, migrationVersions);
    assert.equal(environment.NEXT_PUBLIC_SUPABASE_URL, localStatus.apiUrl);
    assert.equal(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, localStatus.publishableKey);
    assert.equal(environment.PAGE2WEBMCP_SUPABASE_URL, localStatus.apiUrl);
    assert.equal(environment.PAGE2WEBMCP_SUPABASE_SECRET_KEY, localStatus.serviceKey);
    assert.match(environment.PAGE2WEBMCP_SESSION_SECRET!, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(firstText, /owner-secret|PAGE2WEBMCP_OWNER_DATABASE_URL|NEXT_PUBLIC_SUPABASE_SECRET/);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(join(directory, ".page2webmcp"))).sort(), ["local.env"]);
    assert.equal(firstClient.ended, true);

    const secondClient = fakeBootstrapClient(migrationVersions);
    await bootstrapLocalRuntimeRoles(
      "postgresql://postgres:owner-secret@127.0.0.1:58322/postgres",
      destination,
      { createClient: () => secondClient },
      { localStatus, expectedMigrationVersions: migrationVersions }
    );
    const secondText = await readFile(destination, "utf8");
    const secondEnvironment = Object.fromEntries(secondText.trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.notEqual(secondEnvironment.PAGE2WEBMCP_SESSION_SECRET, environment.PAGE2WEBMCP_SESSION_SECRET);
    assert.notEqual(secondEnvironment.PAGE2WEBMCP_APP_DATABASE_URL, environment.PAGE2WEBMCP_APP_DATABASE_URL);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(join(directory, ".page2webmcp"))).sort(), ["local.env"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime role bootstrap uses typed format parameters and tenant-safe replay clauses", async () => {
  const source = await readFile(join(workspaceRoot, "scripts/local-runtime-roles.mjs"), "utf8");
  const createFormat = source.match(/select format\('create role[\s\S]*?\[credential\.login, credential\.limit, credential\.password\]/i)?.[0];
  const alterFormat = source.match(/select format\('alter role[\s\S]*?\[credential\.login, credential\.limit, credential\.password\]/i)?.[0];

  assert.ok(createFormat, "create-role formatter must remain explicit");
  assert.match(createFormat, /\$1::text/);
  assert.match(createFormat, /\$2::int/);
  assert.match(createFormat, /\$3::text/);
  assert.match(createFormat, /nosuperuser[\s\S]*noreplication[\s\S]*nobypassrls/i);

  assert.ok(alterFormat, "replay formatter must remain explicit");
  assert.match(alterFormat, /\$1::text/);
  assert.match(alterFormat, /\$2::int/);
  assert.match(alterFormat, /\$3::text/);
  assert.doesNotMatch(alterFormat, /nosuperuser|noreplication|nobypassrls/i);
  assert.match(source, /select 1 from pg_roles where rolname = \$1::text/i);
  assert.match(source, /pg_advisory_lock\(hashtextextended\(\$1::text, 0\)\)/i);
  assert.doesNotMatch(source, /error\?\.code\s*!==\s*"42710"/i);
  assert.match(source, /select rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles/i);
  assert.match(source, /member\.rolcanlogin[\s\S]*member\.rolcreatedb[\s\S]*member\.rolcreaterole[\s\S]*member\.rolreplication/i);
  assert.match(source, /await assertRuntimeLoginMemberships[\s\S]*await writeLocalEnvironment[\s\S]*finally\s*\{[\s\S]*await client\.end/i);
});

test("runtime role bootstrap refuses to persist credentials until every committed migration is applied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-migrations-"));
  const destination = join(directory, ".page2webmcp/local.env");
  const client = fakeBootstrapClient([migrationVersions[0]!]);
  try {
    await assert.rejects(bootstrapLocalRuntimeRoles(
      "postgresql://postgres:owner-secret@127.0.0.1:58322/postgres",
      destination,
      { createClient: () => client },
      { localStatus, expectedMigrationVersions: migrationVersions }
    ), /^Error: LOCAL_MIGRATION_HISTORY_INCOMPLETE$/);
    assert.equal(await exists(destination), false);
    assert.equal(client.ended, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime role bootstrap rejects every privilege-bearing application-role flag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-unsafe-role-"));
  try {
    for (const flag of ["rolcreatedb", "rolcreaterole", "rolreplication"] as const) {
      const destination = join(directory, `.page2webmcp/${flag}.env`);
      const client = fakeBootstrapClient(migrationVersions, { [flag]: true });
      await assert.rejects(bootstrapLocalRuntimeRoles(
        "postgresql://postgres:owner-secret@127.0.0.1:58322/postgres",
        destination,
        { createClient: () => client },
        { localStatus, expectedMigrationVersions: migrationVersions }
      ), /^Error: LOCAL_APPLICATION_ROLE_BOUNDARY_REQUIRED$/);
      assert.equal(await exists(destination), false);
      assert.equal(client.ended, true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime role bootstrap requires the exact sorted committed migration history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-migration-identity-"));
  const invalidHistories = [
    [...migrationVersions, "20260831130000"],
    [...migrationVersions, "malformed"],
    [migrationVersions[0]!, migrationVersions[1]!, migrationVersions[1]!],
    [...migrationVersions].reverse()
  ];
  try {
    for (const [index, appliedMigrationVersions] of invalidHistories.entries()) {
      const destination = join(directory, `.page2webmcp/local-${index}.env`);
      const client = fakeBootstrapClient(appliedMigrationVersions);
      await assert.rejects(bootstrapLocalRuntimeRoles(
        "postgresql://postgres:owner-secret@127.0.0.1:58322/postgres",
        destination,
        { createClient: () => client },
        { localStatus, expectedMigrationVersions: migrationVersions }
      ), /^Error: LOCAL_MIGRATION_HISTORY_INCOMPLETE$/);
      assert.equal(await exists(destination), false);
      assert.equal(client.ended, true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner bootstrap accepts only the canonical local Postgres endpoints", () => {
  assert.equal(
    validateOwnerDatabaseUrl("postgresql://postgres:secret@127.0.0.1:58322/postgres").hostname,
    "127.0.0.1"
  );
  assert.equal(
    validateOwnerDatabaseUrl("postgresql://postgres:secret@[::1]:58322/postgres").hostname,
    "[::1]"
  );
  for (const value of [
    "postgresql://postgres:secret@localhost:58322/postgres",
    "postgresql://postgres:secret@127.0.0.2:58322/postgres",
    "postgresql://postgres:secret@127.0.0.1:54322/postgres",
    "postgresql://postgres:secret@127.0.0.1:58323/postgres",
    "postgresql://postgres:secret@127.0.0.1:58322/other"
  ]) assert.throws(() => validateOwnerDatabaseUrl(value), /^Error: LOCAL_OWNER_DATABASE_URL_LOOPBACK_REQUIRED$/);
});

test("local-live launcher isolates app and worker credentials and runs worker TypeScript directly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-local-launcher-"));
  const bin = join(directory, "bin");
  const log = join(directory, "children.tsv");
  const terminated = join(directory, "terminated.log");
  const localDirectory = join(directory, ".page2webmcp");
  try {
    await mkdir(bin);
    await mkdir(localDirectory, { mode: 0o700 });
    const fakePnpm = join(bin, "pnpm");
    await writeFile(fakePnpm, `#!/bin/sh
case "$*" in
  *worker*) kind=worker ;;
  *) kind=app ;;
esac
printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \
  "$kind" "$*" "\${DATABASE_URL-}" "\${PAGE2WEBMCP_LOCAL_STACK-}" "\${PAGE2WEBMCP_STORAGE_MODE-}" \
  "\${PAGE2WEBMCP_APP_DATABASE_URL-}" "\${PAGE2WEBMCP_WORKER_DATABASE_URL-}" "\${PAGE2WEBMCP_MAINTENANCE_DATABASE_URL-}" \
  "\${NEXT_PUBLIC_SUPABASE_URL-}" "\${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY-}" "\${PAGE2WEBMCP_SUPABASE_URL-}" \
  "\${PAGE2WEBMCP_SUPABASE_SECRET_KEY-}" "\${PAGE2WEBMCP_SESSION_SECRET-}" \
  "\${PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN-}" "\${PAGE2WEBMCP_PUBLIC_ORIGIN-}" "\${PAGE2WEBMCP_PROVIDER_MODE-}" >> "$PAGE2WEBMCP_CHILD_LOG"
if [ "$kind" = worker ]; then
  sleep 1
  exit 7
fi
trap 'printf "%s\\n" app-terminated >> "$PAGE2WEBMCP_TERMINATED_LOG"; exit 0' TERM INT
while :; do sleep 1; done
`);
    await chmod(fakePnpm, 0o755);
    const localEnv = [
      "PAGE2WEBMCP_APP_DATABASE_URL=postgresql://page2webmcp_app_local:app-password@127.0.0.1:58322/postgres?options=-c+role%3Dpage2webmcp_app",
      "PAGE2WEBMCP_WORKER_DATABASE_URL=postgresql://page2webmcp_worker_local:worker-password@127.0.0.1:58322/postgres?options=-c+role%3Dpage2webmcp_worker",
      "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL=postgresql://page2webmcp_maintenance_local:maintenance-password@127.0.0.1:58322/postgres?options=-c+role%3Dpage2webmcp_maintenance",
      `NEXT_PUBLIC_SUPABASE_URL=${localStatus.apiUrl}`,
      `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${localStatus.publishableKey}`,
      `PAGE2WEBMCP_SUPABASE_URL=${localStatus.apiUrl}`,
      `PAGE2WEBMCP_SUPABASE_SECRET_KEY=${localStatus.serviceKey}`,
      "PAGE2WEBMCP_SESSION_SECRET=local-session-secret-with-more-than-32-bytes"
    ].join("\n") + "\n";
    const localEnvPath = join(localDirectory, "local.env");
    await writeFile(localEnvPath, localEnv, { mode: 0o600 });
    await chmod(localEnvPath, 0o600);

    const result = await run("scripts/dev-local-live.mjs", [], directory, {
      PATH: `${bin}:${process.env.PATH}`,
      PAGE2WEBMCP_CHILD_LOG: log,
      PAGE2WEBMCP_TERMINATED_LOG: terminated,
      PAGE2WEBMCP_PROVIDER_MODE: "openapi",
      PAGE2WEBMCP_APP_DATABASE_URL: "must-not-be-inherited",
      PAGE2WEBMCP_WORKER_DATABASE_URL: "must-not-be-inherited",
      PAGE2WEBMCP_MAINTENANCE_DATABASE_URL: "must-not-be-inherited",
      PAGE2WEBMCP_SESSION_SECRET: "must-not-be-inherited"
    });

    assert.equal(result.code, 7);
    assert.equal(await readFile(terminated, "utf8"), "app-terminated\n");
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /app-password|worker-password|service-key|session-secret/);
    const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => line.split("\t"));
    assert.equal(records.length, 2);
    const app = records.find(([kind]) => kind === "app")!;
    const worker = records.find(([kind]) => kind === "worker")!;
    assert.equal(app[1], "--filter @page2webmcp/control-plane dev -- --port 3100");
    assert.equal(worker[1], "exec tsx apps/worker/src/main.ts");
    assert.deepEqual(app.slice(2), [
      "postgresql://page2webmcp_app_local:app-password@127.0.0.1:58322/postgres?options=-c+role%3Dpage2webmcp_app",
      "true", "postgres", "", "", "",
      localStatus.apiUrl, localStatus.publishableKey, localStatus.apiUrl, localStatus.serviceKey,
      "local-session-secret-with-more-than-32-bytes",
      "http://127.0.0.1:3100",
      "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases",
      "openapi"
    ]);
    assert.deepEqual(worker.slice(2), [
      "postgresql://page2webmcp_worker_local:worker-password@127.0.0.1:58322/postgres?options=-c+role%3Dpage2webmcp_worker",
      "true", "postgres", "", "", "", "", "", "", "", "",
      "http://127.0.0.1:3100",
      "http://127.0.0.1:58321/storage/v1/object/public/page2webmcp-releases",
      "openapi"
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function exists(path: string) {
  return existsSync(path);
}

function fakeBootstrapClient(
  appliedMigrationVersions: readonly string[] = [],
  unsafeApplicationRoleFlags: Partial<Record<"rolcreatedb" | "rolcreaterole" | "rolreplication", boolean>> = {},
) {
  const applicationRoles = ["page2webmcp_app", "page2webmcp_worker", "page2webmcp_maintenance"];
  const membershipAssertions: string[][] = [];
  const migrationAssertions: string[] = [];
  return {
    ended: false,
    membershipAssertions,
    migrationAssertions,
    async connect() {},
    async end() { this.ended = true; },
    async query(text: string, values?: unknown[]) {
      if (text.includes("supabase_migrations.schema_migrations")) {
        migrationAssertions.push(...appliedMigrationVersions);
        return { rows: appliedMigrationVersions.map((version) => ({ version })) };
      }
      if (text.includes("from pg_roles")) return {
        rows: applicationRoles.map((rolname) => ({
          rolname,
          rolcanlogin: false,
          rolinherit: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          ...unsafeApplicationRoleFlags,
        }))
      };
      if (text.includes("from pg_auth_members")) {
        const logins = values?.[0] as string[];
        return {
          rows: logins.map((login) => {
            const role = login.replace(/_(?:app|worker|maintenance)_local$/, (suffix) =>
              `_${suffix.slice(1, -6)}`);
            membershipAssertions.push([login, role]);
            return {
              login,
              application_role: role,
              rolcanlogin: true,
              rolinherit: false,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
              rolbypassrls: false,
            };
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
