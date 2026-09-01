import { createHash } from "node:crypto";

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort(compareCodePoints)
        .map((key) => [key, normalize(record[key])]));
    }
    return item;
  };
  const result = JSON.stringify(normalize(value));
  if (result === undefined) throw new Error("SOURCE_IDENTITY_INPUT_INVALID");
  return result;
}

/** Canonical identity shared by persisted source snapshots and claimed workers. */
export function computeSourceIdentityHash(
  sourceType: string,
  sourceUrl: string,
  sourceConfiguration: unknown,
): string {
  if (!sourceType || !sourceUrl) throw new Error("SOURCE_IDENTITY_INPUT_INVALID");
  const configuration = canonicalJson(sourceConfiguration);
  const material = `${Buffer.byteLength(sourceType)}:${sourceType}:${Buffer.byteLength(sourceUrl)}:${sourceUrl}:`
    + `${Buffer.byteLength(configuration)}:${configuration}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}
