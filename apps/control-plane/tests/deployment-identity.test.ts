import assert from "node:assert/strict";
import test from "node:test";
import { deploymentIdentityResponse } from "../app/api/deployment-identity/route.ts";
import {
  buildDeploymentIdentity,
  configuredDeploymentIdentity,
  deploymentIdentityMissingControls,
  verifyDeploymentIdentity,
} from "../src/deployment-identity.ts";

const environment = {
  PAGE2WEBMCP_GIT_COMMIT_SHA: "c".repeat(40),
  PAGE2WEBMCP_APPLICATION_RELEASE_ID: "control-plane-2026-09-01_1",
  PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.page2webmcp.example",
};

const embedded = buildDeploymentIdentity({
  gitCommitSha: environment.PAGE2WEBMCP_GIT_COMMIT_SHA,
  applicationReleaseId: environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID,
  controlPlaneOrigin: environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN,
  sourceTreeSha256: "a".repeat(64),
});

test("deployment identity binds the exact commit, application release, and HTTPS origin", () => {
  const identity = configuredDeploymentIdentity(environment, { loadBuildIdentity: () => embedded });
  assert.deepEqual(identity, {
    schema: "DeploymentIdentityV1",
    gitCommitSha: "c".repeat(40),
    applicationReleaseId: "control-plane-2026-09-01_1",
    controlPlaneOrigin: "https://control.page2webmcp.example",
    sourceTreeSha256: "a".repeat(64),
    identityDigest: embedded.identityDigest,
  });
  assert.deepEqual(verifyDeploymentIdentity(identity, environment, { loadBuildIdentity: () => embedded }), identity);
});

test("deployment identity fails closed on every missing, malformed, or mismatched binding", () => {
  for (const [name, value] of Object.entries(environment)) {
    assert.throws(
      () => configuredDeploymentIdentity({ ...environment, [name]: "" }, { loadBuildIdentity: () => embedded }),
      /DEPLOYMENT_IDENTITY_CONFIGURATION_REQUIRED$/,
    );
    assert.throws(
      () => verifyDeploymentIdentity(configuredDeploymentIdentity(environment, { loadBuildIdentity: () => embedded }), {
        ...environment,
        [name]: value === environment.PAGE2WEBMCP_GIT_COMMIT_SHA
          ? "d".repeat(40)
          : name === "PAGE2WEBMCP_APPLICATION_RELEASE_ID"
            ? "different-release"
            : "https://other.page2webmcp.example",
      }, { loadBuildIdentity: () => embedded }),
      /DEPLOYMENT_IDENTITY_(?:CONFIGURATION_REQUIRED|MISMATCH)/,
    );
  }
  for (const overrides of [
    { PAGE2WEBMCP_GIT_COMMIT_SHA: "C".repeat(40) },
    { PAGE2WEBMCP_GIT_COMMIT_SHA: "c".repeat(39) },
    { PAGE2WEBMCP_APPLICATION_RELEASE_ID: " release" },
    { PAGE2WEBMCP_APPLICATION_RELEASE_ID: "x".repeat(129) },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "http://control.page2webmcp.example" },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.page2webmcp.example/path" },
    { PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://user@control.page2webmcp.example" },
  ]) assert.throws(
    () => configuredDeploymentIdentity({ ...environment, ...overrides }, { loadBuildIdentity: () => embedded }),
    /DEPLOYMENT_IDENTITY_CONFIGURATION_REQUIRED$/,
  );
});

test("deployment identity parser rejects unknown fields and a recomputed forged digest", () => {
  const identity = configuredDeploymentIdentity(environment, { loadBuildIdentity: () => embedded });
  assert.throws(
    () => verifyDeploymentIdentity({ ...identity, unexpected: true }, environment, { loadBuildIdentity: () => embedded }),
    /^Error: DEPLOYMENT_IDENTITY_INVALID$/,
  );
  assert.throws(
    () => verifyDeploymentIdentity({ ...identity, gitCommitSha: "d".repeat(40) }, environment,
      { loadBuildIdentity: () => embedded }),
    /^Error: DEPLOYMENT_IDENTITY_(?:INVALID|MISMATCH)$/,
  );
});

test("runtime values cannot self-assert a different commit, tree, release, or origin than the build", () => {
  for (const changed of [
    { ...embedded, gitCommitSha: "d".repeat(40) },
    { ...embedded, applicationReleaseId: "different-release" },
    { ...embedded, controlPlaneOrigin: "https://other.page2webmcp.example" },
  ]) {
    assert.throws(
      () => configuredDeploymentIdentity(environment, {
        loadBuildIdentity: () => buildDeploymentIdentity(changed),
      }),
      /^Error: DEPLOYMENT_IDENTITY_MISMATCH$/,
    );
  }
  assert.throws(
    () => configuredDeploymentIdentity(environment, { loadBuildIdentity: () => { throw new Error("ENOENT"); } }),
    /^Error: DEPLOYMENT_BUILD_MANIFEST_REQUIRED$/,
  );
  assert.throws(
    () => configuredDeploymentIdentity(environment, {
      loadBuildIdentity: () => ({ ...embedded, sourceTreeSha256: "b".repeat(64) }),
    }),
    /^Error: DEPLOYMENT_BUILD_MANIFEST_INVALID$/,
  );
});

test("missing deployment controls are sorted and never contain their values", () => {
  assert.deepEqual(deploymentIdentityMissingControls({}), [
    "PAGE2WEBMCP_APPLICATION_RELEASE_ID",
    "PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN",
    "PAGE2WEBMCP_GIT_COMMIT_SHA",
  ]);
});

test("public identity route exposes only the bounded identity and disables caching", async () => {
    const response = await deploymentIdentityResponse(environment, { loadBuildIdentity: () => embedded });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);
    const body = await response.json();
    assert.equal(body.schema, "DeploymentIdentityV1");
    assert.equal(body.gitCommitSha, environment.PAGE2WEBMCP_GIT_COMMIT_SHA);
    assert.equal(body.applicationReleaseId, environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID);
    assert.equal(body.controlPlaneOrigin, environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN);
    assert.match(body.identityDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(body).sort(), [
      "applicationReleaseId",
      "controlPlaneOrigin",
      "gitCommitSha",
      "identityDigest",
      "schema",
      "sourceTreeSha256",
    ]);
});

test("local-live deployment identity endpoint is explicitly unavailable, never a 500", async () => {
    const response = await deploymentIdentityResponse({ PAGE2WEBMCP_LOCAL_STACK: "true" });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      schema: "DeploymentIdentityUnavailableV1",
      code: "LOCAL_ONLY",
      liveSuccess: false,
    });
});
