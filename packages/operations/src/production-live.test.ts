import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WEBSITE_PRODUCTION_LIVE_CONTROLS,
  buildOpenApiLiveJourneyReceipt,
  buildWebsiteBrowserUseLiveJourneyReceipt,
  canonicalJsonSha256,
  evaluateProductionLivePreflight,
  inspectProductionLiveControls,
  validateOpenApiLiveJourneyReceipt,
  validateWebsiteBrowserUseLiveJourneyReceipt,
  writeProductionLiveReceipt,
} from "./production-live.ts";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const NOW = new Date("2026-09-01T12:00:00.000Z");
const SIGNING_KEY = `receipt_signing_${"k".repeat(32)}`;
const OTHER_SIGNING_KEY = `receipt_signing_${"z".repeat(32)}`;
const HOSTED_STORAGE =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";
const WEBSITE_LIVE_KEYS = [
  "PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN",
  "PAGE2WEBMCP_AUTH_HANDOFF_TOKEN",
  "PAGE2WEBMCP_BROWSER_LEASE_STORE_ORIGIN",
  "PAGE2WEBMCP_BROWSER_LEASE_STORE_TOKEN",
  "PAGE2WEBMCP_BROWSER_USE_API_KEY",
  "PAGE2WEBMCP_BROWSER_USE_API_ORIGIN",
  "PAGE2WEBMCP_CDP_OBSERVER_ORIGIN",
  "PAGE2WEBMCP_CDP_OBSERVER_TOKEN",
  "PAGE2WEBMCP_EGRESS_POLICY_ORIGIN",
  "PAGE2WEBMCP_EGRESS_POLICY_TOKEN",
  "PAGE2WEBMCP_EGRESS_PROXY_ORIGIN",
  "PAGE2WEBMCP_EGRESS_PROXY_TOKEN",
  "PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN",
  "PAGE2WEBMCP_EVIDENCE_STORE_TOKEN",
  "PAGE2WEBMCP_OWNERSHIP_STORE_ORIGIN",
  "PAGE2WEBMCP_OWNERSHIP_STORE_TOKEN",
  "PAGE2WEBMCP_PUBLIC_ORIGIN",
  "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID",
  "PAGE2WEBMCP_SECRET_STORE_ORIGIN",
  "PAGE2WEBMCP_SECRET_STORE_TOKEN",
] as const;

function commonEnvironment(): Record<string, string> {
  return {
    DATABASE_URL:
      "postgresql://page2webmcp_app:password@db.bimqgiedckdurqiywctl.supabase.co:5432/postgres?sslmode=require",
    PAGE2WEBMCP_MAINTENANCE_DATABASE_URL:
      "postgresql://page2webmcp_maintenance:password@db.bimqgiedckdurqiywctl.supabase.co:5432/postgres?sslmode=require",
    PAGE2WEBMCP_STORAGE_MODE: "postgres",
    PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN: "https://control.widgets.dev",
    PAGE2WEBMCP_SUPABASE_URL: "https://bimqgiedckdurqiywctl.supabase.co",
    PAGE2WEBMCP_SUPABASE_SECRET_KEY: `sb_secret_${"s".repeat(32)}`,
    PAGE2WEBMCP_PUBLIC_ORIGIN: HOSTED_STORAGE,
    PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN: "https://verifier.widgets.dev",
    PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN: `verifier_${"v".repeat(32)}`,
    PAGE2WEBMCP_GIT_COMMIT_SHA: "c".repeat(40),
    PAGE2WEBMCP_APPLICATION_RELEASE_ID: "page2webmcp-2026_09_01-rc1",
    PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE: "/secure/page2webmcp-operator.json",
    PAGE2WEBMCP_RECEIPT_SIGNING_KEY: `receipt_signing_${"k".repeat(32)}`,
  };
}

function openApiEnvironment(): Record<string, string> {
  return {
    ...commonEnvironment(),
    PAGE2WEBMCP_PROVIDER_MODE: "openapi",
    PAGE2WEBMCP_E2E_SOURCE_URL: "https://specs.widgets.dev/openapi.json",
    PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN: "https://staging.widgets.dev",
    PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL: "https://staging.widgets.dev/webmcp-test",
    PAGE2WEBMCP_E2E_INSTALL_PAGE_URL: "https://staging.widgets.dev/install",
    PAGE2WEBMCP_E2E_ENVIRONMENT: "production",
  };
}

function websiteEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    ...commonEnvironment(),
    PAGE2WEBMCP_PROVIDER_MODE: "website",
    PAGE2WEBMCP_E2E_SOURCE_URL: "https://login.widgets.dev/account",
    PAGE2WEBMCP_E2E_INSTALL_PAGE_URL: "https://login.widgets.dev/webmcp",
    PAGE2WEBMCP_E2E_ENVIRONMENT: "production",
  };
  for (const key of WEBSITE_LIVE_KEYS) {
    if (key.endsWith("_ORIGIN")) {
      environment[key] = key === "PAGE2WEBMCP_PUBLIC_ORIGIN"
        ? HOSTED_STORAGE
        : `https://${key.toLowerCase().replaceAll("_", "-")}.widgets.dev`;
    } else if (key === "PAGE2WEBMCP_BROWSER_USE_API_KEY") {
      environment[key] = `bu_${"k".repeat(32)}`;
    } else if (key === "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID") {
      environment[key] = "alias/page2webmcp-production-live";
    } else {
      environment[key] = `${key.toLowerCase()}_${"t".repeat(32)}`;
    }
  }
  return environment;
}

function commonReceiptInput() {
  return {
    deployment: {
      gitCommitSha: "c".repeat(40),
      applicationReleaseId: "page2webmcp-2026_09_01-rc1",
      controlPlaneOrigin: "https://control.widgets.dev",
      controlPlaneIdentityDigest: HASH,
      sourceTreeSha256: OTHER_HASH,
    },
    database: {
      projectRef: "bimqgiedckdurqiywctl",
      migrationRange: { from: "20260829074144", to: "20260901060852", digest: HASH },
      applicationRoleDigest: HASH,
      maintenanceRoleDigest: HASH,
    },
    project: { organizationIdentityDigest: OTHER_HASH, identityDigest: HASH },
    target: {
      origin: "https://staging.widgets.dev",
      environment: "production" as const,
      testPageIdentityDigest: HASH,
      installPageIdentityDigest: HASH,
    },
    release: { identityDigest: HASH, releaseId: "release-2026-09-01", selectedHash: HASH },
    artifact: {
      sha256: HASH,
      sri: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      size: 1024,
      mimeType: "application/javascript",
    },
    hostedObject: {
      projectRef: "bimqgiedckdurqiywctl",
      bucket: "page2webmcp-releases",
      path: `${HASH}.js`,
      identityDigest: HASH,
      sha256: HASH,
      size: 1024,
      mimeType: "application/javascript",
    },
    namedDownload: { identityDigest: HASH, sha256: HASH, size: 1024, mimeType: "application/javascript" },
    installation: {
      identityDigest: HASH,
      installedSha256: HASH,
      targetOrigin: "https://staging.widgets.dev",
      environment: "production" as const,
      verifiedAt: "2026-09-01T12:00:00.000Z",
    },
    verifier: {
      identityDigest: HASH,
      protocolVersion: 2,
      candidate: {
        attestationId: "11111111-1111-4111-8111-111111111111",
        requestId: "22222222-2222-4222-8222-222222222222",
        operation: "candidate",
        nonceDigest: HASH,
        scopeDigest: HASH,
        payloadDigest: HASH,
        issuedAt: "2026-09-01T11:58:00.000Z",
        expiresAt: "2026-09-01T12:00:00.000Z",
        attestedAt: "2026-09-01T11:59:00.000Z",
      },
      installation: {
        attestationId: "33333333-3333-4333-8333-333333333333",
        requestId: "44444444-4444-4444-8444-444444444444",
        operation: "installation",
        nonceDigest: OTHER_HASH,
        scopeDigest: OTHER_HASH,
        payloadDigest: OTHER_HASH,
        issuedAt: "2026-09-01T11:59:00.000Z",
        expiresAt: "2026-09-01T12:01:00.000Z",
        attestedAt: "2026-09-01T12:00:00.000Z",
      },
    },
    cleanup: { status: "passed" as const, revocationDigest: HASH },
    readiness: { status: "passed" as const, code: "LIVE_READINESS_PASSED", evidenceDigest: HASH },
    liveSuccess: true,
  } as const;
}

test("production-live control inspection is exhaustive, deterministic, sorted, and secret-free", () => {
  assert.deepEqual(WEBSITE_PRODUCTION_LIVE_CONTROLS, WEBSITE_LIVE_KEYS);
  const missing = inspectProductionLiveControls("website", {});
  const expected = [
    ...Object.keys(commonEnvironment()),
    "PAGE2WEBMCP_PROVIDER_MODE",
    ...WEBSITE_LIVE_KEYS,
    "PAGE2WEBMCP_E2E_SOURCE_URL",
    "PAGE2WEBMCP_E2E_INSTALL_PAGE_URL",
    "PAGE2WEBMCP_E2E_ENVIRONMENT",
  ].filter((key, index, keys) => keys.indexOf(key) === index).sort();
  assert.deepEqual(missing.missingControls, expected);
  assert.deepEqual(Object.keys(missing), ["journey", "missingControls"]);

  const configured = websiteEnvironment();
  assert.deepEqual(inspectProductionLiveControls("website", configured), {
    journey: "website",
    missingControls: [],
  });
  assert.doesNotMatch(JSON.stringify(missing), /password|sb_secret_|verifier_/);

  configured.PAGE2WEBMCP_PROVIDER_MODE = "openapi";
  assert.deepEqual(inspectProductionLiveControls("website", configured).missingControls, [
    "PAGE2WEBMCP_PROVIDER_MODE",
  ]);
});

test("preflight rejects wrong hosted identity, fixtures, loopback, and cross-origin OpenAPI pages", () => {
  const environment = openApiEnvironment();
  Object.assign(environment, {
    DATABASE_URL: "postgresql://app:password@127.0.0.1/page2webmcp",
    PAGE2WEBMCP_SUPABASE_URL: "https://another-project.supabase.co",
    PAGE2WEBMCP_E2E_SOURCE_URL: "https://api.acme.example/openapi.json",
    PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL: "https://other.widgets.dev/test",
  });
  assert.deepEqual(inspectProductionLiveControls("openapi", environment).missingControls, [
    "DATABASE_URL",
    "PAGE2WEBMCP_E2E_SOURCE_URL",
    "PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL",
    "PAGE2WEBMCP_SUPABASE_URL",
  ]);

  const disguisedLoopback = openApiEnvironment();
  disguisedLoopback.DATABASE_URL = "postgresql://app:password@localhost./page2webmcp";
  assert.deepEqual(inspectProductionLiveControls("openapi", disguisedLoopback).missingControls, ["DATABASE_URL"]);
});

test("preflight accepts hosted Supabase direct and pooler URLs but rejects wrong projects and shared identities", () => {
  const direct = openApiEnvironment();
  assert.deepEqual(inspectProductionLiveControls("openapi", direct).missingControls, []);

  const pooler = openApiEnvironment();
  pooler.DATABASE_URL =
    "postgresql://page2webmcp_app.bimqgiedckdurqiywctl:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require";
  pooler.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL =
    "postgresql://page2webmcp_maintenance.bimqgiedckdurqiywctl:password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=verify-full";
  assert.deepEqual(inspectProductionLiveControls("openapi", pooler).missingControls, []);

  const wrongProject = openApiEnvironment();
  wrongProject.DATABASE_URL =
    "postgresql://page2webmcp_app:password@db.wrongprojectref12345.supabase.co:5432/postgres?sslmode=require";
  wrongProject.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL =
    "postgresql://page2webmcp_maintenance:password@db.bimqgiedckdurqiywctl.supabase.co:5432/postgres?sslmode=disable";
  assert.deepEqual(inspectProductionLiveControls("openapi", wrongProject).missingControls, [
    "DATABASE_URL",
    "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL",
  ]);

  const sharedIdentity = openApiEnvironment();
  sharedIdentity.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL = sharedIdentity.DATABASE_URL;
  assert.deepEqual(inspectProductionLiveControls("openapi", sharedIdentity).missingControls, [
    "DATABASE_URL",
    "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL",
  ]);

  const nextIncompatibleRelease = openApiEnvironment();
  nextIncompatibleRelease.PAGE2WEBMCP_APPLICATION_RELEASE_ID = "release.with.dots";
  assert.deepEqual(inspectProductionLiveControls("openapi", nextIncompatibleRelease).missingControls, [
    "PAGE2WEBMCP_APPLICATION_RELEASE_ID",
  ]);
});

test("all configurable control origins must be exact public production HTTPS origins", () => {
  const openapi = openApiEnvironment();
  openapi.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN = "https://127.0.0.1";
  openapi.PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN = "https://localhost";
  assert.deepEqual(inspectProductionLiveControls("openapi", openapi).missingControls, [
    "PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN",
    "PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN",
  ]);

  const website = websiteEnvironment();
  website.PAGE2WEBMCP_EGRESS_POLICY_ORIGIN = "https://10.0.0.1";
  website.PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN = "https://evidence.example";
  assert.deepEqual(inspectProductionLiveControls("website", website).missingControls, [
    "PAGE2WEBMCP_EGRESS_POLICY_ORIGIN",
    "PAGE2WEBMCP_EVIDENCE_STORE_ORIGIN",
  ]);
});

test("website production-live preflight rejects non-production environments before any browser effect", () => {
  for (const selectedEnvironment of ["test", "staging"]) {
    const environment = websiteEnvironment();
    environment.PAGE2WEBMCP_E2E_ENVIRONMENT = selectedEnvironment;
    assert.deepEqual(inspectProductionLiveControls("website", environment).missingControls, [
      "PAGE2WEBMCP_E2E_ENVIRONMENT",
    ]);
  }
  assert.deepEqual(inspectProductionLiveControls("website", websiteEnvironment()).missingControls, []);
});

test("a local-stack or local verifier origin fails the production-live preflight closed by exact name", () => {
  for (const mode of ["dry-run", "live"] as const) {
    const environment = {
      ...openApiEnvironment(),
      PAGE2WEBMCP_LOCAL_STACK: "true",
      PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN: "http://127.0.0.1:3900",
    };
    const result = evaluateProductionLivePreflight({ journey: "openapi", mode, environment });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "PRODUCTION_LIVE_LOCAL_STACK_FORBIDDEN");
    assert.deepEqual(result.missingControls, [
      "PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN",
      "PAGE2WEBMCP_LOCAL_STACK",
    ]);
    assert.equal(result.liveSuccess, false);
  }

  const localStackOnly = evaluateProductionLivePreflight({
    journey: "openapi",
    mode: "live",
    environment: { ...openApiEnvironment(), PAGE2WEBMCP_LOCAL_STACK: "false" },
  });
  assert.equal(localStackOnly.code, "PRODUCTION_LIVE_LOCAL_STACK_FORBIDDEN");
  assert.deepEqual(localStackOnly.missingControls, ["PAGE2WEBMCP_LOCAL_STACK"]);

  assert.equal(evaluateProductionLivePreflight({
    journey: "openapi", mode: "live", environment: openApiEnvironment(),
  }).code, "PRODUCTION_LIVE_READY_TO_EXECUTE");
});

test("dry-run only returns an immutable plan and can never claim live success", () => {
  const result = evaluateProductionLivePreflight({
    journey: "openapi",
    mode: "dry-run",
    environment: openApiEnvironment(),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.code, "PRODUCTION_LIVE_DRY_RUN_READY");
  assert.equal(result.liveSuccess, false);
  assert.deepEqual(result.missingControls, []);
  assert.deepEqual(result.completedOperations, []);
  assert.ok(result.plannedOperations.length > 0);
  assert.equal("receiptLocation" in result, false);
  assert.equal("receiptDigest" in result, false);

  const live = evaluateProductionLivePreflight({
    journey: "openapi", mode: "live", environment: openApiEnvironment(),
  });
  assert.equal(live.code, "PRODUCTION_LIVE_READY_TO_EXECUTE");
  assert.equal(live.liveSuccess, false);
});

test("receipt builders canonicalize key order and validators reject tampering, unknown keys, future time, and false readiness", () => {
  const input = {
    ...commonReceiptInput(),
    provider: { type: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
    source: { identityDigest: HASH, documentIdentityDigest: OTHER_HASH },
  } as const;
  const receipt = buildOpenApiLiveJourneyReceipt(input, SIGNING_KEY, NOW);
  assert.equal(receipt.schema, "OpenApiLiveJourneyReceiptV1");
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.integrity.algorithm, "sha256");
  assert.equal(receipt.integrity.digest, canonicalJsonSha256({
    ...receipt,
    integrity: undefined,
    signature: undefined,
  }));
  assert.deepEqual(validateOpenApiLiveJourneyReceipt(receipt, NOW, SIGNING_KEY), receipt);

  const reordered = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
  const reverseEntries = Object.entries(reordered).reverse();
  assert.equal(canonicalJsonSha256(Object.fromEntries(reverseEntries)), canonicalJsonSha256(receipt));

  assert.throws(() => validateOpenApiLiveJourneyReceipt({ ...receipt, artifact: { ...receipt.artifact, size: 1 } }, NOW),
    /RECEIPT_INTEGRITY_INVALID/);
  assert.throws(() => validateOpenApiLiveJourneyReceipt({ ...receipt, verifierToken: "secret" }, NOW),
    /RECEIPT_SCHEMA_INVALID/);
  assert.throws(() => buildOpenApiLiveJourneyReceipt({
    ...input,
    verifier: {
      ...input.verifier,
      installation: { ...input.verifier.installation, attestedAt: "2026-09-01T12:00:00.001Z" },
    },
  }, SIGNING_KEY, NOW), /RECEIPT_ATTESTATION_FUTURE/);
  assert.throws(() => buildOpenApiLiveJourneyReceipt({
    ...input,
    readiness: { ...input.readiness, status: "failed" as const },
  }, SIGNING_KEY, NOW), /RECEIPT_LIVE_SUCCESS_INVALID/);
});

test("website receipt binds browser, ownership, authentication, restart, TTL, and cleanup identities", () => {
  const receipt = buildWebsiteBrowserUseLiveJourneyReceipt({
    ...commonReceiptInput(),
    provider: { type: "website", adapter: "browser-use-v4", adapterVersion: 4 },
    source: { identityDigest: HASH, documentIdentityDigest: OTHER_HASH },
    browserUse: { sessionIdentityDigest: HASH },
    ownership: { decisionDigest: HASH, verified: true },
    browserLease: { identityDigest: HASH },
    egress: { policyDigest: HASH, referenceDigest: OTHER_HASH },
    cdpObservation: { identityDigest: HASH },
    authentication: {
      checkpointDigest: HASH,
      handoffDigest: HASH,
      completed: true,
      workerRestartDigest: HASH,
      resumeDigest: HASH,
      ttlSecretReferenceDigest: HASH,
    },
    cleanup: {
      status: "passed",
      revocationDigest: HASH,
      browserCleanupDigest: HASH,
      controlCleanupDigest: HASH,
    },
  }, SIGNING_KEY, NOW);
  assert.equal(receipt.schema, "WebsiteBrowserUseLiveJourneyReceiptV1");
  assert.deepEqual(validateWebsiteBrowserUseLiveJourneyReceipt(receipt, NOW, SIGNING_KEY), receipt);
  assert.doesNotMatch(JSON.stringify(receipt), /apiKey|token|password|cookie|cdpUrl|kmsKeyId|sessionCredential|"organizationId":/i);
});

test("receipt builders reject non-exact production origins and non-JavaScript MIME", () => {
  const input = {
    ...commonReceiptInput(),
    provider: { type: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
    source: { identityDigest: HASH, documentIdentityDigest: OTHER_HASH },
  } as const;
  assert.throws(() => buildOpenApiLiveJourneyReceipt({
    ...input,
    deployment: { ...input.deployment, controlPlaneOrigin: "https://control.widgets.dev/api" },
  }, SIGNING_KEY, NOW), /RECEIPT_ORIGIN_INVALID/);
  assert.throws(() => buildOpenApiLiveJourneyReceipt({
    ...input,
    target: { ...input.target, origin: "https://127.0.0.1" },
    installation: { ...input.installation, targetOrigin: "https://127.0.0.1" },
  }, SIGNING_KEY, NOW), /RECEIPT_ORIGIN_INVALID/);
  assert.throws(() => buildOpenApiLiveJourneyReceipt({
    ...input,
    artifact: { ...input.artifact, mimeType: "text/javascript" as "application/javascript" },
    hostedObject: { ...input.hostedObject, mimeType: "text/javascript" as "application/javascript" },
    namedDownload: { ...input.namedDownload, mimeType: "text/javascript" as "application/javascript" },
  }, SIGNING_KEY, NOW), /RECEIPT_SCHEMA_INVALID/);
});


test("the receipt carries the deployed source tree, the installation verification time, and rejects a stale one", () => {
  const input = {
    ...commonReceiptInput(),
    provider: { type: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
    source: { identityDigest: HASH, documentIdentityDigest: OTHER_HASH },
  } as const;
  const receipt = buildOpenApiLiveJourneyReceipt(input, SIGNING_KEY, NOW);
  assert.equal(receipt.deployment.sourceTreeSha256, OTHER_HASH);
  assert.equal(receipt.installation.verifiedAt, "2026-09-01T12:00:00.000Z");

  assert.throws(() => buildOpenApiLiveJourneyReceipt({
    ...input,
    installation: { ...input.installation, verifiedAt: "2026-09-01T11:59:59.000Z" },
  }, SIGNING_KEY, NOW), /RECEIPT_VERIFIER_TIMELINE_INVALID/);
  assert.throws(() => buildOpenApiLiveJourneyReceipt({
    ...input,
    installation: { ...input.installation, verifiedAt: "2026-09-01T12:00:00.001Z" },
  }, SIGNING_KEY, NOW), /RECEIPT_ATTESTATION_FUTURE/);
});


test("the receipt carries a keyed signature no receipt holder can forge", () => {
  const input = {
    ...commonReceiptInput(),
    provider: { type: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
    source: { identityDigest: HASH, documentIdentityDigest: OTHER_HASH },
  } as const;
  const receipt = buildOpenApiLiveJourneyReceipt(input, SIGNING_KEY, NOW);
  assert.equal(receipt.signature.algorithm, "hmac-sha256");
  assert.match(receipt.signature.value, /^[0-9a-f]{64}$/);
  assert.match(receipt.signature.keyIdDigest, /^[0-9a-f]{64}$/);
  assert.equal(receipt.integrity.algorithm, "sha256");
  assert.equal(JSON.stringify(receipt).includes(SIGNING_KEY), false);

  // The unkeyed digest still verifies on its own for existing consumers.
  assert.deepEqual(validateOpenApiLiveJourneyReceipt(receipt, NOW), receipt);

  // An editor who recomputes the unkeyed digest still cannot produce the signature.
  const tampered = { ...receipt, liveSuccess: true, artifact: { ...receipt.artifact, size: 2048 },
    hostedObject: { ...receipt.hostedObject, size: 2048 },
    namedDownload: { ...receipt.namedDownload, size: 2048 } } as Record<string, unknown>;
  const unsigned = { ...tampered };
  delete unsigned.integrity;
  delete unsigned.signature;
  const forged = { ...tampered, integrity: { algorithm: "sha256", digest: canonicalJsonSha256(unsigned) } };
  assert.doesNotThrow(() => validateOpenApiLiveJourneyReceipt(forged, NOW));
  assert.throws(() => validateOpenApiLiveJourneyReceipt(forged, NOW, SIGNING_KEY), /RECEIPT_SIGNATURE_INVALID/);
  assert.throws(() => validateOpenApiLiveJourneyReceipt(receipt, NOW, OTHER_SIGNING_KEY), /RECEIPT_SIGNATURE_INVALID/);
  assert.throws(() => buildOpenApiLiveJourneyReceipt(input, "short", NOW), /RECEIPT_SIGNING_KEY_REQUIRED/);
});

test("content-addressed writer is live-only, reconciles exact bytes, and rejects conflicting bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "page2webmcp-production-live-"));
  try {
    const receipt = buildOpenApiLiveJourneyReceipt({
      ...commonReceiptInput(),
      provider: { type: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
      source: { identityDigest: HASH, documentIdentityDigest: OTHER_HASH },
    }, SIGNING_KEY, NOW);
    assert.equal(await writeProductionLiveReceipt({ mode: "dry-run", directory, receipt }), undefined);

    const location = await writeProductionLiveReceipt({ mode: "live", directory, receipt });
    assert.equal(location, join(directory, `${receipt.integrity.digest}.json`));
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(location)).mode & 0o777, 0o600);
    const bytes = await readFile(location, "utf8");
    assert.equal(createHash("sha256").update(bytes.trimEnd()).digest("hex"),
      createHash("sha256").update(JSON.stringify(JSON.parse(bytes))).digest("hex"));
    assert.equal(await writeProductionLiveReceipt({ mode: "live", directory, receipt }), location);

    await writeFile(location, "different bytes", "utf8");
    await assert.rejects(writeProductionLiveReceipt({ mode: "live", directory, receipt }),
      /RECEIPT_CONTENT_CONFLICT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("content-addressed writer rejects unsafe receipt directories and existing symlink files", async () => {
  const root = await mkdtemp(join(tmpdir(), "page2webmcp-production-live-security-"));
  const receipt = buildOpenApiLiveJourneyReceipt({
    ...commonReceiptInput(),
    provider: { type: "openapi", adapter: "bounded-openapi", adapterVersion: 1 },
    source: { identityDigest: HASH, documentIdentityDigest: OTHER_HASH },
  }, SIGNING_KEY, NOW);
  try {
    const permissive = join(root, "permissive");
    await mkdir(permissive, { mode: 0o755 });
    await chmod(permissive, 0o755);
    await assert.rejects(writeProductionLiveReceipt({ mode: "live", directory: permissive, receipt }),
      /RECEIPT_DIRECTORY_PERMISSIONS_INVALID/);

    const privateDirectory = join(root, "private");
    await mkdir(privateDirectory, { mode: 0o700 });
    const linkedDirectory = join(root, "linked");
    await symlink(privateDirectory, linkedDirectory, "dir");
    await assert.rejects(writeProductionLiveReceipt({ mode: "live", directory: linkedDirectory, receipt }),
      /RECEIPT_DIRECTORY_INVALID/);

    const external = join(root, "external.json");
    await writeFile(external, "untrusted", { encoding: "utf8", mode: 0o600 });
    await symlink(external, join(privateDirectory, `${receipt.integrity.digest}.json`));
    await assert.rejects(writeProductionLiveReceipt({ mode: "live", directory: privateDirectory, receipt }),
      /RECEIPT_FILE_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
