import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../instrumentation.node.ts";
import { DeploymentIdentityConfigurationError } from "../src/deployment-identity.ts";

test("control-plane startup names missing deployment controls without logging values", async () => {
  const lines: string[] = [];
  const secretValue = "must-never-be-logged";
  await assert.rejects(register({ PAGE2WEBMCP_GIT_COMMIT_SHA: secretValue }, {
    validateConfiguration: () => {
      throw new DeploymentIdentityConfigurationError([
        "PAGE2WEBMCP_GIT_COMMIT_SHA",
        "PAGE2WEBMCP_APPLICATION_RELEASE_ID",
      ]);
    },
    registerObservability: async () => assert.fail("observability must not start"),
    logError: (line) => lines.push(line),
  }), /DEPLOYMENT_IDENTITY_CONFIGURATION_REQUIRED/);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, new RegExp(secretValue));
  assert.deepEqual(JSON.parse(lines[0]!), {
    level: "error",
    event: "control_plane_startup_failed",
    code: "DEPLOYMENT_IDENTITY_CONFIGURATION_REQUIRED",
    missingEnvironment: [
      "PAGE2WEBMCP_APPLICATION_RELEASE_ID",
      "PAGE2WEBMCP_GIT_COMMIT_SHA",
    ],
  });
});
