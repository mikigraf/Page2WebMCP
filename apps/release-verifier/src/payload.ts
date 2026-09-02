/**
 * Boundary validation for the two verification payloads. Anything that does not match exactly is
 * refused; nothing is coerced or defaulted.
 */

const HASH = /^[0-9a-f]{64}$/;
const SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_URL_BYTES = 4_096;
const MAX_CODE_BYTES = 65_536;

export type InstallationPayload = Readonly<{
  pageUrl: string;
  artifactUrl: string;
  downloadUrl: string;
  localOnly: boolean;
  contentHash: string;
  integrity: string;
  manifest: unknown;
  targetOrigin: string;
  expectedTools: readonly string[];
  selfHostedUrl?: string;
}>;

export type CandidatePayload = Readonly<{
  code: string;
  contentHash: string;
  integrity: string;
  manifest: Readonly<{ releaseId: string }> & Record<string, unknown>;
  targetOrigin: string;
  expectedTools: readonly string[];
}>;

export function parseInstallationPayload(value: unknown): InstallationPayload | undefined {
  if (!record(value)) return undefined;
  const {
    pageUrl, artifactUrl, downloadUrl, localOnly, contentHash, integrity, manifest,
    targetOrigin, expectedTools, selfHostedUrl,
  } = value;
  if (!absoluteUrl(pageUrl) || !absoluteUrl(artifactUrl) || !absoluteUrl(downloadUrl)
    || typeof localOnly !== "boolean" || !hash(contentHash) || !sri(integrity)
    || !origin(targetOrigin) || !tools(expectedTools) || !record(manifest)
    || (selfHostedUrl !== undefined && !absoluteUrl(selfHostedUrl))) return undefined;
  if (new URL(pageUrl as string).origin !== targetOrigin) return undefined;
  return Object.freeze({
    pageUrl: pageUrl as string,
    artifactUrl: artifactUrl as string,
    downloadUrl: downloadUrl as string,
    localOnly,
    contentHash: contentHash as string,
    integrity: integrity as string,
    manifest,
    targetOrigin: targetOrigin as string,
    expectedTools: Object.freeze([...(expectedTools as string[])]),
    ...(typeof selfHostedUrl === "string" ? { selfHostedUrl } : {}),
  });
}

export function parseCandidatePayload(value: unknown): CandidatePayload | undefined {
  if (!record(value)) return undefined;
  const { code, contentHash, integrity, manifest, targetOrigin, expectedTools } = value;
  if (typeof code !== "string" || Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES
    || !hash(contentHash) || !sri(integrity) || !origin(targetOrigin) || !tools(expectedTools)
    || !record(manifest) || !hash(manifest.releaseId)) return undefined;
  return Object.freeze({
    code,
    contentHash: contentHash as string,
    integrity: integrity as string,
    manifest: manifest as CandidatePayload["manifest"],
    targetOrigin: targetOrigin as string,
    expectedTools: Object.freeze([...(expectedTools as string[])]),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function sri(value: unknown): value is string {
  return typeof value === "string" && SRI.test(value);
}

function origin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password && url.pathname === "/";
  } catch {
    return false;
  }
}

function absoluteUrl(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_URL_BYTES) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function tools(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every((name) => typeof name === "string" && TOOL_NAME.test(name))
    && new Set(value).size === value.length;
}
