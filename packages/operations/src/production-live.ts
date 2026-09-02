import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { validateTargetUrl } from "../../security/src/security.ts";

export type ProductionLiveJourney = "openapi" | "website";
export type ProductionLiveMode = "dry-run" | "live";
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const SUPABASE_PROJECT_REF = "bimqgiedckdurqiywctl";
const SUPABASE_ORIGIN = `https://${SUPABASE_PROJECT_REF}.supabase.co`;
const HOSTED_PUBLIC_ORIGIN = `${SUPABASE_ORIGIN}/storage/v1/object/public/page2webmcp-releases`;
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const MIGRATION = /^\d{14}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DEPLOYMENT_RELEASE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const JAVASCRIPT_MIME = "application/javascript";

export const PRODUCTION_LIVE_COMMON_CONTROLS = Object.freeze([
  "DATABASE_URL",
  "PAGE2WEBMCP_MAINTENANCE_DATABASE_URL",
  "PAGE2WEBMCP_STORAGE_MODE",
  "PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN",
  "PAGE2WEBMCP_SUPABASE_URL",
  "PAGE2WEBMCP_SUPABASE_SECRET_KEY",
  "PAGE2WEBMCP_PUBLIC_ORIGIN",
  "PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN",
  "PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN",
  "PAGE2WEBMCP_GIT_COMMIT_SHA",
  "PAGE2WEBMCP_APPLICATION_RELEASE_ID",
  "PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE",
  "PAGE2WEBMCP_RECEIPT_SIGNING_KEY",
] as const);

export const OPENAPI_PRODUCTION_LIVE_CONTROLS = Object.freeze([
  "PAGE2WEBMCP_PROVIDER_MODE",
  "PAGE2WEBMCP_E2E_SOURCE_URL",
  "PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN",
  "PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL",
  "PAGE2WEBMCP_E2E_INSTALL_PAGE_URL",
  "PAGE2WEBMCP_E2E_ENVIRONMENT",
] as const);

// Keep this byte-for-byte aligned with apps/worker/src/website-live.ts WEBSITE_LIVE_KEYS.
export const WEBSITE_PRODUCTION_LIVE_CONTROLS = Object.freeze([
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
] as const);

const WEBSITE_JOURNEY_CONTROLS = Object.freeze([
  ...WEBSITE_PRODUCTION_LIVE_CONTROLS,
  "PAGE2WEBMCP_PROVIDER_MODE",
  "PAGE2WEBMCP_E2E_SOURCE_URL",
  "PAGE2WEBMCP_E2E_INSTALL_PAGE_URL",
  "PAGE2WEBMCP_E2E_ENVIRONMENT",
] as const);

const SHARED_OPERATIONS = [
  "authenticate-operator",
  "create-or-select-project",
  "enqueue-analysis",
  "review-capabilities",
  "verify-candidate",
  "connect-application-database",
  "connect-maintenance-database",
  "install-selected-release",
  "persist-installation-attestation",
  "publish-content-addressed-artifact",
  "request-native-installation-attestation",
  "run-live-readiness",
  "verify-deployed-identity",
  "verify-hosted-artifact",
  "verify-named-download",
  "write-immutable-receipt",
] as const;
// Artifact generation is not separately observable: the journey only ever sees
// the published content-addressed artifact, which publish-content-addressed-artifact
// already records. Every remaining operation below is bound to persisted evidence.
const OPENAPI_OPERATIONS = [
  "fetch-and-freeze-openapi-document",
  ...SHARED_OPERATIONS,
] as const;
const WEBSITE_OPERATIONS = [
  "complete-authentication-handoff",
  "create-browser-use-session",
  "install-egress-policy",
  "observe-browser-session",
  "reconcile-browser-controls",
  "restart-and-resume-worker",
  "verify-source-ownership",
  ...SHARED_OPERATIONS,
] as const;

export type ProductionLiveCommandResultV1 = Readonly<{
  schema: "ProductionLiveCommandResultV1";
  journey: ProductionLiveJourney;
  mode: ProductionLiveMode;
  status: "passed" | "failed";
  code: string;
  missingControls: readonly string[];
  plannedOperations: readonly string[];
  completedOperations: readonly string[];
  receiptLocation?: string;
  receiptDigest?: string;
  liveSuccess: boolean;
}>;

export function inspectProductionLiveControls(
  journey: ProductionLiveJourney,
  environment: RuntimeEnvironment,
): Readonly<{ journey: ProductionLiveJourney; missingControls: string[] }> {
  const invalid = new Set<string>();
  const required = journey === "openapi"
    ? [...PRODUCTION_LIVE_COMMON_CONTROLS, ...OPENAPI_PRODUCTION_LIVE_CONTROLS]
    : [...PRODUCTION_LIVE_COMMON_CONTROLS, ...WEBSITE_JOURNEY_CONTROLS];
  for (const key of required) if (!environment[key]) invalid.add(key);

  const applicationDatabase = hostedDatabaseIdentity(environment.DATABASE_URL);
  const maintenanceDatabase = hostedDatabaseIdentity(environment.PAGE2WEBMCP_MAINTENANCE_DATABASE_URL);
  if (!applicationDatabase) invalid.add("DATABASE_URL");
  if (!maintenanceDatabase) {
    invalid.add("PAGE2WEBMCP_MAINTENANCE_DATABASE_URL");
  }
  if (applicationDatabase && maintenanceDatabase
    && applicationDatabase.username === maintenanceDatabase.username) {
    invalid.add("DATABASE_URL");
    invalid.add("PAGE2WEBMCP_MAINTENANCE_DATABASE_URL");
  }
  if (environment.PAGE2WEBMCP_STORAGE_MODE !== "postgres") invalid.add("PAGE2WEBMCP_STORAGE_MODE");
  if (!productionHttpsOrigin(environment.PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN)) {
    invalid.add("PAGE2WEBMCP_CONTROL_PLANE_PUBLIC_ORIGIN");
  }
  if (environment.PAGE2WEBMCP_SUPABASE_URL !== SUPABASE_ORIGIN) invalid.add("PAGE2WEBMCP_SUPABASE_URL");
  if (!boundedSecret(environment.PAGE2WEBMCP_SUPABASE_SECRET_KEY)) {
    invalid.add("PAGE2WEBMCP_SUPABASE_SECRET_KEY");
  }
  if (environment.PAGE2WEBMCP_PUBLIC_ORIGIN !== HOSTED_PUBLIC_ORIGIN) invalid.add("PAGE2WEBMCP_PUBLIC_ORIGIN");
  if (!productionHttpsOrigin(environment.PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN)) {
    invalid.add("PAGE2WEBMCP_RELEASE_VERIFIER_ORIGIN");
  }
  if (!boundedSecret(environment.PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN)) {
    invalid.add("PAGE2WEBMCP_RELEASE_VERIFIER_TOKEN");
  }
  if (!COMMIT.test(environment.PAGE2WEBMCP_GIT_COMMIT_SHA ?? "")) invalid.add("PAGE2WEBMCP_GIT_COMMIT_SHA");
  if (!DEPLOYMENT_RELEASE_ID.test(environment.PAGE2WEBMCP_APPLICATION_RELEASE_ID ?? "")) {
    invalid.add("PAGE2WEBMCP_APPLICATION_RELEASE_ID");
  }
  if (!boundedPath(environment.PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE)) {
    invalid.add("PAGE2WEBMCP_OPERATOR_CREDENTIALS_FILE");
  }
  if (!boundedSecret(environment.PAGE2WEBMCP_RECEIPT_SIGNING_KEY)) {
    invalid.add("PAGE2WEBMCP_RECEIPT_SIGNING_KEY");
  }

  if (journey === "openapi") inspectOpenApiControls(environment, invalid);
  else inspectWebsiteControls(environment, invalid);
  return { journey, missingControls: [...invalid].sort() };
}

// A configured local stack silently downgrades the release verifier and Storage
// topology to loopback. The production-live operator path must never run beside
// one, so the preflight names the offending controls before any effect.
export const PRODUCTION_LIVE_FORBIDDEN_LOCAL_CONTROLS = Object.freeze([
  "PAGE2WEBMCP_LOCAL_RELEASE_VERIFIER_ORIGIN",
  "PAGE2WEBMCP_LOCAL_STACK",
] as const);

export function inspectForbiddenLocalControls(environment: RuntimeEnvironment): string[] {
  return PRODUCTION_LIVE_FORBIDDEN_LOCAL_CONTROLS
    .filter((key) => typeof environment[key] === "string" && environment[key]!.length > 0)
    .sort();
}

export function evaluateProductionLivePreflight(input: Readonly<{
  journey: ProductionLiveJourney;
  mode: ProductionLiveMode;
  environment: RuntimeEnvironment;
}>): ProductionLiveCommandResultV1 {
  const inspection = inspectProductionLiveControls(input.journey, input.environment);
  const plannedOperations = input.journey === "openapi" ? OPENAPI_OPERATIONS : WEBSITE_OPERATIONS;
  const forbiddenLocalControls = inspectForbiddenLocalControls(input.environment);
  if (forbiddenLocalControls.length > 0) {
    return Object.freeze({
      schema: "ProductionLiveCommandResultV1",
      journey: input.journey,
      mode: input.mode,
      status: "failed",
      code: "PRODUCTION_LIVE_LOCAL_STACK_FORBIDDEN",
      missingControls: Object.freeze(forbiddenLocalControls),
      plannedOperations: Object.freeze([...plannedOperations]),
      completedOperations: Object.freeze([]),
      liveSuccess: false,
    });
  }
  if (inspection.missingControls.length > 0) {
    return Object.freeze({
      schema: "ProductionLiveCommandResultV1",
      journey: input.journey,
      mode: input.mode,
      status: "failed",
      code: "PRODUCTION_LIVE_CONTROLS_REQUIRED",
      missingControls: Object.freeze(inspection.missingControls),
      plannedOperations: Object.freeze([...plannedOperations]),
      completedOperations: Object.freeze([]),
      liveSuccess: false,
    });
  }
  return Object.freeze({
    schema: "ProductionLiveCommandResultV1",
    journey: input.journey,
    mode: input.mode,
    status: "passed",
    code: input.mode === "dry-run" ? "PRODUCTION_LIVE_DRY_RUN_READY" : "PRODUCTION_LIVE_READY_TO_EXECUTE",
    missingControls: Object.freeze([]),
    plannedOperations: Object.freeze([...plannedOperations]),
    completedOperations: Object.freeze([]),
    liveSuccess: false,
  });
}

export function parseProductionLiveCommandArguments(args: readonly string[]): Readonly<{
  journey: ProductionLiveJourney;
  mode: ProductionLiveMode;
}> | undefined {
  if (args.length !== 3 || args[1] !== "--provider") return undefined;
  const mode = args[0] === "--dry-run" ? "dry-run" : args[0] === "--live" ? "live" : undefined;
  const journey = args[2] === "openapi" ? "openapi" : args[2] === "website" ? "website" : undefined;
  return mode && journey ? { mode, journey } : undefined;
}

function inspectOpenApiControls(environment: RuntimeEnvironment, invalid: Set<string>): void {
  if (environment.PAGE2WEBMCP_PROVIDER_MODE !== "openapi") invalid.add("PAGE2WEBMCP_PROVIDER_MODE");
  if (!productionHttpsUrl(environment.PAGE2WEBMCP_E2E_SOURCE_URL)) invalid.add("PAGE2WEBMCP_E2E_SOURCE_URL");
  const target = environment.PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN;
  if (!productionHttpsOrigin(target)) invalid.add("PAGE2WEBMCP_OPENAPI_TARGET_ORIGIN");
  for (const key of ["PAGE2WEBMCP_OPENAPI_TEST_PAGE_URL", "PAGE2WEBMCP_E2E_INSTALL_PAGE_URL"] as const) {
    const value = environment[key];
    if (!productionHttpsUrl(value) || !target || new URL(value).origin !== target) invalid.add(key);
  }
  if (!isEnvironment(environment.PAGE2WEBMCP_E2E_ENVIRONMENT)) invalid.add("PAGE2WEBMCP_E2E_ENVIRONMENT");
}

function inspectWebsiteControls(environment: RuntimeEnvironment, invalid: Set<string>): void {
  if (environment.PAGE2WEBMCP_PROVIDER_MODE !== "website") invalid.add("PAGE2WEBMCP_PROVIDER_MODE");
  for (const key of WEBSITE_PRODUCTION_LIVE_CONTROLS) {
    const value = environment[key];
    if (key.endsWith("_ORIGIN") && key !== "PAGE2WEBMCP_PUBLIC_ORIGIN") {
      if (!productionHttpsOrigin(value)) invalid.add(key);
    } else if (key === "PAGE2WEBMCP_PUBLIC_ORIGIN") {
      if (value !== HOSTED_PUBLIC_ORIGIN) invalid.add(key);
    } else if (key === "PAGE2WEBMCP_BROWSER_USE_API_KEY") {
      if (!boundedSecret(value) || !/^bu_[A-Za-z0-9_-]+$/.test(value)) invalid.add(key);
    } else if (key === "PAGE2WEBMCP_SECRET_STORE_KMS_KEY_ID") {
      if (!value || value.length > 512 || !/^[\u0021-\u007e]+$/.test(value)) invalid.add(key);
    } else if (!boundedSecret(value)) invalid.add(key);
  }
  if (environment.PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN === environment.PAGE2WEBMCP_BROWSER_USE_API_ORIGIN) {
    invalid.add("PAGE2WEBMCP_AUTH_HANDOFF_ORIGIN");
    invalid.add("PAGE2WEBMCP_BROWSER_USE_API_ORIGIN");
  }
  const sourceUrl = environment.PAGE2WEBMCP_E2E_SOURCE_URL;
  if (!productionHttpsUrl(sourceUrl)) invalid.add("PAGE2WEBMCP_E2E_SOURCE_URL");
  const installPageUrl = environment.PAGE2WEBMCP_E2E_INSTALL_PAGE_URL;
  if (!productionHttpsUrl(installPageUrl)
    || productionHttpsUrl(sourceUrl) && new URL(installPageUrl!).origin !== new URL(sourceUrl).origin) {
    invalid.add("PAGE2WEBMCP_E2E_INSTALL_PAGE_URL");
  }
  // Website live receipts are intentionally bound to a production target. The
  // durable website source schema does not carry an environment field, so
  // accepting test/staging here would allow browser effects and then fail only
  // when the maintenance projection reports the authoritative production value.
  if (environment.PAGE2WEBMCP_E2E_ENVIRONMENT !== "production") {
    invalid.add("PAGE2WEBMCP_E2E_ENVIRONMENT");
  }
}

function hostedDatabaseIdentity(value: string | undefined): Readonly<{ username: string }> | undefined {
  if (!value || value.length < 16 || value.length > 4_096 || value.trim() !== value || /[\r\n]/.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || !/^[A-Za-z0-9_.-]+$/.test(parsed.username) || parsed.password.length === 0
      || parsed.pathname !== "/postgres" || parsed.hash
      || !validateTargetUrl(`https://${parsed.hostname}`).ok) return undefined;
    const direct = parsed.hostname === `db.${SUPABASE_PROJECT_REF}.supabase.co`
      && (parsed.port === "" || parsed.port === "5432");
    const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(parsed.hostname)
      && (parsed.port === "5432" || parsed.port === "6543")
      && parsed.username.endsWith(`.${SUPABASE_PROJECT_REF}`)
      && parsed.username.length > SUPABASE_PROJECT_REF.length + 1;
    if (!direct && !pooler) return undefined;
    if (parsed.searchParams.size > 1) return undefined;
    if (parsed.searchParams.size === 1
      && !["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode") ?? "")) {
      return undefined;
    }
    return { username: parsed.username };
  } catch { return undefined; }
}

function exactHttpsOrigin(value: string | undefined): value is string {
  if (!value || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value && parsed.pathname === "/"
      && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function productionHttpsOrigin(value: string | undefined): value is string {
  return exactHttpsOrigin(value) && validateTargetUrl(value).ok && productionHostname(new URL(value).hostname);
}

function productionHttpsUrl(value: string | undefined): value is string {
  if (!value || value.length > 2_048 || !validateTargetUrl(value).ok) return false;
  try {
    const parsed = new URL(value);
    return !parsed.hash && productionHostname(parsed.hostname);
  } catch { return false; }
}

function productionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return !/(?:^|\.)acme(?:\.|$)/.test(normalized)
    && !normalized.endsWith(".example") && !normalized.endsWith(".test") && !normalized.endsWith(".invalid");
}

function boundedSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 4_096
    && /^[\u0021-\u007e]+$/.test(value);
}

function boundedPath(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && value.trim() === value && !/[\r\n\0]/.test(value);
}

function isEnvironment(value: string | undefined): value is "test" | "staging" | "production" {
  return value === "test" || value === "staging" || value === "production";
}

const DigestSchema = z.string().regex(HASH);
const TimestampSchema = z.string().datetime({ offset: true });
const IdentitySchema = z.object({ identityDigest: DigestSchema }).strict();
const ByteIdentitySchema = z.object({
  identityDigest: DigestSchema,
  sha256: DigestSchema,
  size: z.number().int().nonnegative(),
  mimeType: z.literal(JAVASCRIPT_MIME),
}).strict();
const VerifierAttestationIdentitySchema = z.object({
  attestationId: z.string().uuid(),
  requestId: z.string().uuid(),
  operation: z.enum(["candidate", "installation"]),
  nonceDigest: DigestSchema,
  scopeDigest: DigestSchema,
  payloadDigest: DigestSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  attestedAt: TimestampSchema,
}).strict();
const CommonReceiptShape = {
  schemaVersion: z.literal(1),
  deployment: z.object({
    gitCommitSha: z.string().regex(COMMIT),
    applicationReleaseId: z.string().regex(DEPLOYMENT_RELEASE_ID),
    controlPlaneOrigin: z.string().url().max(2_048),
    controlPlaneIdentityDigest: DigestSchema,
    sourceTreeSha256: DigestSchema,
  }).strict(),
  database: z.object({
    projectRef: z.literal(SUPABASE_PROJECT_REF),
    migrationRange: z.object({
      from: z.string().regex(MIGRATION),
      to: z.string().regex(MIGRATION),
      digest: DigestSchema,
    }).strict(),
    applicationRoleDigest: DigestSchema,
    maintenanceRoleDigest: DigestSchema,
  }).strict(),
  project: z.object({
    organizationIdentityDigest: DigestSchema,
    identityDigest: DigestSchema,
  }).strict(),
  source: z.object({ identityDigest: DigestSchema, documentIdentityDigest: DigestSchema }).strict(),
  target: z.object({
    origin: z.string().url().max(2_048),
    environment: z.enum(["test", "staging", "production"]),
    testPageIdentityDigest: DigestSchema,
    installPageIdentityDigest: DigestSchema,
  }).strict(),
  release: z.object({
    identityDigest: DigestSchema,
    releaseId: z.string().regex(OPAQUE_ID),
    selectedHash: DigestSchema,
  }).strict(),
  artifact: z.object({
    sha256: DigestSchema,
    sri: z.string().regex(SRI),
    size: z.number().int().positive(),
    mimeType: z.literal(JAVASCRIPT_MIME),
  }).strict(),
  hostedObject: ByteIdentitySchema.extend({
    projectRef: z.literal(SUPABASE_PROJECT_REF),
    bucket: z.literal("page2webmcp-releases"),
    path: z.string().max(128),
  }).strict(),
  namedDownload: ByteIdentitySchema,
  installation: z.object({
    identityDigest: DigestSchema,
    installedSha256: DigestSchema,
    targetOrigin: z.string().url().max(2_048),
    environment: z.enum(["test", "staging", "production"]),
    verifiedAt: TimestampSchema,
  }).strict(),
  verifier: z.object({
    identityDigest: DigestSchema,
    protocolVersion: z.literal(2),
    candidate: VerifierAttestationIdentitySchema.extend({
      operation: z.literal("candidate"),
    }).strict(),
    installation: VerifierAttestationIdentitySchema.extend({
      operation: z.literal("installation"),
    }).strict(),
  }).strict(),
  cleanup: z.object({ status: z.literal("passed"), revocationDigest: DigestSchema }).strict(),
  readiness: z.object({
    status: z.enum(["passed", "failed"]),
    code: z.string().min(1).max(128),
    evidenceDigest: DigestSchema,
  }).strict(),
  liveSuccess: z.boolean(),
  integrity: z.object({ algorithm: z.literal("sha256"), digest: DigestSchema }).strict(),
  signature: z.object({
    algorithm: z.literal("hmac-sha256"),
    keyIdDigest: DigestSchema,
    value: DigestSchema,
  }).strict(),
} as const;

export const OpenApiLiveJourneyReceiptV1Schema = z.object({
  schema: z.literal("OpenApiLiveJourneyReceiptV1"),
  ...CommonReceiptShape,
  provider: z.object({
    type: z.literal("openapi"),
    adapter: z.literal("bounded-openapi"),
    adapterVersion: z.literal(1),
  }).strict(),
}).strict();

export const WebsiteBrowserUseLiveJourneyReceiptV1Schema = z.object({
  schema: z.literal("WebsiteBrowserUseLiveJourneyReceiptV1"),
  ...CommonReceiptShape,
  provider: z.object({
    type: z.literal("website"),
    adapter: z.literal("browser-use-v4"),
    adapterVersion: z.literal(4),
  }).strict(),
  browserUse: z.object({ sessionIdentityDigest: DigestSchema }).strict(),
  ownership: z.object({ decisionDigest: DigestSchema, verified: z.literal(true) }).strict(),
  browserLease: IdentitySchema,
  egress: z.object({ policyDigest: DigestSchema, referenceDigest: DigestSchema }).strict(),
  cdpObservation: IdentitySchema,
  authentication: z.object({
    checkpointDigest: DigestSchema,
    handoffDigest: DigestSchema,
    completed: z.literal(true),
    workerRestartDigest: DigestSchema,
    resumeDigest: DigestSchema,
    ttlSecretReferenceDigest: DigestSchema,
  }).strict(),
  cleanup: z.object({
    status: z.literal("passed"),
    revocationDigest: DigestSchema,
    browserCleanupDigest: DigestSchema,
    controlCleanupDigest: DigestSchema,
  }).strict(),
}).strict();

export type OpenApiLiveJourneyReceiptV1 = Readonly<z.infer<typeof OpenApiLiveJourneyReceiptV1Schema>>;
export type WebsiteBrowserUseLiveJourneyReceiptV1 = Readonly<z.infer<typeof WebsiteBrowserUseLiveJourneyReceiptV1Schema>>;
type OpenApiReceiptInput =
  Omit<OpenApiLiveJourneyReceiptV1, "schema" | "schemaVersion" | "integrity" | "signature">;
type WebsiteReceiptInput =
  Omit<WebsiteBrowserUseLiveJourneyReceiptV1, "schema" | "schemaVersion" | "integrity" | "signature">;
export type ProductionLiveReceiptV1 = OpenApiLiveJourneyReceiptV1 | WebsiteBrowserUseLiveJourneyReceiptV1;

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const SIGNING_KEY_IDENTITY_LABEL = "page2webmcp-receipt-signing-key-id";

// The receipt carries both an unkeyed digest, so any holder can detect accidental
// corruption, and an operator-keyed HMAC that only the signing key can produce.
export function receiptSignature(unsignedCanonical: string, signingKey: string): Readonly<{
  algorithm: "hmac-sha256";
  keyIdDigest: string;
  value: string;
}> {
  if (!boundedSecret(signingKey)) throw new Error("RECEIPT_SIGNING_KEY_REQUIRED");
  return Object.freeze({
    algorithm: "hmac-sha256" as const,
    keyIdDigest: createHmac("sha256", signingKey).update(SIGNING_KEY_IDENTITY_LABEL, "utf8").digest("hex"),
    value: createHmac("sha256", signingKey).update(unsignedCanonical, "utf8").digest("hex"),
  });
}

export function buildOpenApiLiveJourneyReceipt(
  input: OpenApiReceiptInput,
  signingKey: string,
  now = new Date(),
): OpenApiLiveJourneyReceiptV1 {
  return validateOpenApiLiveJourneyReceipt(
    signedReceipt({ schema: "OpenApiLiveJourneyReceiptV1" as const, schemaVersion: 1 as const, ...input }, signingKey),
    now,
    signingKey,
  );
}

export function buildWebsiteBrowserUseLiveJourneyReceipt(
  input: WebsiteReceiptInput,
  signingKey: string,
  now = new Date(),
): WebsiteBrowserUseLiveJourneyReceiptV1 {
  return validateWebsiteBrowserUseLiveJourneyReceipt(
    signedReceipt(
      { schema: "WebsiteBrowserUseLiveJourneyReceiptV1" as const, schemaVersion: 1 as const, ...input },
      signingKey,
    ),
    now,
    signingKey,
  );
}

function signedReceipt(unsigned: Record<string, unknown>, signingKey: string): Record<string, unknown> {
  if (!boundedSecret(signingKey)) throw new Error("RECEIPT_SIGNING_KEY_REQUIRED");
  const digested = { ...unsigned, integrity: { algorithm: "sha256", digest: canonicalJsonSha256(unsigned) } };
  return { ...digested, signature: receiptSignature(canonicalJson(digested), signingKey) };
}

export function validateOpenApiLiveJourneyReceipt(
  value: unknown,
  now = new Date(),
  signingKey?: string,
): OpenApiLiveJourneyReceiptV1 {
  return validateReceipt(OpenApiLiveJourneyReceiptV1Schema, value, now, signingKey);
}

export function validateWebsiteBrowserUseLiveJourneyReceipt(
  value: unknown,
  now = new Date(),
  signingKey?: string,
): WebsiteBrowserUseLiveJourneyReceiptV1 {
  return validateReceipt(WebsiteBrowserUseLiveJourneyReceiptV1Schema, value, now, signingKey);
}

function validateReceipt<T extends ProductionLiveReceiptV1>(
  schema: z.ZodType<T>,
  value: unknown,
  now: Date,
  signingKey?: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("RECEIPT_SCHEMA_INVALID");
  const receipt = parsed.data;
  const unsigned: Record<string, unknown> = { ...receipt };
  delete unsigned.integrity;
  delete unsigned.signature;
  if (receipt.integrity.digest !== canonicalJsonSha256(unsigned)) throw new Error("RECEIPT_INTEGRITY_INVALID");
  if (signingKey !== undefined) {
    const signed: Record<string, unknown> = { ...receipt };
    delete signed.signature;
    const expected = receiptSignature(canonicalJson(signed), signingKey);
    if (!sameDigest(expected.value, receipt.signature.value)
      || !sameDigest(expected.keyIdDigest, receipt.signature.keyIdDigest)) {
      throw new Error("RECEIPT_SIGNATURE_INVALID");
    }
  }
  if (!productionHttpsOrigin(receipt.deployment.controlPlaneOrigin)
    || !productionHttpsOrigin(receipt.target.origin)
    || !productionHttpsOrigin(receipt.installation.targetOrigin)) {
    throw new Error("RECEIPT_ORIGIN_INVALID");
  }
  const candidate = receipt.verifier.candidate;
  const installation = receipt.verifier.installation;
  for (const attestation of [candidate, installation]) {
    const attestedAt = new Date(attestation.attestedAt).getTime();
    const issuedAt = new Date(attestation.issuedAt).getTime();
    const expiresAt = new Date(attestation.expiresAt).getTime();
    if (attestedAt > now.getTime()) throw new Error("RECEIPT_ATTESTATION_FUTURE");
    if (issuedAt > attestedAt || attestedAt >= expiresAt || expiresAt - issuedAt > 120_000) {
      throw new Error("RECEIPT_VERIFIER_TIMELINE_INVALID");
    }
  }
  const installationVerifiedAt = new Date(receipt.installation.verifiedAt).getTime();
  if (installationVerifiedAt > now.getTime()) throw new Error("RECEIPT_ATTESTATION_FUTURE");
  if (installationVerifiedAt < new Date(installation.attestedAt).getTime()) {
    throw new Error("RECEIPT_VERIFIER_TIMELINE_INVALID");
  }
  if (candidate.attestationId === installation.attestationId
    || candidate.requestId === installation.requestId
    || Date.parse(candidate.attestedAt) > Date.parse(installation.attestedAt)) {
    throw new Error("RECEIPT_VERIFIER_CONTINUITY_INVALID");
  }
  if (receipt.liveSuccess && (receipt.readiness.status !== "passed"
    || receipt.readiness.code !== "LIVE_READINESS_PASSED")) {
    throw new Error("RECEIPT_LIVE_SUCCESS_INVALID");
  }
  const artifact = receipt.artifact;
  if (receipt.release.selectedHash !== artifact.sha256
    || receipt.hostedObject.sha256 !== artifact.sha256
    || receipt.namedDownload.sha256 !== artifact.sha256
    || receipt.installation.installedSha256 !== artifact.sha256
    || receipt.hostedObject.path !== `${artifact.sha256}.js`
    || receipt.hostedObject.size !== artifact.size
    || receipt.namedDownload.size !== artifact.size
    || receipt.hostedObject.mimeType !== artifact.mimeType
    || receipt.namedDownload.mimeType !== artifact.mimeType
    || receipt.installation.targetOrigin !== receipt.target.origin
    || receipt.installation.environment !== receipt.target.environment) {
    throw new Error("RECEIPT_IDENTITY_MISMATCH");
  }
  return Object.freeze(receipt);
}

export async function writeProductionLiveReceipt(input: Readonly<{
  mode: ProductionLiveMode;
  directory: string;
  receipt: ProductionLiveReceiptV1;
}>): Promise<string | undefined> {
  if (input.mode === "dry-run") return undefined;
  const receipt = input.receipt.schema === "OpenApiLiveJourneyReceiptV1"
    ? validateOpenApiLiveJourneyReceipt(input.receipt)
    : validateWebsiteBrowserUseLiveJourneyReceipt(input.receipt);
  const directory = resolve(input.directory);
  const location = resolve(directory, `${receipt.integrity.digest}.json`);
  if (!isAbsolute(location) || !location.startsWith(`${directory}/`)) throw new Error("RECEIPT_LOCATION_INVALID");
  const bytes = `${canonicalJson(receipt)}\n`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("RECEIPT_DIRECTORY_INVALID");
  assertCurrentOwner(directoryStat.uid, "RECEIPT_DIRECTORY_OWNER_INVALID");
  if ((directoryStat.mode & 0o777) !== 0o700) throw new Error("RECEIPT_DIRECTORY_PERMISSIONS_INVALID");
  try {
    const handle = await open(
      location,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes, { encoding: "utf8" });
      await handle.sync();
      const created = await handle.stat();
      if (!created.isFile()) throw new Error("RECEIPT_FILE_INVALID");
      assertCurrentOwner(created.uid, "RECEIPT_FILE_OWNER_INVALID");
      if ((created.mode & 0o777) !== 0o600) throw new Error("RECEIPT_FILE_PERMISSIONS_INVALID");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    let handle;
    try {
      handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
      const existingStat = await handle.stat();
      if (!existingStat.isFile()) throw new Error("RECEIPT_FILE_INVALID");
      assertCurrentOwner(existingStat.uid, "RECEIPT_FILE_OWNER_INVALID");
      if ((existingStat.mode & 0o777) !== 0o600) throw new Error("RECEIPT_FILE_PERMISSIONS_INVALID");
      if (await handle.readFile("utf8") !== bytes) throw new Error("RECEIPT_CONTENT_CONFLICT");
    } catch (readError) {
      if (readError instanceof Error && readError.message.startsWith("RECEIPT_")) throw readError;
      throw new Error("RECEIPT_FILE_INVALID");
    } finally {
      await handle?.close();
    }
  }
  return location;
}

function sameDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertCurrentOwner(actualUid: number, code: string): void {
  if (typeof process.getuid === "function" && actualUid !== process.getuid()) throw new Error(code);
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("CANONICAL_JSON_INVALID");
}
