import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { WORKSPACE_VIEW_TITLE, resolveWorkspaceView } from "../src/workspace-view.ts";
import { PartsConsole } from "../src/console.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) return ["node_modules", ".next"].includes(entry.name) ? [] : sourceFiles(child);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [child] : [];
  }));
  return nested.flat();
}

test("the example target is a TypeScript Next App Router application that is not the Acme fixture", async () => {
  const layout = await readFile(path.join(root, "app/layout.tsx"), "utf8");
  const home = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.match(layout, /<html lang="en">/);
  assert.match(layout, /HostedReleaseScript/);
  assert.match(home, /Beacon Parts Console/);
  const guard = /\(\?:\^\|\\\.\)acme\(\?:\\\.\|\$\)/;
  const shipped = [...await sourceFiles(path.join(root, "app")), ...await sourceFiles(path.join(root, "src"))];
  for (const file of shipped) {
    const branding = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => !guard.test(line))
      .join("\n")
      .toLowerCase();
    assert.ok(!/(?:^|[^a-z])acme(?:[^a-z]|$)/.test(branding), `${file} carries no acme identity`);
  }
  const script = await readFile(path.join(root, "app/hosted-release-script.tsx"), "utf8");
  assert.match(script, guard, "an acme target origin is rejected outright");
});

test("the installation page renders a hosted module script with integrity and anonymous CORS", async () => {
  const script = await readFile(path.join(root, "app/hosted-release-script.tsx"), "utf8");
  assert.match(script, /type="module"/);
  assert.match(script, /integrity=\{config\.integrity\}/);
  assert.match(script, /crossOrigin="anonymous"/);
  assert.match(script, /content="release-unconfigured"/);
  assert.ok(!script.includes("/api/releases/"), "the hosted object replaces the control-plane route");
  assert.match(script, /return <script\n/, "a plain element keeps the tag in the served HTML");
  assert.ok(!script.includes("next/script"), "next/script would only inject the tag after hydration");
});

test("one console instance is shared across separately bundled server entry points", async () => {
  const { partsConsole } = await import("../app/api/_runtime.ts");
  const first = partsConsole();
  assert.equal(partsConsole(), first);
  const registry = globalThis as unknown as Record<string, unknown>;
  assert.equal(registry.__page2webmcp_example_target_console__, first);
});

test("the protected workspace is gated with a 401 interrupt rather than a redirect or a banner", async () => {
  const page = await readFile(path.join(root, "app/workspace/page.tsx"), "utf8");
  const unauthorized = await readFile(path.join(root, "app/unauthorized.tsx"), "utf8");
  const config = await readFile(path.join(root, "next.config.ts"), "utf8");
  assert.match(page, /unauthorized\(\)/);
  assert.ok(!page.includes("redirect("), "the gate never redirects");
  assert.match(unauthorized, /401/);
  assert.match(unauthorized, /\/login/);
  assert.match(config, /authInterrupts: true/);
});

test("the workspace view resolves only for an authenticated session", () => {
  const app = new PartsConsole({
    operator: { email: "operator@beaconworks.dev", password: "example-target-password" },
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
  });
  assert.equal(resolveWorkspaceView(app, ""), null);
  assert.equal(resolveWorkspaceView(app, "not-a-session"), null);
  const session = app.login("operator@beaconworks.dev", "example-target-password");
  const view = resolveWorkspaceView(app, session);
  assert.ok(view);
  assert.equal(view.title, WORKSPACE_VIEW_TITLE);
  assert.equal(view.parts[0]?.sku, "PC-1180");
});

test("no source file hardcodes operator credentials or logs them", async () => {
  const shipped = [...await sourceFiles(path.join(root, "app")), ...await sourceFiles(path.join(root, "src"))];
  for (const file of shipped) {
    const content = await readFile(file, "utf8");
    assert.ok(!/console\.(?:log|info|warn|error)/.test(content), `${file} does not log`);
    assert.ok(!/PASSWORD\s*=\s*"[^"]+"/.test(content), `${file} has no inline password`);
  }
});
