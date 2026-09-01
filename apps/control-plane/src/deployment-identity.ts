import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const COMMIT = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 4_096;
const BUILD_MANIFEST_PATH = ".dist/deployment-identity.json";

export type DeploymentIdentityV1 = Readonly<{
  schema: "DeploymentIdentityV1";
  gitCommitSha: string;
  applicationReleaseId: string;
  controlPlaneOrigin: string;
  sourceTreeSha256: string;
  identityDigest: string;
}>;

type BuildDeploymentIdentityInput = Readonly<{
  gitCommitSha: string;
  applicationReleaseId: string;
  controlPlaneOrigin: string;
  sourceTreeSha256: string;
}>;

export type DeploymentIdentityDependencies = Readonly<{
  loadBuildIdentity?: () => unknown;
}>;

export class DeploymentIdentityConfigurationError extends Error {
  readonly missingEnvironment: readonly string[];

  constructor(missingEnvironment: readonly string[]) {
    super("DEPLOYMENT_IDENTITY_CONFIGURATION_REQUIRED");
    this.name = "DeploymentIdentityConfigurationError";
    this.missingEnvironment = Object.freeze([...missingEnvironment].sort());
  }
}

export function deploymentIdentityMissingControls(environment: RuntimeEnvironment): string[] {
  const missing: string[] = [];
  if (!COMMIT.test(environment.PAGE2WEBMCP_GIT_COMMIT_SHA ?? "")) missing.push("PAGE2WEBMCP_GIT_COMMIT_SHA");
  if (!RELEASE_ID.test(environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID ?? "")) {
    missing.push("PAGE2WEBMCP_APPLICATION_RELEASE_ID");
  }
  if (!exactHttpsOrigin(environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN ?? "")) {
    missing.push("PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN");
  }
  return missing.sort();
}

export function buildDeploymentIdentity(input: BuildDeploymentIdentityInput): DeploymentIdentityV1 {
  if (!input || !COMMIT.test(input.gitCommitSha)
    || !RELEASE_ID.test(input.applicationReleaseId)
    || !exactHttpsOrigin(input.controlPlaneOrigin)
    || !DIGEST.test(input.sourceTreeSha256)) {
    throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID");
  }
  const unsigned = {
    schema: "DeploymentIdentityV1" as const,
    gitCommitSha: input.gitCommitSha,
    applicationReleaseId: input.applicationReleaseId,
    controlPlaneOrigin: input.controlPlaneOrigin,
    sourceTreeSha256: input.sourceTreeSha256,
  };
  return Object.freeze({ ...unsigned, identityDigest: digestIdentity(unsigned) });
}

export function configuredDeploymentIdentity(
  environment: RuntimeEnvironment = process.env,
  dependencies: DeploymentIdentityDependencies = {},
): DeploymentIdentityV1 {
  const missing = deploymentIdentityMissingControls(environment);
  if (missing.length > 0) throw new DeploymentIdentityConfigurationError(missing);
  let embedded: DeploymentIdentityV1;
  try {
    embedded = parseDeploymentIdentity((dependencies.loadBuildIdentity ?? loadBuildIdentity)());
  } catch (error) {
    if (error instanceof Error && error.message === "DEPLOYMENT_BUILD_MANIFEST_INVALID") throw error;
    throw new Error("DEPLOYMENT_BUILD_MANIFEST_REQUIRED");
  }
  if (environment.PAGE2WEBMCP_GIT_COMMIT_SHA !== embedded.gitCommitSha
    || environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID !== embedded.applicationReleaseId
    || environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN !== embedded.controlPlaneOrigin) {
    throw new Error("DEPLOYMENT_IDENTITY_MISMATCH");
  }
  return embedded;
}

export function verifyDeploymentIdentity(
  value: unknown,
  environment: RuntimeEnvironment = process.env,
  dependencies: DeploymentIdentityDependencies = {},
): DeploymentIdentityV1 {
  let parsed: DeploymentIdentityV1;
  try { parsed = parseDeploymentIdentity(value); }
  catch { throw new Error("DEPLOYMENT_IDENTITY_INVALID"); }
  const expected = configuredDeploymentIdentity(environment, dependencies);
  if (parsed.gitCommitSha !== expected.gitCommitSha
    || parsed.applicationReleaseId !== expected.applicationReleaseId
    || parsed.controlPlaneOrigin !== expected.controlPlaneOrigin
    || parsed.sourceTreeSha256 !== expected.sourceTreeSha256
    || !sameDigest(parsed.identityDigest, expected.identityDigest)) {
    throw new Error("DEPLOYMENT_IDENTITY_MISMATCH");
  }
  return parsed;
}

function parseDeploymentIdentity(value: unknown): DeploymentIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0")
      !== "applicationReleaseId\0controlPlaneOrigin\0gitCommitSha\0identityDigest\0schema\0sourceTreeSha256"
    || record.schema !== "DeploymentIdentityV1"
    || typeof record.gitCommitSha !== "string" || !COMMIT.test(record.gitCommitSha)
    || typeof record.applicationReleaseId !== "string" || !RELEASE_ID.test(record.applicationReleaseId)
    || typeof record.controlPlaneOrigin !== "string" || !exactHttpsOrigin(record.controlPlaneOrigin)
    || typeof record.sourceTreeSha256 !== "string" || !DIGEST.test(record.sourceTreeSha256)
    || typeof record.identityDigest !== "string" || !DIGEST.test(record.identityDigest)) {
    throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID");
  }
  const expectedDigest = digestIdentity({
    schema: "DeploymentIdentityV1",
    gitCommitSha: record.gitCommitSha,
    applicationReleaseId: record.applicationReleaseId,
    controlPlaneOrigin: record.controlPlaneOrigin,
    sourceTreeSha256: record.sourceTreeSha256,
  });
  if (!sameDigest(record.identityDigest, expectedDigest)) throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID");
  return Object.freeze(record as DeploymentIdentityV1);
}

function loadBuildIdentity(): unknown {
  const path = resolve(process.cwd(), BUILD_MANIFEST_PATH);
  const bytes = readFileSync(path);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID");
  }
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("DEPLOYMENT_BUILD_MANIFEST_INVALID"); }
}

function digestIdentity(value: Omit<DeploymentIdentityV1, "identityDigest">): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function exactHttpsOrigin(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.pathname === "/"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
