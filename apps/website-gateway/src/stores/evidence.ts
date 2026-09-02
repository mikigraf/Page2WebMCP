import { HASH_REFERENCE, IDENTIFIER, MAX_CONTROL_BYTES } from "../constants.ts";
import { sha256Hex } from "../canonical.ts";

export type EvidenceRecord = Readonly<{
  organizationId: string;
  projectId: string;
  analysisRunId: string;
  source: "runtime";
  content: string;
  reference: string;
}>;

export type EvidenceStore = Readonly<{
  put(record: EvidenceRecord): EvidenceRecord;
  get(input: Readonly<{
    reference: string; organizationId: string; projectId: string; analysisRunId: string;
  }>): EvidenceRecord | undefined;
}>;

export class EvidenceRejected extends Error {
  constructor(reason: "EVIDENCE_RECORD_INVALID" | "EVIDENCE_INTEGRITY_FAILED" | "EVIDENCE_TOO_LARGE") {
    super(reason);
    this.name = "EvidenceRejected";
  }
}

/** Content-addressed and immutable: a stored record always hashes to its reference. */
export function createEvidenceStore(): EvidenceStore {
  const records = new Map<string, EvidenceRecord>();
  return {
    put(record) {
      if (!record || record.source !== "runtime" || typeof record.content !== "string"
        || !HASH_REFERENCE.test(record.reference ?? "")
        || ![record.organizationId, record.projectId, record.analysisRunId]
          .every((value) => typeof value === "string" && IDENTIFIER.test(value))) {
        throw new EvidenceRejected("EVIDENCE_RECORD_INVALID");
      }
      if (Buffer.byteLength(record.content, "utf8") > MAX_CONTROL_BYTES) {
        throw new EvidenceRejected("EVIDENCE_TOO_LARGE");
      }
      if (`urn:sha256:${sha256Hex(record.content)}` !== record.reference) {
        throw new EvidenceRejected("EVIDENCE_INTEGRITY_FAILED");
      }
      const key = `${record.organizationId}\0${record.projectId}\0${record.analysisRunId}\0${record.reference}`;
      const stored = records.get(key);
      if (stored) return stored;
      const immutable: EvidenceRecord = {
        organizationId: record.organizationId,
        projectId: record.projectId,
        analysisRunId: record.analysisRunId,
        source: "runtime",
        content: record.content,
        reference: record.reference,
      };
      records.set(key, immutable);
      return immutable;
    },
    get(input) {
      const key = `${input.organizationId}\0${input.projectId}\0${input.analysisRunId}\0${input.reference}`;
      const stored = records.get(key);
      if (!stored) return undefined;
      // Re-verify on read: a returned record is always one that still hashes true.
      return `urn:sha256:${sha256Hex(stored.content)}` === stored.reference ? stored : undefined;
    },
  };
}
