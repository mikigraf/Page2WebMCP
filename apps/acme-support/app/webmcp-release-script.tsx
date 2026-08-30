const CONTENT_HASH = /^[0-9a-f]{64}$/;
const SHA384_SRI = /^sha384-[A-Za-z0-9+/]+={0,2}$/;

export type WebMcpReleaseScriptConfig = Readonly<{
  src: string;
  integrity: string;
  contentHash: string;
  targetOrigin: string;
}>;

export function parseWebMcpReleaseScript(
  environment: Record<string, string | undefined>,
): WebMcpReleaseScriptConfig {
  const src = environment.PAGE2WEBMCP_ACME_RELEASE_URL;
  const contentHash = environment.PAGE2WEBMCP_ACME_RELEASE_CONTENT_HASH;
  const integrity = environment.PAGE2WEBMCP_ACME_RELEASE_INTEGRITY;
  const targetOrigin = environment.PAGE2WEBMCP_ACME_PUBLIC_ORIGIN;
  try {
    if (!src || !contentHash || !integrity || !targetOrigin
      || !CONTENT_HASH.test(contentHash) || !SHA384_SRI.test(integrity)) throw new Error();
    const integrityBytes = Buffer.from(integrity.slice("sha384-".length), "base64");
    if (integrityBytes.byteLength !== 48
      || integrityBytes.toString("base64") !== integrity.slice("sha384-".length)) throw new Error();
    const releaseUrl = new URL(src);
    const target = new URL(targetOrigin);
    if (releaseUrl.protocol !== "https:" || releaseUrl.username || releaseUrl.password
      || releaseUrl.search || releaseUrl.hash
      || releaseUrl.pathname !== `/api/releases/${contentHash}.js`
      || target.protocol !== "https:" || target.username || target.password || target.origin !== targetOrigin) {
      throw new Error();
    }
    return { src: releaseUrl.toString(), integrity, contentHash, targetOrigin };
  } catch {
    throw new Error("WEBMCP_RELEASE_CONFIG_INVALID");
  }
}

export function WebMcpReleaseScript() {
  let config: WebMcpReleaseScriptConfig;
  try {
    config = parseWebMcpReleaseScript(process.env);
  } catch {
    return <meta name="page2webmcp-status" content="release-unconfigured" />;
  }
  return <script
    type="module"
    src={config.src}
    integrity={config.integrity}
    crossOrigin="anonymous"
    data-page2webmcp-content-hash={config.contentHash}
    data-page2webmcp-target-origin={config.targetOrigin}
  />;
}
