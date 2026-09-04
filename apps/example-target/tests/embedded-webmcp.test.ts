import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseEmbeddedLayerScript } from "../app/hosted-release-script.tsx";

const root = fileURLToPath(new URL("..", import.meta.url));
const targetOrigin = "https://page2webmcp-example-target.vercel.app";
const contentHash = "6eadef4b0f64fb97f2df02b752460cb949801f383e92439e5ae9797899332a66";
const integrity = "sha384-gncxe7XoWxzNNX3CjqFC6ruzzq3tEF1M6xy4BIdrLaeE+u+/iyWWb+dOOJktrdPV";

test("the embedded WebMCP layer is opt-in and pinned to Beacon Parts Console", () => {
  assert.deepEqual(
    parseEmbeddedLayerScript({
      PAGE2WEBMCP_EXAMPLE_TARGET_EMBEDDED_LAYER: "true",
      PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: targetOrigin,
    }),
    {
      src: `/webmcp/page2webmcp-${contentHash}.js`,
      integrity,
      contentHash,
      targetOrigin,
      localOnly: false,
    },
  );
  assert.equal(parseEmbeddedLayerScript({
    PAGE2WEBMCP_EXAMPLE_TARGET_EMBEDDED_LAYER: "false",
    PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: targetOrigin,
  }), undefined);
  assert.equal(parseEmbeddedLayerScript({
    PAGE2WEBMCP_EXAMPLE_TARGET_EMBEDDED_LAYER: "true",
    PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN: "https://other.example",
  }), undefined);
});

test("the checked-in layer has the compiler's pinned content hash and SRI", async () => {
  const release = await readFile(path.join(root, "public/webmcp", `page2webmcp-${contentHash}.js`), "utf8");
  assert.equal(createHash("sha256").update(release).digest("hex"), contentHash);
  assert.equal(`sha384-${createHash("sha384").update(release).digest("base64")}`, integrity);
  assert.match(release, /export const releaseManifest/);
  assert.match(release, /reservepartstock_322c76cc/);
});
