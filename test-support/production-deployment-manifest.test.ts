import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("production images are separate, digest-pinned by the caller, non-root, and consume one fixed build identity", async () => {
  const [control, worker, ignore] = await Promise.all([
    readFile(new URL("deploy/Dockerfile.control-plane", root), "utf8"),
    readFile(new URL("deploy/Dockerfile.worker", root), "utf8"),
    readFile(new URL(".dockerignore", root), "utf8"),
  ]);
  for (const dockerfile of [control, worker]) {
    assert.match(dockerfile, /^ARG NODE_BASE_IMAGE\s*$/m);
    assert.match(dockerfile, /^FROM \$\{NODE_BASE_IMAGE\}/m);
    assert.doesNotMatch(dockerfile, /FROM\s+node:[^@$\s]+/);
    assert.match(dockerfile, /--verify-build-context/);
    assert.match(dockerfile, /\.dist\/deployment-source\.tar/);
    assert.doesNotMatch(dockerfile, /^COPY \. \.$/m);
    assert.match(dockerfile, /\.dist\/deployment-identity\.json/);
    assert.match(dockerfile, /PAGE2WEBMCP_GIT_COMMIT_SHA/);
    assert.match(dockerfile, /PAGE2WEBMCP_APPLICATION_RELEASE_ID/);
    assert.match(dockerfile, /PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN/);
    assert.match(dockerfile, /^USER node$/m);
    assert.doesNotMatch(dockerfile, /(?:ARG|ENV)\s+[^\n]*(?:TOKEN|PASSWORD|PRIVATE_KEY|SECRET_KEY|DATABASE_URL)/i);
    assert.doesNotMatch(dockerfile, /(?:COPY|ADD)\s+[^\n]*(?:\.env|\.git)/i);
  }
  assert.match(control, /PAGE2WEBMCP_PRODUCTION_LIVE_BUILD=true/);
  assert.match(control, /apps\/control-plane\/server\.js/);
  assert.doesNotMatch(control, /apps\/worker/);
  assert.match(worker, /pnpm build:worker/);
  assert.match(worker, /\.dist\/worker\/apps\/worker\/src\/main\.js/);
  assert.doesNotMatch(worker, /next start|control-plane\/server/);
  // .git is deliberately not ignored: the identity stage clones it to derive the
  // release. It never reaches a runtime stage, which the COPY assertion above
  // enforces for every image.
  assert.doesNotMatch(ignore, /^\.git$/m);
  assert.match(ignore, /^\.page2webmcp$/m);
  assert.match(ignore, /^\.env/m);
  assert.match(ignore, /^node_modules$/m);
  assert.match(ignore, /^\.dist\/\*$/m);
  assert.match(ignore, /^!\.dist\/deployment-identity\.json$/m);
  assert.match(ignore, /^!\.dist\/deployment-source\.tar$/m);
});

test("Next emits a standalone production control-plane server", async () => {
  const config = await readFile(new URL("apps/control-plane/next.config.ts", root), "utf8");
  assert.match(config, /output:\s*"standalone"/);
});
