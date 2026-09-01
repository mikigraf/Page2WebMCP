import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProductionLiveControlSession,
  readProductionOperatorCredentials,
} from "../scripts/lib/production-live-control-session.ts";

test("operator credentials are read only from one bounded mode-0600 strict file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-live-operator-"));
  const file = join(directory, "credentials.json");
  try {
    await writeFile(file, JSON.stringify({ email: "operator@widgets.dev", password: "secret-password-value" }), {
      mode: 0o600,
    });
    assert.deepEqual(await readProductionOperatorCredentials(file), {
      email: "operator@widgets.dev",
      password: "secret-password-value",
    });
    await chmod(file, 0o644);
    await assert.rejects(readProductionOperatorCredentials(file), /PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED/);
    await chmod(file, 0o600);
    await writeFile(file, JSON.stringify({ email: "operator@widgets.dev", password: "secret-password-value", role: "owner" }));
    await assert.rejects(readProductionOperatorCredentials(file), /PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("operator credential reads use one no-follow file descriptor for metadata and bytes", async () => {
  const source = await readFile(new URL("../scripts/lib/production-live-control-session.ts", import.meta.url), "utf8");
  assert.match(source, /constants\.O_NOFOLLOW/);
  assert.match(source, /handle\.stat\(\)/);
  assert.match(source, /handle\.read\(/);
  assert.doesNotMatch(source, /\blstat\(/);

  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-live-operator-symlink-"));
  const target = join(directory, "credentials.json");
  const link = join(directory, "credentials-link.json");
  try {
    await writeFile(target, JSON.stringify({
      email: "operator@widgets.dev",
      password: "secret-password-value",
    }), { mode: 0o600 });
    await symlink(target, link);
    await assert.rejects(readProductionOperatorCredentials(link), /PRODUCTION_OPERATOR_CREDENTIALS_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("control session logs in with CSRF, retains bounded cookies, and reuses exact idempotency", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const origin = "https://control.widgets.dev";
  const transport: typeof fetch = async (resource, init = {}) => {
    const url = String(resource);
    calls.push({ url, init });
    if (url.endsWith("/api/auth/csrf")) return json(url, { csrfToken: "v1.public-csrf" }, {
      "set-cookie": "page2webmcp-csrf=one; Path=/; Secure; HttpOnly; SameSite=Lax",
    });
    if (url.endsWith("/api/auth/login")) return json(url, { user: { id: "user" } }, {
      "set-cookie": "page2webmcp-session=two; Path=/; Secure; HttpOnly; SameSite=Lax",
    });
    if (url.endsWith("/api/auth/session")) return json(url, { csrfToken: "v1.private-csrf" });
    if (url.endsWith("/api/projects")) return json(url, { id: "project" }, {}, 201);
    throw new Error("unexpected request");
  };
  const session = new ProductionLiveControlSession(origin, { fetch: transport });
  await session.login({ email: "operator@widgets.dev", password: "secret-password-value" });
  assert.deepEqual(await session.post("/api/projects", { sourceType: "openapi" }, "live-project:key"), {
    id: "project",
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    `${origin}/api/auth/csrf`, `${origin}/api/auth/login`, `${origin}/api/auth/session`, `${origin}/api/projects`,
  ]);
  const loginHeaders = new Headers(calls[1]!.init.headers);
  assert.equal(loginHeaders.get("x-csrf-token"), "v1.public-csrf");
  assert.match(loginHeaders.get("cookie") ?? "", /page2webmcp-csrf=one/);
  const projectHeaders = new Headers(calls[3]!.init.headers);
  assert.equal(projectHeaders.get("idempotency-key"), "live-project:key");
  assert.match(projectHeaders.get("cookie") ?? "", /page2webmcp-session=two/);
  assert.equal(calls.every(({ init }) => init.redirect === "error"), true);
});

function json(url: string, value: unknown, headers: Record<string, string> = {}, status = 200): Response {
  const response = new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
