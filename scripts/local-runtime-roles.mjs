import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const LOCAL_OWNER_URL_ERROR = "LOCAL_OWNER_DATABASE_URL_LOOPBACK_REQUIRED";
const LOCAL_ENVIRONMENT_PATH = ".page2webmcp/local.env";
const RUNTIME_ROLES = [
  { environmentKey: "PAGE2WEBMCP_APP_DATABASE_URL", login: "page2webmcp_local_app", role: "page2webmcp_app", limit: 10 },
  { environmentKey: "PAGE2WEBMCP_WORKER_DATABASE_URL", login: "page2webmcp_local_worker", role: "page2webmcp_worker", limit: 5 },
  { environmentKey: "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL", login: "page2webmcp_local_maintenance", role: "page2webmcp_maintenance", limit: 2 }
];

export async function bootstrapLocalRuntimeRoles(ownerDatabaseUrl, destination = resolve(process.cwd(), LOCAL_ENVIRONMENT_PATH)) {
  const ownerUrl = validateOwnerDatabaseUrl(ownerDatabaseUrl);
  const client = new pg.Client({ connectionString: ownerUrl.toString() });
  const credentials = RUNTIME_ROLES.map((runtimeRole) => ({ ...runtimeRole, password: randomBytes(32).toString("base64url") }));
  try {
    await client.connect();
    await assertBoundedApplicationRoles(client);
    for (const credential of credentials) await configureLogin(client, credential);
  } finally {
    await client.end().catch(() => undefined);
  }
  await writeLocalEnvironment(destination, credentials, ownerUrl);
  return credentials.map(({ environmentKey, login, role }) => ({ environmentKey, login, role }));
}

export function validateOwnerDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(LOCAL_OWNER_URL_ERROR);
  }
  if (parsed.protocol !== "postgresql:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "54322"
    || parsed.pathname !== "/postgres"
    || parsed.username !== "postgres"
    || !parsed.password
    || parsed.search
    || parsed.hash) throw new Error(LOCAL_OWNER_URL_ERROR);
  return parsed;
}

async function assertBoundedApplicationRoles(client) {
  const names = RUNTIME_ROLES.map(({ role }) => role);
  const result = await client.query(
    "select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls from pg_roles where rolname = any($1::text[])",
    [names]
  );
  if (result.rows.length !== names.length || result.rows.some((row) => row.rolcanlogin || row.rolinherit || row.rolsuper || row.rolbypassrls)) {
    throw new Error("LOCAL_APPLICATION_ROLE_BOUNDARY_REQUIRED");
  }
}

async function configureLogin(client, credential) {
  const statement = await client.query(
    "select format('create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit %s password %L', $1, $2, $3) as sql",
    [credential.login, credential.limit, credential.password]
  );
  try {
    await client.query(statement.rows[0].sql);
  } catch (error) {
    if (error?.code !== "42710") throw error;
    const alter = await client.query(
      "select format('alter role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit %s password %L', $1, $2, $3) as sql",
      [credential.login, credential.limit, credential.password]
    );
    await client.query(alter.rows[0].sql);
  }
  for (const runtimeRole of RUNTIME_ROLES) {
    if (runtimeRole.role !== credential.role) await client.query(`revoke ${runtimeRole.role} from ${credential.login}`);
  }
  await client.query(`grant ${credential.role} to ${credential.login}`);
}

async function writeLocalEnvironment(destination, credentials, ownerUrl) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const lines = credentials.map(({ environmentKey, password, role }) => {
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = RUNTIME_ROLES.find((item) => item.environmentKey === environmentKey).login;
    runtimeUrl.password = password;
    runtimeUrl.searchParams.set("options", `-c role=${role}`);
    return `${environmentKey}=${runtimeUrl.toString()}`;
  });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
}

async function main() {
  const [flag, ownerDatabaseUrl] = process.argv.slice(2);
  if (flag !== "--owner-database-url" || !ownerDatabaseUrl || process.argv.length !== 4) throw new Error(LOCAL_OWNER_URL_ERROR);
  await bootstrapLocalRuntimeRoles(ownerDatabaseUrl);
  console.log("Local runtime roles refreshed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "LOCAL_RUNTIME_ROLE_BOOTSTRAP_FAILED"}\n`);
    process.exitCode = 2;
  });
}
