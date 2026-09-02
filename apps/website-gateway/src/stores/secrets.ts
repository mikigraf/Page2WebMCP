import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { MAX_SECRET_TTL_MS, SECRET_PURPOSES, SECRET_REFERENCE } from "../constants.ts";
import { sha256Hex } from "../canonical.ts";

export type SecretOwnership = Readonly<{ organizationId: string; projectId: string; runId: string }>;

export type SecretPutInput = Readonly<{
  value: string;
  purpose: string;
  expiresAt: string;
  valueDigest: string;
  kmsKeyId: string;
  ownership: SecretOwnership;
}>;

type SealedSecret = Readonly<{
  reference: string;
  purpose: string;
  expiresAtMs: number;
  expiresAt: string;
  valueDigest: string;
  kmsKeyId: string;
  ownership: SecretOwnership;
  wrappedKey: Buffer;
  wrapNonce: Buffer;
  wrapTag: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}>;

export type SecretStore = Readonly<{
  put(input: SecretPutInput, now: Date): Readonly<{ reference: string; expiresAt: string }>;
  read(reference: string, now: Date): string | undefined;
  describe(reference: string, now: Date): Readonly<{
    purpose: string; expiresAt: string; ownership: SecretOwnership;
  }> | undefined;
  revoke(reference: string): boolean;
  dispose(): void;
}>;

const liveStores = new Set<SecretStore>();

/**
 * Reads a secret this process sealed. Exposed for the in-process controls (the
 * CDP observer and the authentication portal) that need the plaintext; it is
 * never reachable over HTTP and never appears in any response body.
 */
export function readGatewaySecret(reference: string, now: Date): string | undefined {
  for (const store of liveStores) {
    const value = store.read(reference, now);
    if (value !== undefined) return value;
  }
  return undefined;
}

export type SecretPutFailure =
  | "SECRET_PURPOSE_UNSUPPORTED"
  | "SECRET_VALUE_DIGEST_MISMATCH"
  | "SECRET_KMS_KEY_MISMATCH"
  | "SECRET_TTL_INVALID"
  | "SECRET_VALUE_INVALID";

export class SecretRejected extends Error {
  constructor(reason: SecretPutFailure) { super(reason); this.name = "SecretRejected"; }
}

export function createSecretStore(kmsKeyId: string, rootKey: Buffer): SecretStore {
  const sealed = new Map<string, SealedSecret>();

  const unseal = (record: SealedSecret): string | undefined => {
    try {
      const unwrap = createDecipheriv("aes-256-gcm", rootKey, record.wrapNonce);
      unwrap.setAAD(Buffer.from(`${record.reference}\0${record.kmsKeyId}`, "utf8"));
      unwrap.setAuthTag(record.wrapTag);
      const dataKey = Buffer.concat([unwrap.update(record.wrappedKey), unwrap.final()]);
      const decipher = createDecipheriv("aes-256-gcm", dataKey, record.nonce);
      decipher.setAAD(Buffer.from(`${record.reference}\0${record.purpose}`, "utf8"));
      decipher.setAuthTag(record.tag);
      const plaintext = Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
      dataKey.fill(0);
      return sha256Hex(plaintext) === record.valueDigest ? plaintext : undefined;
    } catch { return undefined; }
  };

  const store: SecretStore = {
    put(input, now) {
      if (!SECRET_PURPOSES.has(input.purpose)) throw new SecretRejected("SECRET_PURPOSE_UNSUPPORTED");
      if (typeof input.value !== "string" || input.value.length === 0 || input.value.length > 4_096) {
        throw new SecretRejected("SECRET_VALUE_INVALID");
      }
      if (input.kmsKeyId !== kmsKeyId) throw new SecretRejected("SECRET_KMS_KEY_MISMATCH");
      if (sha256Hex(input.value) !== input.valueDigest) throw new SecretRejected("SECRET_VALUE_DIGEST_MISMATCH");
      const expiry = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry - now.getTime() > MAX_SECRET_TTL_MS) {
        throw new SecretRejected("SECRET_TTL_INVALID");
      }
      const reference = `secretref:${input.purpose}.${randomUUID()}`;
      const dataKey = randomBytes(32);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
      cipher.setAAD(Buffer.from(`${reference}\0${input.purpose}`, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
      const wrapNonce = randomBytes(12);
      const wrap = createCipheriv("aes-256-gcm", rootKey, wrapNonce);
      wrap.setAAD(Buffer.from(`${reference}\0${kmsKeyId}`, "utf8"));
      const wrappedKey = Buffer.concat([wrap.update(dataKey), wrap.final()]);
      dataKey.fill(0);
      sealed.set(reference, {
        reference,
        purpose: input.purpose,
        expiresAtMs: expiry,
        expiresAt: input.expiresAt,
        valueDigest: input.valueDigest,
        kmsKeyId,
        ownership: input.ownership,
        wrappedKey,
        wrapNonce,
        wrapTag: wrap.getAuthTag(),
        nonce,
        ciphertext,
        tag: cipher.getAuthTag(),
      });
      return { reference, expiresAt: input.expiresAt };
    },
    read(reference, now) {
      const record = sealed.get(reference);
      if (!record) return undefined;
      if (record.expiresAtMs <= now.getTime()) { store.revoke(reference); return undefined; }
      return unseal(record);
    },
    describe(reference, now) {
      const record = sealed.get(reference);
      if (!record || record.expiresAtMs <= now.getTime()) return undefined;
      return { purpose: record.purpose, expiresAt: record.expiresAt, ownership: record.ownership };
    },
    revoke(reference) {
      const record = sealed.get(reference);
      if (!record || !SECRET_REFERENCE.test(reference)) return false;
      record.ciphertext.fill(0);
      record.wrappedKey.fill(0);
      record.tag.fill(0);
      record.wrapTag.fill(0);
      sealed.delete(reference);
      return true;
    },
    dispose() {
      for (const reference of [...sealed.keys()]) store.revoke(reference);
      liveStores.delete(store);
    },
  };
  liveStores.add(store);
  return store;
}
