import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionLiveReceiptContextRepository,
  mapSelectedProductionLiveReceiptEvidence,
} from "./production-live-receipt-evidence.ts";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const SELECTED_HASH = "c".repeat(64);
const ORIGIN = "https://widgets.dev";
const ARTIFACT = `https://bimqgiedckdurqiywctl.supabase.co/storage/v1/object/public/page2webmcp-releases/${SELECTED_HASH}.js`;

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    selected_release_hash: SELECTED_HASH,
    release_id_digest: HASH,
    organization_identity_digest: HASH,
    project_identity_digest: HASH,
    analysis_run_identity_digest: HASH,
    source_type: "openapi",
    source_identity_digest: HASH,
    source_document_identity_digest: OTHER_HASH,
    source_identity_hash: HASH,
    target_origin: ORIGIN,
    environment: "production",
    test_page_identity_digest: HASH,
    install_page_identity_digest: OTHER_HASH,
    artifact_url: ARTIFACT,
    download_url: `${ARTIFACT}?download=page2webmcp-${SELECTED_HASH}.js`,
    artifact_size_bytes: 1024,
    artifact_integrity: "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    hosted_object_identity_digest: HASH,
    named_download_identity_digest: OTHER_HASH,
    installation_identity_digest: HASH,
    provider_mode: "openapi",
    provider_adapter: "bounded-openapi",
    provider_adapter_version: 1,
    migration_from: "20260826000000",
    migration_to: "20260901140000",
    migration_digest: HASH,
    openapi_cleanup_digest: OTHER_HASH,
    candidate_verifier_origin_digest: HASH,
    installation_verifier_origin_digest: HASH,
    candidate_attestation_id: "11111111-1111-4111-8111-111111111111",
    candidate_attestation_request_id: "22222222-2222-4222-8222-222222222222",
    candidate_attestation_nonce_digest: HASH,
    candidate_attestation_scope_digest: HASH,
    candidate_attestation_payload_digest: HASH,
    candidate_attestation_issued_at: "2026-09-01T11:58:00.000Z",
    candidate_attestation_expires_at: "2026-09-01T12:00:00.000Z",
    candidate_attestation_attested_at: "2026-09-01T11:59:00.000Z",
    installation_attestation_id: "33333333-3333-4333-8333-333333333333",
    installation_attestation_request_id: "44444444-4444-4444-8444-444444444444",
    installation_attestation_nonce_digest: OTHER_HASH,
    installation_attestation_scope_digest: OTHER_HASH,
    installation_attestation_payload_digest: OTHER_HASH,
    installation_attestation_issued_at: "2026-09-01T11:59:00.000Z",
    installation_attestation_expires_at: "2026-09-01T12:01:00.000Z",
    installation_attestation_attested_at: "2026-09-01T12:00:00.000Z",
    installation_verified_at: "2026-09-01T12:00:01.000Z",
    ...overrides,
  };
}

test("maps only an exact hosted v2 production receipt identity", () => {
  const result = mapSelectedProductionLiveReceiptEvidence(validRow());
  assert.equal(result.selectedReleaseHash, SELECTED_HASH);
  assert.equal(result.provider.mode, "openapi");
  assert.equal(result.verifier.protocolVersion, 2);
  assert.equal(result.verifier.candidate.operation, "candidate");
  assert.equal(result.verifier.installation.operation, "installation");
  assert.equal(result.openapiCleanupDigest, OTHER_HASH);
  const serialized = JSON.stringify(result);
  for (const forbidden of ["organizationId", "projectId", "sourceUrl", "pageUrl", "token", "secret", "cookie"]) {
    assert.equal(new RegExp(`"${forbidden}"`, "i").test(serialized), false);
  }
});

test("rejects unknown columns, cross-provider identities, non-hosted bytes, and broken verifier continuity", () => {
  const cases = [
    validRow({ raw_secret: "must-not-pass" }),
    validRow({ provider_mode: "website" }),
    validRow({ artifact_url: `http://127.0.0.1:58321/${SELECTED_HASH}.js` }),
    validRow({ installation_verifier_origin_digest: OTHER_HASH }),
    validRow({ installation_attestation_id: "11111111-1111-4111-8111-111111111111" }),
    validRow({ candidate_attestation_expires_at: "2026-09-01T12:00:00.001Z" }),
    validRow({ installation_attestation_attested_at: "2026-09-01T11:58:59.000Z" }),
    validRow({ installation_verified_at: "2026-09-01T11:59:59.000Z" }),
  ];
  for (const row of cases) {
    assert.throws(() => mapSelectedProductionLiveReceiptEvidence(row), /PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID/);
  }
});

test("website evidence cannot claim stateless OpenAPI cleanup", () => {
  const website = mapSelectedProductionLiveReceiptEvidence(validRow({
    source_type: "website",
    provider_mode: "website",
    provider_adapter: "browser-use-v4",
    provider_adapter_version: 4,
    openapi_cleanup_digest: null,
  }));
  assert.equal(website.provider.mode, "website");
  assert.equal(website.openapiCleanupDigest, undefined);
  assert.throws(() => mapSelectedProductionLiveReceiptEvidence(validRow({
    source_type: "website",
    provider_mode: "website",
    provider_adapter: "browser-use-v4",
    provider_adapter_version: 4,
  })), /PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID/);
});

test("repository reads one exact hash through the maintenance function in a bounded snapshot", async () => {
  const queries: Array<Readonly<{ text: string; values?: readonly unknown[] }>> = [];
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return text.startsWith("select * from private.selected_production")
        ? { rows: [validRow()] }
        : { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client, end: async () => undefined };
  const repository = createProductionLiveReceiptContextRepository({
    connectionString: "postgresql://maintenance:secret@db.widgets.dev/postgres",
    pool,
  });
  assert.equal((await repository.findSelected(SELECTED_HASH))?.selectedReleaseHash, SELECTED_HASH);
  assert.deepEqual(queries.map(({ text }) => text), [
    "begin isolation level repeatable read read only",
    "set local role page2webmcp_maintenance",
    "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
    "select * from private.selected_production_live_receipt_evidence($1)",
    "commit",
  ]);
  assert.deepEqual(queries[3]?.values, [SELECTED_HASH]);
  await repository.close();
});

test("repository rejects invalid hashes and duplicate or mismatched rows", async () => {
  const repository = (rows: readonly Record<string, unknown>[]) => createProductionLiveReceiptContextRepository({
    connectionString: "postgresql://maintenance:secret@db.widgets.dev/postgres",
    pool: {
      connect: async () => ({
        query: async (text: string) => text.startsWith("select *") ? { rows } : { rows: [] },
        release() {},
      }),
      end: async () => undefined,
    },
  });
  await assert.rejects(repository([]).findSelected("not-a-hash"), /PRODUCTION_LIVE_RECEIPT_HASH_INVALID/);
  await assert.rejects(repository([validRow(), validRow()]).findSelected(SELECTED_HASH),
    /PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID/);
  await assert.rejects(repository([validRow({ selected_release_hash: "d".repeat(64) })]).findSelected(SELECTED_HASH),
    /PRODUCTION_LIVE_RECEIPT_EVIDENCE_INVALID/);
});
