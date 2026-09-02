import { HASH_REFERENCE, IDENTIFIER } from "../constants.ts";
import { badRequest, notFound } from "../errors.ts";
import { EvidenceRejected, type EvidenceStore, type EvidenceRecord } from "../stores/evidence.ts";
import { assertOwnershipMatches, workerResponse, type WorkerEnvelope } from "../envelope.ts";
import { isPlainRecord } from "../canonical.ts";
import type { RouteResult } from "./types.ts";

export function putEvidence(store: EvidenceStore, envelope: WorkerEnvelope): RouteResult {
  const record = envelope.payload.record;
  if (!isPlainRecord(record)) throw badRequest("GATEWAY_EVIDENCE_REQUEST_INVALID");
  assertOwnershipMatches(envelope, {
    organizationId: record.organizationId,
    projectId: record.projectId,
    runId: record.analysisRunId,
  }, "GATEWAY_EVIDENCE_OWNERSHIP_MISMATCH");
  let stored: EvidenceRecord;
  try { stored = store.put(record as unknown as EvidenceRecord); }
  catch (error) {
    if (error instanceof EvidenceRejected) throw badRequest(`GATEWAY_${error.message}`);
    throw error;
  }
  return {
    status: 200,
    body: {
      gatewayProtocolVersion: envelope.gatewayProtocolVersion,
      idempotencyKey: envelope.idempotencyKey,
      ownership: envelope.ownership,
      reference: stored.reference,
      organizationId: stored.organizationId,
      projectId: stored.projectId,
      analysisRunId: stored.analysisRunId,
    },
  };
}

export function getEvidence(store: EvidenceStore, envelope: WorkerEnvelope): RouteResult {
  const { reference, organizationId, projectId, analysisRunId } = envelope.payload;
  if (typeof reference !== "string" || !HASH_REFERENCE.test(reference)
    || ![organizationId, projectId, analysisRunId]
      .every((value) => typeof value === "string" && IDENTIFIER.test(value))) {
    throw badRequest("GATEWAY_EVIDENCE_REQUEST_INVALID");
  }
  assertOwnershipMatches(envelope, {
    organizationId, projectId, runId: analysisRunId,
  }, "GATEWAY_EVIDENCE_OWNERSHIP_MISMATCH");
  const record = store.get({
    reference,
    organizationId: organizationId as string,
    projectId: projectId as string,
    analysisRunId: analysisRunId as string,
  });
  if (!record) throw notFound("GATEWAY_EVIDENCE_UNKNOWN");
  return { status: 200, body: workerResponse(envelope, { record }) };
}
