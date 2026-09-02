
const RELEASE_BUCKET = "page2webmcp-releases";
const HOSTED_SUPABASE_URL = "https://bimqgiedckdurqiywctl.supabase.co";
const LOCAL_SUPABASE_URL = "http://127.0.0.1:58321";

/** The pinned hosted Supabase Storage prefix that serves published releases. */
export const HOSTED_ARTIFACT_PREFIX = `${HOSTED_SUPABASE_URL}/storage/v1/object/public/${RELEASE_BUCKET}`;
/** The loopback equivalent, accepted only while the local stack is selected. */
export const LOCAL_ARTIFACT_PREFIX = `${LOCAL_SUPABASE_URL}/storage/v1/object/public/${RELEASE_BUCKET}`;

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const SHA384_SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;

export type HostedReleaseScriptConfig = Readonly<{
  src: string;
  integrity: string;
  contentHash: string;
  targetOrigin: string;
  localOnly: boolean;
}>;

function nonProductionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return /(?:^|\.)acme(?:\.|$)/.test(normalized)
    || normalized.endsWith(".example") || normalized.endsWith(".test") || normalized.endsWith(".invalid");
}

function assertTargetOrigin(value: string, localOnly: boolean): void {
  const target = new URL(value);
  if (target.origin !== value || target.username || target.password || target.search || target.hash) throw new Error();
  if (localOnly) {
    if (!LOOPBACK_ORIGIN.test(value)) throw new Error();
    return;
  }
  if (target.protocol !== "https:" || nonProductionHostname(target.hostname)) throw new Error();
}

/**
 * Parses the installation configuration for the hosted release artifact. The
 * script source must be exactly `<pinned storage prefix>/<content hash>.js`; the
 * control-plane artifact route and every other origin are rejected.
 */
export function parseHostedReleaseScript(
  environment: Record<string, string | undefined>,
): HostedReleaseScriptConfig {
  const src = environment.PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_URL;
  const contentHash = environment.PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_CONTENT_HASH;
  const integrity = environment.PAGE2WEBMCP_EXAMPLE_TARGET_RELEASE_INTEGRITY;
  const targetOrigin = environment.PAGE2WEBMCP_EXAMPLE_TARGET_PUBLIC_ORIGIN;
  const localOnly = environment.PAGE2WEBMCP_LOCAL_STACK === "true";
  try {
    if (!src || !contentHash || !integrity || !targetOrigin
      || !CONTENT_HASH.test(contentHash) || !SHA384_SRI.test(integrity)) throw new Error();
    const digest = integrity.slice("sha384-".length);
    const integrityBytes = Buffer.from(digest, "base64");
    if (integrityBytes.byteLength !== 48 || integrityBytes.toString("base64") !== digest) throw new Error();
    const expected = `${localOnly ? LOCAL_ARTIFACT_PREFIX : HOSTED_ARTIFACT_PREFIX}/${contentHash}.js`;
    if (src !== expected) throw new Error();
    const releaseUrl = new URL(src);
    if (releaseUrl.toString() !== expected || releaseUrl.username || releaseUrl.password
      || releaseUrl.search || releaseUrl.hash) throw new Error();
    assertTargetOrigin(targetOrigin, localOnly);
    return { src: expected, integrity, contentHash, targetOrigin, localOnly };
  } catch {
    throw new Error("HOSTED_RELEASE_CONFIG_INVALID");
  }
}

export function HostedReleaseScript() {
  let config: HostedReleaseScriptConfig;
  try {
    config = parseHostedReleaseScript(process.env);
  } catch {
    return <meta name="page2webmcp-status" content="release-unconfigured" />;
  }
  return <script
    async
    type="module"
    src={config.src}
    integrity={config.integrity}
    crossOrigin="anonymous"
    data-page2webmcp-content-hash={config.contentHash}
    data-page2webmcp-target-origin={config.targetOrigin}
  />;
}
