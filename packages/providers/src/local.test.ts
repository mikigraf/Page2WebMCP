import test from "node:test";
import assert from "node:assert/strict";
import { LocalArtifactStore, LocalBrowserProvider } from "./local.ts";

test("local providers model only ephemeral browser sessions and immutable artifacts", async () => {
  const browser = new LocalBrowserProvider(); const session = await browser.start("https://acme.example");
  assert.equal(session.origin, "https://acme.example"); await browser.destroy(session.id);
  await assert.rejects(() => browser.get(session.id), { code: "SESSION_NOT_FOUND" });
  const artifacts = new LocalArtifactStore(); const release = artifacts.publish("bundle", "abc");
  assert.equal(artifacts.get(release.id).content, "bundle");
});
