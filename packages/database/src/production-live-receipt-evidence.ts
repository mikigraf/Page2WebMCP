import pg from "pg";
import { deployedMigrationRange } from "./migration-ledger.ts";

const HASH = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const HOSTED_ORIGIN =
  "https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases";

type VerifierAttestationIdentity = Readonly<{
  attestationId: string;
  requestId: string;
  operation: "candidate" | "installation";
  nonceDigest: string;
  scopeDigest: string;
  payloadDigest: string;
  issuedAt: string;
  expiresAt: string;
  attestedAt: string;
}>;

export type SelectedProductionLiveReceiptEvidence = Readonly<{
  selectedReleaseHash: string;
  releaseIdDigest: string;
  organizationIdentityDigest: string;
  projectIdentityDigest: string;
  analysisRunIdentityDigest: string;
  sourceType: "openapi" | "website";
  sourceIdentityDigest: string;
  sourceDocumentIdentityDigest: string;
  sourceIdentityHash: string;
  targetOrigin: string;
  environment: "test" | "staging" | "production";
  testPageIdentityDigest: string;
  installPageIdentityDigest: string;
  artifactUrl: string;
  downloadUrl: string;
  artifactSizeBytes: number;
  artifactIntegrity: string;
  hostedObjectIdentityDigest: string;
  namedDownloadIdentityDigest: string;
  installationIdentityDigest: string;
  provider:
    | Readonly<{ mode: "openapi"; adapter: "bounded-openapi"; adapterVersion: 1 }>
    | Readonly<{ mode: "website"; adapter: "browser-use-v4"; adapterVersion: 4 }>;
  migrationRange: Readonly<{ from: string; to: string; digest: string }>;
  openapiCleanupDigest?: string;
  verifier: Readonly<{
    identityDigest: string;
    protocolVersion: 2;
    candidate: VerifierAttestationIdentity & Readonly<{ operation: "candidate" }>;
    installation: VerifierAttestationIdentity & Readonly<{ operation: "installation" }>;
  }>;
  installationVerifiedAt: string;
}>;

type ContextQueryResult = Readonly<{ rows: readonly Record<string, unknown>[] }>;
type ContextClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<ContextQueryResult>;
  release(): void;
}>;
export type ProductionLiveReceiptContextPool = Readonly<{
  connect(): Promise<ContextClient>;
  end(): Promise<void>;
}>;
export type ProductionLiveReceiptContextRepository = Readonly<{
  findSelected(hash: string): Promise<SelectedProductionLiveReceiptEvidence | undefined>;
  close(): Promise<void>;
}>;

export function createProductionLiveReceiptContextRepository(options: Readonly<{
  connectionString: string;
  pool?: ProductionLiveReceiptContextPool;
  poolFactory?: (configuration: pg.PoolConfig) => ProductionLiveReceiptContextPool;
  statementTimeoutMs?: number;
}>): ProductionLiveReceiptContextRepository {
  if (!options?.connectionString || options.connectionString.length > 4_096) {
    throw new Error("PRODUCTION_LIVE_RECEIPT_DATABASE_CONFIGURATION_REQUIRED");
  }
  const timeout = Math.max(250, Math.min(options.statementTimeoutMs ?? 5_000, 15_000));
  const pool = options.pool ?? (options.poolFactory ?? ((configuration) => new pg.Pool(configuration)))({
    connectionString: options.connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: timeout,
    statement_timeout: timeout,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    ssl: { rejectUnauthorized: true },
  });
  return {
    async findSelected(hash) {
      if (!HASH.test(hash)) throw new Error("PRODUCTION_LIVE_RECEIPT_HASH_INVALID");
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        await client.query("set local role page2webmcp_maintenance");
        await client.query(
          "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), "
            + "set_config('idle_in_transaction_session_timeout', $3, true)",
          [String(timeout), String(Math.min(timeout, 2_000)), String(timeout * 2)],
        );
        const result = await client.query(
          "select * from private.selected_production_live_receipt_evidence($1)",
          [hash],
        );
        if (result.rows.length > 1) throw new Error("PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID");
        const evidence = result.rows[0] ? mapSelectedProductionLiveReceiptEvidence(result.rows[0]) : undefined;
        if (evidence && evidence.selectedReleaseHash !== hash) {
          throw new Error("PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID");
        }
        await client.query("commit");
        return evidence;
      } catch (error) {
        try { await client.query("rollback"); } catch { /* preserve the bounded projection error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const COLUMNS = [
  "analysis_run_identity_digest", "artifact_integrity", "artifact_size_bytes", "artifact_url",
  "candidate_attestation_attested_at", "candidate_attestation_expires_at", "candidate_attestation_id",
  "candidate_attestation_issued_at", "candidate_attestation_nonce_digest",
  "candidate_attestation_payload_digest", "candidate_attestation_request_id",
  "candidate_attestation_scope_digest", "candidate_verifier_origin_digest", "download_url", "environment",
  "hosted_object_identity_digest", "install_page_identity_digest", "installation_attestation_attested_at",
  "installation_attestation_expires_at", "installation_attestation_id", "installation_attestation_issued_at",
  "installation_attestation_nonce_digest", "installation_attestation_payload_digest",
  "installation_attestation_request_id", "installation_attestation_scope_digest",
  "installation_identity_digest", "installation_verified_at", "installation_verifier_origin_digest",
  "migration_digest", "migration_from", "migration_to", "named_download_identity_digest",
  "openapi_cleanup_digest", "organization_identity_digest", "project_identity_digest", "provider_adapter",
  "provider_adapter_version", "provider_mode", "release_id_digest", "selected_release_hash",
  "source_document_identity_digest", "source_identity_digest", "source_identity_hash", "source_type",
  "target_origin", "test_page_identity_digest",
] as const;

export function mapSelectedProductionLiveReceiptEvidence(
  row: Readonly<Record<string, unknown>>,
): SelectedProductionLiveReceiptEvidence {
  if (!row || Object.keys(row).sort().join("\0") !== [...COLUMNS].sort().join("\0")) invalid();
  const selectedReleaseHash = digest(row.selected_release_hash);
  const artifactUrl = string(row.artifact_url);
  const downloadUrl = string(row.download_url);
  if (artifactUrl !== `${HOSTED_ORIGIN}/${selectedReleaseHash}.js`
    || downloadUrl !== `${artifactUrl}?download=page2webmcp-${selectedReleaseHash}.js`) invalid();
  const sourceType = row.source_type;
  const providerMode = row.provider_mode;
  const providerAdapter = row.provider_adapter;
  const providerAdapterVersion = integer(row.provider_adapter_version, 1, 20260310);
  if (sourceType !== providerMode || sourceType !== "openapi" && sourceType !== "website") invalid();
  const provider = sourceType === "openapi"
    ? providerAdapter === "bounded-openapi" && providerAdapterVersion === 1
      ? { mode: "openapi" as const, adapter: "bounded-openapi" as const, adapterVersion: 1 as const }
      : invalid()
    : providerAdapter === "browser-use-v4" && providerAdapterVersion === 4
      ? { mode: "website" as const, adapter: "browser-use-v4" as const, adapterVersion: 4 as const }
      : invalid();
  const candidateVerifier = digest(row.candidate_verifier_origin_digest);
  if (candidateVerifier !== digest(row.installation_verifier_origin_digest)) invalid();
  const candidate = attestation(row, "candidate");
  const installation = attestation(row, "installation");
  const installationVerifiedAt = instant(row.installation_verified_at);
  if (candidate.attestationId === installation.attestationId
    || candidate.requestId === installation.requestId
    || Date.parse(candidate.attestedAt) > Date.parse(installation.attestedAt)
    || Date.parse(installation.attestedAt) > Date.parse(installationVerifiedAt)) invalid();
  const openapiCleanup = row.openapi_cleanup_digest;
  if (sourceType === "openapi" ? !isDigest(openapiCleanup) : openapiCleanup !== null) invalid();
  const targetOrigin = exactProductionOrigin(row.target_origin);
  const environment = row.environment;
  if (environment !== "test" && environment !== "staging" && environment !== "production") invalid();
  const artifactSizeBytes = integer(row.artifact_size_bytes, 1, 65_536);
  if (typeof row.artifact_integrity !== "string" || !SRI.test(row.artifact_integrity)) invalid();
  // The applied range must equal exactly the ledger the deployed tree expects.
  const expectedMigrationRange = deployedMigrationRange();
  if (row.migration_from !== expectedMigrationRange.from
    || row.migration_to !== expectedMigrationRange.to) invalid();
  return Object.freeze({
    selectedReleaseHash,
    releaseIdDigest: digest(row.release_id_digest),
    organizationIdentityDigest: digest(row.organization_identity_digest),
    projectIdentityDigest: digest(row.project_identity_digest),
    analysisRunIdentityDigest: digest(row.analysis_run_identity_digest),
    sourceType,
    sourceIdentityDigest: digest(row.source_identity_digest),
    sourceDocumentIdentityDigest: digest(row.source_document_identity_digest),
    sourceIdentityHash: digest(row.source_identity_hash),
    targetOrigin,
    environment,
    testPageIdentityDigest: digest(row.test_page_identity_digest),
    installPageIdentityDigest: digest(row.install_page_identity_digest),
    artifactUrl,
    downloadUrl,
    artifactSizeBytes,
    artifactIntegrity: row.artifact_integrity,
    hostedObjectIdentityDigest: digest(row.hosted_object_identity_digest),
    namedDownloadIdentityDigest: digest(row.named_download_identity_digest),
    installationIdentityDigest: digest(row.installation_identity_digest),
    provider,
    migrationRange: {
      from: row.migration_from,
      to: row.migration_to,
      digest: digest(row.migration_digest),
    },
    ...(sourceType === "openapi" ? { openapiCleanupDigest: digest(openapiCleanup) } : {}),
    verifier: { identityDigest: candidateVerifier, protocolVersion: 2 as const, candidate, installation },
    installationVerifiedAt,
  });
}

function attestation(
  row: Readonly<Record<string, unknown>>,
  operation: "candidate",
): VerifierAttestationIdentity & Readonly<{ operation: "candidate" }>;
function attestation(
  row: Readonly<Record<string, unknown>>,
  operation: "installation",
): VerifierAttestationIdentity & Readonly<{ operation: "installation" }>;
function attestation(
  row: Readonly<Record<string, unknown>>,
  operation: "candidate" | "installation",
): VerifierAttestationIdentity {
  const prefix = `${operation}_attestation_`;
  const attestationId = uuid(row[`${prefix}id`]);
  const requestId = uuid(row[`${prefix}request_id`]);
  const issuedAt = instant(row[`${prefix}issued_at`]);
  const expiresAt = instant(row[`${prefix}expires_at`]);
  const attestedAt = instant(row[`${prefix}attested_at`]);
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  const attested = Date.parse(attestedAt);
  if (issued > attested || attested >= expires || expires - issued > 120_000) invalid();
  return Object.freeze({
    attestationId,
    requestId,
    operation,
    nonceDigest: digest(row[`${prefix}nonce_digest`]),
    scopeDigest: digest(row[`${prefix}scope_digest`]),
    payloadDigest: digest(row[`${prefix}payload_digest`]),
    issuedAt,
    expiresAt,
    attestedAt,
  });
}

function exactProductionOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) invalid();
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/"
      || url.username || url.password || url.search || url.hash
      || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname.endsWith(".example") || hostname.endsWith(".test") || hostname.endsWith(".invalid")
      || /(?:^|\.)acme(?:\.|$)/.test(hostname)) invalid();
    return value;
  } catch { return invalid(); }
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const normalized = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum || Number(normalized) > maximum) invalid();
  return Number(normalized);
}

function instant(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date)) invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid();
  return parsed.toISOString();
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_V4.test(value)) invalid();
  return value.toLowerCase();
}

function digest(value: unknown): string {
  if (!isDigest(value)) invalid();
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function invalid(): never {
  throw new Error("PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID");
}
