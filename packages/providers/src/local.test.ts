import test from "node:test";
import assert from "node:assert/strict";
import { LocalArtifactStore, LocalBrowserProvider, LocalSourceControlProvider } from "./local.ts";

test("local providers model ephemeral browser sessions, immutable artifacts, and draft pull requests", async () => {
  const browser = new LocalBrowserProvider(); const session = await browser.start("https://acme.example");
  assert.equal(session.origin, "https://acme.example"); await browser.destroy(session.id);
  await assert.rejects(() => browser.get(session.id), { code: "SESSION_NOT_FOUND" });
  const artifacts = new LocalArtifactStore(); const release = artifacts.publish("bundle", "abc");
  assert.equal(artifacts.get(release.id).content, "bundle");
  const source = new LocalSourceControlProvider(); const pr = source.openDraftPullRequest({ title: "Add WebMCP", files: ["app/_page2webmcp/register.generated.ts"] });
  assert.equal(pr.draft, true);
});
