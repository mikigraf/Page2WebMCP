import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";

const LOCAL_OWNER_URL_ERROR = "LOCAL_OWNER_DATABASE_URL_LOOPBACK_REQUIRED";
const LOCAL_ENVIRONMENT_PATH = ".page2webmcp/local.env";
const RUNTIME_ROLES = [
  { environmentKey: "PAGE2WEBMCP_APP_DATABASE_URL", login: "page2webmcp_app_local", role: "page2webmcp_app", limit: 10 },
  { environmentKey: "PAGE2WEBMCP_WORKER_DATABASE_URL", login: "page2webmcp_worker_local", role: "page2webmcp_worker", limit: 5 },
  { environmentKey: "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL", login: "page2webmcp_maintenance_local", role: "page2webmcp_maintenance", limit: 2 }
];

export async function bootstrapLocalRuntimeRoles(
  ownerDatabaseUrl,
  destination = resolve(process.cwd(), LOCAL_ENVIRONMENT_PATH),
  dependencies = { createClient: (connectionString) => new pg.Client({ connectionString }) },
  options = {}
) {
  const ownerUrl = validateOwnerDatabaseUrl(ownerDatabaseUrl);
  const localStatus = validateLocalStatus(options.localStatus);
  const expectedMigrationVersions = validateMigrationVersions(options.expectedMigrationVersions);
  const client = dependencies.createClient(ownerUrl.toString());
  const credentials = RUNTIME_ROLES.map((runtimeRole) => ({ ...runtimeRole, password: randomBytes(32).toString("base64url") }));
  try {
    await client.connect();
    await assertAppliedMigrationHistory(client, expectedMigrationVersions);
    await assertBoundedApplicationRoles(client);
    for (const credential of credentials) await configureLogin(client, credential);
    await assertRuntimeLoginMemberships(client, credentials);
  } finally {
    await client.end().catch(() => undefined);
  }
  await writeLocalEnvironment(destination, credentials, ownerUrl, localStatus);
  return credentials.map(({ environmentKey, login, role }) => ({ environmentKey, login, role }));
}

function validateLocalStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.apiUrl !== "http://127.0.0.1:54321"
    || !safeBrowserKey(value.publishableKey)
    || !boundedSecret(value.serviceKey)
    || value.publishableKey === value.serviceKey) {
    throw new Error("LOCAL_SUPABASE_STATUS_INVALID");
  }
  return {
    apiUrl: value.apiUrl,
    publishableKey: value.publishableKey,
    serviceKey: value.serviceKey
  };
}

function safeBrowserKey(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 4_096
    || value.trim() !== value || /[\r\n]/.test(value) || /service[_-]?role|sb_secret_/i.test(value)) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return true;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) && claims.role === "anon";
  } catch {
    return false;
  }
}

function boundedSecret(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && value.trim() === value && !/[\r\n]/.test(value);
}

function validateMigrationVersions(value) {
  if (!Array.isArray(value) || value.length < 1
    || value.some((version) => typeof version !== "string" || !/^\d{14}$/.test(version))
    || new Set(value).size !== value.length) {
    throw new Error("LOCAL_MIGRATION_HISTORY_INCOMPLETE");
  }
  return [...value].sort();
}

async function assertAppliedMigrationHistory(client, expectedMigrationVersions) {
  const result = await client.query(
    "select version from supabase_migrations.schema_migrations order by version"
  );
  const applied = result.rows.map((row) => row?.version);
  if (applied.length !== expectedMigrationVersions.length
    || applied.some((version) => typeof version !== "string" || !/^\d{14}$/.test(version))
    || new Set(applied).size !== applied.length
    || applied.some((version, index) => version !== expectedMigrationVersions[index])) {
    throw new Error("LOCAL_MIGRATION_HISTORY_INCOMPLETE");
  }
}

async function assertRuntimeLoginMemberships(client, credentials) {
  const expected = new Map(credentials.map(({ login, role }) => [login, role]));
  const result = await client.query(
    "select member.rolname as login, role.rolname as application_role, member.rolinherit, member.rolsuper, member.rolbypassrls " +
    "from pg_auth_members membership join pg_roles member on member.oid = membership.member " +
    "join pg_roles role on role.oid = membership.roleid where member.rolname = any($1::text[])",
    [credentials.map(({ login }) => login)]
  );
  if (result.rows.length !== expected.size || result.rows.some((row) =>
    expected.get(row.login) !== row.application_role
    || row.rolinherit
    || row.rolsuper
    || row.rolbypassrls
  )) throw new Error("LOCAL_RUNTIME_ROLE_MEMBERSHIP_REQUIRED");
}

export function validateOwnerDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(LOCAL_OWNER_URL_ERROR);
  }
  if (parsed.protocol !== "postgresql:"
    || !["127.0.0.1", "[::1]"].includes(parsed.hostname)
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

async function writeLocalEnvironment(destination, credentials, ownerUrl, localStatus) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const lines = credentials.map(({ environmentKey, password, role }) => {
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = RUNTIME_ROLES.find((item) => item.environmentKey === environmentKey).login;
    runtimeUrl.password = password;
    runtimeUrl.searchParams.set("options", `-c role=${role}`);
    return `${environmentKey}=${runtimeUrl.toString()}`;
  });
  lines.push(
    `NEXT_PUBLIC_SUPABASE_URL=${localStatus.apiUrl}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${localStatus.publishableKey}`,
    `PAGE2WEBMCP_SUPABASE_URL=${localStatus.apiUrl}`,
    `PAGE2WEBMCP_SUPABASE_SECRET_KEY=${localStatus.serviceKey}`,
    `PAGE2WEBMCP_SESSION_SECRET=${randomBytes(32).toString("base64url")}`
  );
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
